/**
 * EXR Custom Editor Provider
 *
 * Provides a custom editor for viewing and editing EXR files.
 * Delegates DCTL/shader/state management to ImageViewerCore.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { performance } from 'perf_hooks';
import { EXRWriter, PixelType, initOpenEXR, setOpenEXRWasmDirectory } from '../exr';
import { DctlRuntime } from '@dctl-workbench/core';
import { parseCompressionSetting } from './settings-helpers';
import { ImageViewerCore } from './ImageViewerCore';
import { BuiltinExrInputPlugin } from '../plugins/BuiltinExrInputPlugin';

// Debug logging - use shared logger module
import { initLog as sharedInitLog, writeLog } from '../shared/logger';

function initLog(extensionPath: string): void {
    sharedInitLog(extensionPath);
}

// Performance timing helper
class PerfTimer {
    private startTime: number;
    private lastLap: number;
    private readonly name: string;

    constructor(name: string) {
        this.name = name;
        this.startTime = performance.now();
        this.lastLap = this.startTime;
        writeLog(`[PERF] === ${name} START ===`);
    }

    lap(label: string): void {
        const now = performance.now();
        const lapTime = now - this.lastLap;
        const totalTime = now - this.startTime;
        writeLog(`[PERF] ${label}: ${lapTime.toFixed(2)}ms (total: ${totalTime.toFixed(2)}ms)`);
        this.lastLap = now;
    }

    end(): void {
        const totalTime = performance.now() - this.startTime;
        writeLog(`[PERF] === ${this.name} END === Total: ${totalTime.toFixed(2)}ms`);
    }
}

export class ExrEditorProvider implements vscode.CustomReadonlyEditorProvider<ExrDocument> {
    public static readonly viewType = 'dctlWorkbench.exrEditor';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<ExrDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly core: ImageViewerCore;
    private readonly plugin: BuiltinExrInputPlugin;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.core = new ImageViewerCore(context);
        this.plugin = new BuiltinExrInputPlugin(context.extensionPath);
    }

    /**
     * Get list of active EXR viewer panels with their document info
     */
    public getActivePanels(): { panel: vscode.WebviewPanel; documentPath: string; documentName: string }[] {
        return this.core.getActivePanels();
    }

    /**
     * Load a DCTL file into a specific panel
     */
    public async loadDctlIntoPanel(panel: vscode.WebviewPanel, dctlPath: string): Promise<void> {
        await this.core.loadDctlFile(panel, dctlPath);
    }

    /**
     * Open an EXR file and optionally load a DCTL file
     */
    public async openExrWithDctl(exrPath: string, dctlPath?: string): Promise<void> {
        // Open the EXR file using VSCode's default mechanism
        const uri = vscode.Uri.file(exrPath);
        await vscode.commands.executeCommand('vscode.openWith', uri, ExrEditorProvider.viewType);

        // If a DCTL path is provided, we need to wait for the panel to be ready
        // The DCTL will be loaded via the 'openDctlFiles' mechanism
        if (dctlPath) {
            // Store the pending DCTL path - will be loaded when panel becomes ready
            // For now, rely on auto-detection of open DCTL files
            writeLog(`EXR opened with DCTL: ${dctlPath}`);
        }
    }

    /**
     * Toggle RGC for a specific panel (for testing)
     */
    public async toggleRgc(panel: vscode.WebviewPanel, enabled: boolean, peakLuminance: number = 100): Promise<void> {
        await this.core.handleToggleRgc(panel, enabled, peakLuminance);
    }

    /**
     * Export to a specific path (for testing)
     */
    public async exportToPath(panel: vscode.WebviewPanel, outputPath: string): Promise<boolean> {
        const panelInfo = this.core.getPanelInfo(panel);
        if (!panelInfo) {
            throw new Error('No panel info found');
        }

        writeLog(`Export to path: ${outputPath}`);

        // If no DCTL is loaded, export source image directly
        const state = this.core.getDctlState(panel);
        if (!state || !state.filePath) {
            writeLog('No DCTL loaded, exporting source image');
            const sourceData = fs.readFileSync(panelInfo.documentPath);
            fs.writeFileSync(outputPath, sourceData);
            return true;
        }

        // Export with DCTL applied via core
        try {
            const { pixels, width, height } = await this.core.getExportedPixels(panel);
            await this.writeExrFile(outputPath, pixels, width, height);
            writeLog(`Export saved to: ${outputPath}`);
            return true;
        } catch (e) {
            writeLog(`Export failed: ${e}`);
            throw e;
        }
    }

    /**
     * Write EXR file from pixel data
     */
    private async writeExrFile(outputPath: string, pixels: Float32Array, width: number, height: number): Promise<void> {
        const runtime = new DctlRuntime();
        // Use extensionPath directly - DctlRuntime searches for wasm in subdirectories
        await runtime.init({ wasmPath: this.context.extensionPath });

        // Convert interleaved RGBA to interleaved RGB
        const rgbData = new Float32Array(width * height * 3);

        for (let i = 0; i < width * height; i++) {
            rgbData[i * 3] = pixels[i * 4];
            rgbData[i * 3 + 1] = pixels[i * 4 + 1];
            rgbData[i * 3 + 2] = pixels[i * 4 + 2];
        }

        await runtime.writeExr(outputPath, {
            width,
            height,
            channels: 3,
            data: rgbData,
        });
    }

    /**
     * Export the current image with DCTL applied as EXR
     */
    public async exportAsExr(panel: vscode.WebviewPanel): Promise<void> {
        const panelInfo = this.core.getPanelInfo(panel);
        if (!panelInfo) {
            throw new Error('No panel info found');
        }

        writeLog('Starting EXR export...');

        // Get rendered pixels from core (builds shader, sends to webview, gets buffer)
        const pixelData = await this.core.getExportedPixels(panel);
        writeLog(`Received pixel data: ${pixelData.width}x${pixelData.height}`);

        // Show save dialog
        const defaultUri = vscode.Uri.file(
            panelInfo.documentPath.replace(/\.exr$/i, '_dctl_export.exr')
        );

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                'EXR Files': ['exr'],
            },
            title: 'Export DCTL-processed image as EXR',
        });

        if (!saveUri) {
            writeLog('Export cancelled by user');
            return;
        }

        writeLog(`Save path selected: ${saveUri.fsPath}`);

        // Write EXR file
        const possibleWasmDirs = [
            path.join(this.context.extensionPath, 'wasm'),
            path.join(this.context.extensionPath, 'out', 'wasm'),
        ];
        let wasmDir = possibleWasmDirs[0];
        for (const dir of possibleWasmDirs) {
            const testPath = path.join(dir, 'openexr.js');
            if (fs.existsSync(testPath)) {
                wasmDir = dir;
                break;
            }
        }

        setOpenEXRWasmDirectory(wasmDir);
        const exrModule = await initOpenEXR(true);
        if (!exrModule) {
            throw new Error('Failed to initialize OpenEXR WASM module');
        }

        // ACES2065-1 chromaticities (AP0)
        const ACES_CHROMATICITIES = {
            redX: 0.7347, redY: 0.2653,
            greenX: 0.0, greenY: 1.0,
            blueX: 0.0001, blueY: -0.077,
            whiteX: 0.32168, whiteY: 0.33767,
        };

        const writer = new EXRWriter(exrModule);
        try {
            const exrData = writer.write(pixelData.pixels, pixelData.width, pixelData.height, 3, {
                compression: parseCompressionSetting(
                    vscode.workspace.getConfiguration('dctlWorkbench').get('exr_viewer.defaultExportCompression', 'PIZ')
                ),
                pixelType: PixelType.HALF,
                chromaticities: ACES_CHROMATICITIES,
                adoptedNeutral: true,
            });

            fs.writeFileSync(saveUri.fsPath, exrData);
            writeLog(`EXR exported to: ${saveUri.fsPath}`);
            vscode.window.showInformationMessage(`Exported to ${path.basename(saveUri.fsPath)}`);
        } finally {
            writer.dispose();
        }
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<ExrDocument> {
        return new ExrDocument(uri);
    }

    async resolveCustomEditor(
        document: ExrDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        initLog(this.context.extensionPath);
        writeLog(`Opening EXR file: ${document.uri.fsPath}`);

        this.core.attach(webviewPanel, document.uri.fsPath, {
            onReady: async (panel) => {
                await this.loadImage(document, panel);
            },
            onExport: async (panel) => {
                await this.exportAsExr(panel);
            },
        });
    }

    private async loadImage(document: ExrDocument, panel: vscode.WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const perf = new PerfTimer('loadImage');

        // Show loading indicator
        webview.postMessage({ type: 'startLoading' });

        try {
            // Read file data
            let fileData: Uint8Array;
            if (document.uri.scheme === 'file') {
                fileData = fs.readFileSync(document.uri.fsPath);
            } else {
                fileData = await vscode.workspace.fs.readFile(document.uri);
            }
            perf.lap('Read file from disk');

            // Decode via input plugin
            await this.plugin.load(new Uint8Array(fileData));
            const decoded = await this.plugin.getImageData();
            const metadata = this.plugin.getMetadata();
            perf.lap(`Decode image (${decoded.width}x${decoded.height})`);

            // Find WASM dir for OCIO
            const possibleWasmDirs = [
                path.join(this.context.extensionPath, 'out', 'wasm'),
                path.join(this.context.extensionPath, 'wasm'),
            ];
            let wasmDir = possibleWasmDirs[0];
            for (const dir of possibleWasmDirs) {
                if (fs.existsSync(path.join(dir, 'ocio.js')) || fs.existsSync(path.join(dir, 'openexr.js'))) {
                    wasmDir = dir;
                    break;
                }
            }

            // Delegate OCIO init, shader build, and webview postMessage to core
            await this.core.loadImageData(panel, {
                width: decoded.width,
                height: decoded.height,
                channels: decoded.channels,
                buffer: decoded.pixels.buffer as ArrayBuffer,
                byteOffset: decoded.pixels.byteOffset,
                byteLength: decoded.pixels.byteLength,
                colorSpace: decoded.colorSpace,
                colorSpaceDetected: !!metadata.chromaticities,
                compression: `${decoded.bitsPerSample}-bit float`,
                bitDepth: decoded.pixelFormat === 'rgba32float' ? 'FLOAT' : 'HALF',
            }, wasmDir);
            perf.lap('OCIO + shader + postMessage');
            perf.end();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            perf.lap(`Error: ${message}`);
            perf.end();
            webview.postMessage({
                type: 'error',
                message: `Failed to load EXR: ${message}`,
            });
        }
    }

}

class ExrDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}

    dispose(): void {
        // Cleanup if needed
    }
}
