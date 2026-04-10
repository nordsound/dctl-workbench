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
import { buildDctlExportShader } from '../shader';
import { parseCompressionSetting } from './settings-helpers';
import { ImageViewerCore } from './ImageViewerCore';
import { BuiltinExrInputPlugin } from '../plugins/BuiltinExrInputPlugin';

// Debug logging - use shared logger module
import { initLog as sharedInitLog, writeLog } from '../shared/logger';

function initLog(extensionPath: string): void {
    sharedInitLog(extensionPath);
}

// Re-export writeLog for backwards compatibility
export { writeLog };

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
        const state = this.core.getDctlState(panel);
        const panelInfo = this.core.getPanelInfo(panel);

        if (!panelInfo) {
            throw new Error('No panel info found');
        }

        writeLog(`Export to path: ${outputPath}`);

        // If no DCTL is loaded, export source image directly
        if (!state || !state.filePath) {
            writeLog('No DCTL loaded, exporting source image');
            // Read and copy source file
            const sourceData = fs.readFileSync(panelInfo.documentPath);
            fs.writeFileSync(outputPath, sourceData);
            return true;
        }

        // Export with DCTL applied (direct export without save dialog)
        try {
            const dctlShaderInfo = this.core.getDctlShaderInfo(panel);
            if (!dctlShaderInfo) {
                throw new Error('No DCTL shader info available');
            }

            const exportResult = await buildDctlExportShader(
                this.context.extensionPath,
                dctlShaderInfo,
                {
                    paramValues: state.paramValues,
                    imageWidth: state.imageWidth,
                    imageHeight: state.imageHeight,
                    applyACES2GamutCompression: state.applyRgc,
                    peakLuminance: state.rgcPeakLuminance,
                }
            );

            if (!exportResult.success) {
                throw new Error(`Failed to build export shader: ${exportResult.error}`);
            }

            // Request export buffer from webview
            const requestId = `export-${Date.now()}`;
            const pendingExports = this.core.getPendingExports();

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    pendingExports.delete(requestId);
                    reject(new Error('Export timeout'));
                }, 30000);

                pendingExports.set(requestId, {
                    resolve: async (data) => {
                        clearTimeout(timeout);
                        pendingExports.delete(requestId);

                        try {
                            // Write EXR file
                            const { pixels, width, height } = data;
                            await this.writeExrFile(outputPath, pixels, width, height);
                            writeLog(`Export saved to: ${outputPath}`);
                            resolve(true);
                        } catch (e) {
                            reject(e);
                        }
                    },
                    reject: (error) => {
                        clearTimeout(timeout);
                        pendingExports.delete(requestId);
                        reject(error);
                    },
                });

                // Send export shader and request buffer
                panel.webview.postMessage({
                    type: 'buildExportShader',
                    wgslShaderInfo: {
                        wgslCode: exportResult.wgslCode,
                        textures: [],
                        textures3D: [],
                        bindings: exportResult.bindings,
                        rgcTextures: exportResult.rgcTextures,
                        rgcTextures3D: exportResult.rgcTextures3D,
                    },
                    requestBuffer: true,
                    requestId,
                });
            });

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
        const state = this.core.getDctlState(panel);
        const panelInfo = this.core.getPanelInfo(panel);

        if (!panelInfo) {
            throw new Error('No panel info found');
        }

        if (!state || !state.filePath) {
            throw new Error('No DCTL file loaded');
        }

        const dctlShaderInfo = this.core.getDctlShaderInfo(panel);
        if (!dctlShaderInfo) {
            throw new Error('No DCTL shader info available');
        }

        writeLog(`Starting EXR export... RGC=${state.applyRgc ? 'enabled' : 'disabled'}, peakLuminance=${state.rgcPeakLuminance ?? 100}`);

        // Build export shader (DCTL only, no OCIO display transform)
        // Pass RGC settings from viewer state
        const exportResult = await buildDctlExportShader(
            this.context.extensionPath,
            dctlShaderInfo,
            {
                paramValues: state.paramValues,
                imageWidth: state.imageWidth,
                imageHeight: state.imageHeight,
                applyACES2GamutCompression: state.applyRgc,
                peakLuminance: state.rgcPeakLuminance,
            }
        );

        if (!exportResult.success) {
            throw new Error(`Failed to build export shader: ${exportResult.error}`);
        }

        writeLog('Export shader built successfully');

        // Send export shader to webview with RGC textures if available
        // Note: WebGPU renderer expects rgcTextures/rgcTextures3D fields for RGC LUT textures
        panel.webview.postMessage({
            type: 'buildExportShader',
            wgslShaderInfo: {
                wgslCode: exportResult.wgslCode,
                textures: [],
                textures3D: [],
                bindings: exportResult.bindings,
                rgcTextures: exportResult.rgcTextures,
                rgcTextures3D: exportResult.rgcTextures3D,
            },
        });

        // Wait for shader to be built
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Export shader build timeout'));
            }, 10000);

            const handler = (message: { type: string; success?: boolean; error?: string }) => {
                if (message.type === 'exportShaderBuilt') {
                    clearTimeout(timeout);
                    if (message.success) {
                        resolve();
                    } else {
                        reject(new Error(message.error || 'Unknown error'));
                    }
                }
            };

            // Store handler for later cleanup (not ideal but works for now)
            const messageHandler = panel.webview.onDidReceiveMessage(handler);
            this.context.subscriptions.push(messageHandler);
        });

        writeLog('Export shader built in webview, requesting buffer...');

        // Request pixel data
        const requestId = `export-${Date.now()}`;
        const pendingExports = this.core.getPendingExports();
        const pixelData = await new Promise<{ pixels: Float32Array; width: number; height: number }>((resolve, reject) => {
            pendingExports.set(requestId, { resolve, reject });

            setTimeout(() => {
                if (pendingExports.has(requestId)) {
                    pendingExports.delete(requestId);
                    reject(new Error('Export timeout'));
                }
            }, 30000);

            panel.webview.postMessage({
                type: 'exportToBuffer',
                requestId,
            });
        });

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
        // Try multiple possible paths for WASM files
        const possibleWasmDirs = [
            path.join(this.context.extensionPath, 'wasm'),           // Development
            path.join(this.context.extensionPath, 'out', 'wasm'),    // Compiled output
        ];
        let wasmDir = possibleWasmDirs[0];
        for (const dir of possibleWasmDirs) {
            const testPath = path.join(dir, 'openexr.js');
            if (fs.existsSync(testPath)) {
                wasmDir = dir;
                break;
            }
        }
        writeLog(`WASM directory: ${wasmDir}`);
        setOpenEXRWasmDirectory(wasmDir);
        writeLog('Initializing OpenEXR WASM module (fresh instance for writing)...');

        let exrModule;
        try {
            // Force a fresh module load for writing to avoid HEAP view issues
            exrModule = await initOpenEXR(true);
            writeLog('OpenEXR WASM module initialized successfully (fresh instance)');
        } catch (initError) {
            const errMsg = initError instanceof Error ? initError.message : String(initError);
            const errStack = initError instanceof Error ? initError.stack : '';
            writeLog(`OpenEXR init error: ${errMsg}\nStack: ${errStack}`);
            throw new Error(`Failed to initialize OpenEXR: ${errMsg}`);
        }

        // Check WASM module (HEAPF32/HEAPU8 may not be exposed, writer.ts has fallback)
        if (!exrModule) {
            throw new Error('Failed to initialize OpenEXR WASM module');
        }
        writeLog(`WASM module: HEAPF32=${typeof exrModule.HEAPF32}, HEAPU8=${typeof exrModule.HEAPU8}, setValue=${typeof exrModule.setValue}`);
        if (!exrModule.HEAPF32 || !exrModule.HEAPU8) {
            writeLog('HEAP views not available, will use setValue/getValue fallback (slower)');
        }

        // Validate pixel data
        if (!pixelData.pixels) {
            throw new Error('Pixel data is null or undefined');
        }
        if (!(pixelData.pixels instanceof Float32Array)) {
            throw new Error(`Pixel data is not Float32Array: ${Object.prototype.toString.call(pixelData.pixels)}`);
        }
        const expectedSize = pixelData.width * pixelData.height * 3;
        if (pixelData.pixels.length !== expectedSize) {
            throw new Error(`Pixel data size mismatch: expected ${expectedSize}, got ${pixelData.pixels.length}`);
        }
        writeLog(`Pixel data validated: ${pixelData.pixels.length} floats, ${pixelData.width}x${pixelData.height}`);

        // ACES2065-1 chromaticities (AP0)
        const ACES_CHROMATICITIES = {
            redX: 0.7347, redY: 0.2653,
            greenX: 0.0, greenY: 1.0,
            blueX: 0.0001, blueY: -0.077,
            whiteX: 0.32168, whiteY: 0.33767,
        };

        writeLog('Creating EXRWriter...');
        const writer = new EXRWriter(exrModule);
        writeLog('Calling writer.write()...');
        let exrData: Uint8Array;
        try {
            exrData = writer.write(pixelData.pixels, pixelData.width, pixelData.height, 3, {
                compression: parseCompressionSetting(
                    vscode.workspace.getConfiguration('dctlWorkbench').get('exr_viewer.defaultExportCompression', 'PIZ')
                ),
                pixelType: PixelType.HALF,
                chromaticities: ACES_CHROMATICITIES,
                adoptedNeutral: true,
            });
            writeLog(`writer.write() succeeded, exrData.length=${exrData.length}`);
        } catch (writeError) {
            const errMsg = writeError instanceof Error ? writeError.message : String(writeError);
            const errStack = writeError instanceof Error ? writeError.stack : '';
            writeLog(`EXR write error: ${errMsg}\nStack: ${errStack}`);
            throw new Error(`Failed to write EXR: ${errMsg}`);
        } finally {
            writer.dispose();
        }

        // Write to file
        fs.writeFileSync(saveUri.fsPath, exrData);

        writeLog(`EXR exported to: ${saveUri.fsPath}`);
        vscode.window.showInformationMessage(`Exported to ${path.basename(saveUri.fsPath)}`);
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
        // Delegate panel setup, state init, and lifecycle management to core
        this.core.attach(webviewPanel, document.uri.fsPath);

        // Initialize log file for new session
        initLog(this.context.extensionPath);
        writeLog(`Opening EXR file: ${document.uri.fsPath}`);

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'ready':
                    writeLog('Webview ready');
                    await this.loadImage(document, webviewPanel);
                    // Send initial list of open DCTL files
                    this.core.sendOpenDctlFiles(webviewPanel);
                    break;
                case 'setDisplayTransform':
                    writeLog(`Display transform: ${message.source} -> ${message.display} / ${message.view}`);
                    await this.core.updateDisplayTransform(
                        webviewPanel,
                        message.source,
                        message.display,
                        message.view
                    );
                    break;
                case 'selectDctlFile':
                    await this.core.handleSelectDctlFile(webviewPanel);
                    break;
                case 'loadDctlFromPath':
                    if (message.path) {
                        await this.core.loadDctlFile(webviewPanel, message.path);
                    }
                    break;
                case 'toggleDctl':
                    await this.core.handleToggleDctl(webviewPanel, message.enabled);
                    break;
                case 'toggleRgc':
                    await this.core.handleToggleRgc(webviewPanel, message.enabled, message.peakLuminance);
                    break;
                case 'updateRgcSettings':
                    await this.core.handleUpdateRgcSettings(webviewPanel, message.peakLuminance);
                    break;
                case 'changeDctlColorSpace':
                    await this.core.handleChangeDctlColorSpace(webviewPanel, message.colorSpace);
                    break;
                case 'updateDctlParam':
                    await this.core.handleUpdateDctlParam(webviewPanel, message.name, message.value);
                    break;
                case 'log':
                    writeLog(`[WEBVIEW] ${message.message}`);
                    break;
                case 'error':
                    writeLog(`[ERROR] ${message.message}`);
                    vscode.window.showErrorMessage(`EXR Viewer: ${message.message}`);
                    break;
                case 'exportBufferReady':
                    this.core.handleExportBufferReady(message);
                    break;
                case 'exportExr':
                    writeLog('Export EXR requested from webview');
                    this.exportAsExr(webviewPanel).catch((error) => {
                        const errMsg = error instanceof Error ? error.message : String(error);
                        vscode.window.showErrorMessage(`Export failed: ${errMsg}`);
                    });
                    break;
                case 'shaderBuildResult':
                    // Webview reports whether DCTL compute pipeline was built successfully
                    this.core.handleShaderBuildResult(webviewPanel, message.hasDctlSupport, message.error);
                    break;
                case 'rgcPixelVerification':
                    // Webview reports RGC pixel verification result
                    this.core.handleRgcPixelVerification(message.isBlack, message.pixels, message.hasFullRgc);
                    break;
            }
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
