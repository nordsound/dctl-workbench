/**
 * EXR Custom Editor Provider
 *
 * Provides a custom editor for viewing and editing EXR files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { performance } from 'perf_hooks';
import { EXRReader, EXRWriter, Compression, PixelType, identifyColorSpace, initOpenEXR, setOpenEXRWasmDirectory, isOpenEXRInitialized } from '../exr';
import { initOCIO, OCIOProcessor, setWasmDirectory, DctlRuntime } from '@dctl-workbench/core';
import { buildWgslShader, buildIntegratedShader, buildDctlExportShader } from '../shader';
import { preprocessDctlSource } from '../dctl/preprocessor';
import { createDctlInfo, type DctlParam, type DctlColorValue, type DctlShaderInfo } from '../dctl/types';

// DCTL state for each webview
interface DctlState {
    filePath: string | null;
    enabled: boolean;
    workingColorSpace: 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB';
    params: DctlParam[];
    paramValues: Record<string, number | boolean | DctlColorValue>;
    fileWatcher: vscode.FileSystemWatcher | null;
    includedFiles: string[];
    // Image dimensions for DCTL built-in parameters
    imageWidth: number;
    imageHeight: number;
    // Uniform buffer mode for fast parameter updates (no shader recompilation)
    useUniformBuffer: boolean;
    // Actual DCTL support in webview (set by shaderBuildResult message)
    // When false, fall back to slow path even if useUniformBuffer is true
    hasDctlSupport: boolean;
    // ACES 2.0 Reference Gamut Compression
    applyRgc: boolean;
    rgcPeakLuminance: number;
}

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

    // DCTL state per webview panel
    private readonly dctlStates = new Map<vscode.WebviewPanel, DctlState>();

    // Track panel info for external access (document path, panel reference)
    private readonly panelInfos = new Map<vscode.WebviewPanel, { documentPath: string; lastActiveTime: number }>();

    // Current OCIO state for shader rebuilding
    private currentOcioState: {
        source: string;
        display: string;
        view: string;
    } | null = null;

    // Track editor change subscriptions per panel
    private readonly editorChangeSubscriptions = new Map<vscode.WebviewPanel, vscode.Disposable[]>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Get list of active EXR viewer panels with their document info
     */
    public getActivePanels(): { panel: vscode.WebviewPanel; documentPath: string; documentName: string }[] {
        const panels: { panel: vscode.WebviewPanel; documentPath: string; documentName: string; lastActiveTime: number }[] = [];

        for (const [panel, info] of this.panelInfos) {
            panels.push({
                panel,
                documentPath: info.documentPath,
                documentName: path.basename(info.documentPath),
                lastActiveTime: info.lastActiveTime,
            });
        }

        // Sort by last active time (most recent first)
        panels.sort((a, b) => b.lastActiveTime - a.lastActiveTime);

        return panels.map(({ panel, documentPath, documentName }) => ({
            panel,
            documentPath,
            documentName,
        }));
    }

    /**
     * Load a DCTL file into a specific panel
     */
    public async loadDctlIntoPanel(panel: vscode.WebviewPanel, dctlPath: string): Promise<void> {
        await this.loadDctlFile(panel, dctlPath);
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
        await this.handleToggleRgc(panel, enabled, peakLuminance);
    }

    /**
     * Export to a specific path (for testing)
     */
    public async exportToPath(panel: vscode.WebviewPanel, outputPath: string): Promise<boolean> {
        const state = this.dctlStates.get(panel);
        const panelInfo = this.panelInfos.get(panel);

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
            const dctlShaderInfo = this.dctlShaderInfos.get(panel);
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

            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingExports.delete(requestId);
                    reject(new Error('Export timeout'));
                }, 30000);

                this.pendingExports.set(requestId, {
                    resolve: async (data) => {
                        clearTimeout(timeout);
                        this.pendingExports.delete(requestId);

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
                        this.pendingExports.delete(requestId);
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

    // Pending export requests: map of requestId -> resolve/reject functions
    private pendingExports = new Map<string, {
        resolve: (data: { pixels: Float32Array; width: number; height: number }) => void;
        reject: (error: Error) => void;
    }>();

    // Store transpiled DCTL info for export
    private dctlShaderInfos = new Map<vscode.WebviewPanel, DctlShaderInfo>();

    /**
     * Export the current image with DCTL applied as EXR
     */
    public async exportAsExr(panel: vscode.WebviewPanel): Promise<void> {
        const state = this.dctlStates.get(panel);
        const panelInfo = this.panelInfos.get(panel);

        if (!panelInfo) {
            throw new Error('No panel info found');
        }

        if (!state || !state.filePath) {
            throw new Error('No DCTL file loaded');
        }

        const dctlShaderInfo = this.dctlShaderInfos.get(panel);
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
        const pixelData = await new Promise<{ pixels: Float32Array; width: number; height: number }>((resolve, reject) => {
            this.pendingExports.set(requestId, { resolve, reject });

            setTimeout(() => {
                if (this.pendingExports.has(requestId)) {
                    this.pendingExports.delete(requestId);
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
                compression: Compression.PIZ,
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

    /**
     * Get list of currently open DCTL files in VSCode
     */
    private getOpenDctlFiles(): { path: string; name: string }[] {
        const dctlFiles: { path: string; name: string }[] = [];

        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.fileName.endsWith('.dctl')) {
                dctlFiles.push({
                    path: editor.document.fileName,
                    name: path.basename(editor.document.fileName),
                });
            }
        }

        // Also check all open tabs (not just visible)
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    const uri = tab.input.uri;
                    if (uri.fsPath.endsWith('.dctl')) {
                        // Avoid duplicates
                        if (!dctlFiles.some(f => f.path === uri.fsPath)) {
                            dctlFiles.push({
                                path: uri.fsPath,
                                name: path.basename(uri.fsPath),
                            });
                        }
                    }
                }
            }
        }

        return dctlFiles;
    }

    /**
     * Send open DCTL files list to webview
     */
    private sendOpenDctlFiles(panel: vscode.WebviewPanel): void {
        const openDctlFiles = this.getOpenDctlFiles();
        panel.webview.postMessage({
            type: 'openDctlFiles',
            files: openDctlFiles,
        });
        writeLog(`Sent ${openDctlFiles.length} open DCTL files to webview`);
    }

    private createDefaultDctlState(): DctlState {
        return {
            filePath: null,
            enabled: false,
            workingColorSpace: 'ACEScct',
            params: [],
            paramValues: {},
            fileWatcher: null,
            includedFiles: [],
            imageWidth: 1920,
            imageHeight: 1080,
            useUniformBuffer: true,  // Enable uniform buffer for DCTL parameters
            hasDctlSupport: false,  // Set to true when webview confirms DCTL compute pipeline is built
            applyRgc: false,  // ACES 2.0 Reference Gamut Compression (OCIO-based)
            rgcPeakLuminance: 100,  // Peak luminance in nits (100 for SDR)
        };
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
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'out'),
                vscode.Uri.joinPath(this.context.extensionUri, 'wasm'),
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Initialize log file for new session
        initLog(this.context.extensionPath);
        writeLog(`Opening EXR file: ${document.uri.fsPath}`);

        // Initialize DCTL state for this panel
        const dctlState = this.createDefaultDctlState();
        this.dctlStates.set(webviewPanel, dctlState);

        // Track panel info for external access
        this.panelInfos.set(webviewPanel, {
            documentPath: document.uri.fsPath,
            lastActiveTime: Date.now(),
        });

        // Update lastActiveTime when panel becomes visible/active
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                const info = this.panelInfos.get(webviewPanel);
                if (info) {
                    info.lastActiveTime = Date.now();
                }
            }
        });

        // Listen for editor/tab changes to update open DCTL files list
        const subscriptions: vscode.Disposable[] = [];

        subscriptions.push(
            vscode.window.onDidChangeVisibleTextEditors(() => {
                this.sendOpenDctlFiles(webviewPanel);
            })
        );

        subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(() => {
                this.sendOpenDctlFiles(webviewPanel);
            })
        );

        this.editorChangeSubscriptions.set(webviewPanel, subscriptions);

        // Cleanup on panel dispose
        webviewPanel.onDidDispose(() => {
            const state = this.dctlStates.get(webviewPanel);
            if (state?.fileWatcher) {
                state.fileWatcher.dispose();
            }
            this.dctlStates.delete(webviewPanel);

            // Cleanup panel info
            this.panelInfos.delete(webviewPanel);

            // Cleanup DCTL shader info
            this.dctlShaderInfos.delete(webviewPanel);

            // Cleanup editor change subscriptions
            const subs = this.editorChangeSubscriptions.get(webviewPanel);
            if (subs) {
                subs.forEach(s => s.dispose());
                this.editorChangeSubscriptions.delete(webviewPanel);
            }
        });

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'ready':
                    writeLog('Webview ready');
                    await this.loadImage(document, webviewPanel);
                    // Send initial list of open DCTL files
                    this.sendOpenDctlFiles(webviewPanel);
                    break;
                case 'setDisplayTransform':
                    writeLog(`Display transform: ${message.source} -> ${message.display} / ${message.view}`);
                    await this.updateDisplayTransform(
                        document,
                        webviewPanel,
                        message.source,
                        message.display,
                        message.view
                    );
                    break;
                case 'selectDctlFile':
                    await this.handleSelectDctlFile(webviewPanel);
                    break;
                case 'loadDctlFromPath':
                    if (message.path) {
                        await this.loadDctlFile(webviewPanel, message.path);
                    }
                    break;
                case 'toggleDctl':
                    await this.handleToggleDctl(webviewPanel, message.enabled);
                    break;
                case 'toggleRgc':
                    await this.handleToggleRgc(webviewPanel, message.enabled, message.peakLuminance);
                    break;
                case 'updateRgcSettings':
                    await this.handleUpdateRgcSettings(webviewPanel, message.peakLuminance);
                    break;
                case 'changeDctlColorSpace':
                    await this.handleChangeDctlColorSpace(webviewPanel, message.colorSpace);
                    break;
                case 'updateDctlParam':
                    await this.handleUpdateDctlParam(webviewPanel, message.name, message.value);
                    break;
                case 'log':
                    writeLog(`[WEBVIEW] ${message.message}`);
                    break;
                case 'error':
                    writeLog(`[ERROR] ${message.message}`);
                    vscode.window.showErrorMessage(`EXR Viewer: ${message.message}`);
                    break;
                case 'exportBufferReady':
                    this.handleExportBufferReady(message);
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
                    this.handleShaderBuildResult(webviewPanel, message.hasDctlSupport, message.error);
                    break;
                case 'rgcPixelVerification':
                    // Webview reports RGC pixel verification result
                    this.handleRgcPixelVerification(message.isBlack, message.pixels, message.hasFullRgc);
                    break;
            }
        });
    }

    /**
     * Handle export buffer ready response from webview
     */
    private handleExportBufferReady(message: {
        requestId: string;
        success: boolean;
        width?: number;
        height?: number;
        buffer?: ArrayBuffer;
        error?: string;
    }): void {
        const pending = this.pendingExports.get(message.requestId);
        if (!pending) {
            writeLog(`Export response for unknown request: ${message.requestId}`);
            return;
        }

        this.pendingExports.delete(message.requestId);

        if (message.success && message.buffer && message.width && message.height) {
            // Validate buffer type
            const bufferType = Object.prototype.toString.call(message.buffer);
            writeLog(`Export buffer received: type=${bufferType}, width=${message.width}, height=${message.height}`);

            let pixels: Float32Array;
            if (message.buffer instanceof ArrayBuffer) {
                pixels = new Float32Array(message.buffer);
            } else if (ArrayBuffer.isView(message.buffer)) {
                // If it's a typed array view, use its underlying buffer
                const view = message.buffer as unknown as ArrayBufferView;
                pixels = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
            } else {
                // Try to convert from object with numeric keys (serialized array)
                const bufferObj = message.buffer as unknown;
                if (typeof bufferObj === 'object' && bufferObj !== null) {
                    const values = Object.values(bufferObj as Record<string, number>);
                    writeLog(`Converting buffer object with ${values.length} values to Float32Array`);
                    pixels = new Float32Array(values);
                } else {
                    pending.reject(new Error(`Unexpected buffer type: ${bufferType}`));
                    return;
                }
            }

            writeLog(`Created Float32Array with ${pixels.length} elements`);
            pending.resolve({
                pixels,
                width: message.width,
                height: message.height,
            });
        } else {
            pending.reject(new Error(message.error || 'Export failed'));
        }
    }

    /**
     * Handle shader build result message from webview
     * This tells us whether the DCTL compute pipeline was built successfully
     */
    private handleShaderBuildResult(
        panel: vscode.WebviewPanel,
        hasDctlSupport: boolean,
        error?: string
    ): void {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        state.hasDctlSupport = hasDctlSupport;
        writeLog(`Shader build result: hasDctlSupport=${hasDctlSupport}${error ? `, error=${error}` : ''}`);
    }

    /**
     * Handle RGC pixel verification result from webview
     * This provides automated verification of RGC rendering output
     */
    private handleRgcPixelVerification(
        isBlack: boolean,
        pixels: number[],
        hasFullRgc: boolean
    ): void {
        const pixelStr = pixels.slice(0, 8).map(p => p.toFixed(4)).join(', ');
        const status = isBlack ? 'BLACK (FAIL)' : 'OK (has content)';

        writeLog(`[RGC VERIFICATION] Status: ${status}`);
        writeLog(`[RGC VERIFICATION] hasFullRgc=${hasFullRgc}, isBlack=${isBlack}`);
        writeLog(`[RGC VERIFICATION] Sample pixels: [${pixelStr}...]`);

        // Show warning if output is black
        if (isBlack) {
            vscode.window.showWarningMessage(
                'RGC rendering verification: Output appears to be BLACK. Check debug.log for details.'
            );
        }
    }

    private async loadImage(document: ExrDocument, panel: vscode.WebviewPanel): Promise<void> {
        const webview = panel.webview;
        const perf = new PerfTimer('loadImage');

        // Show loading indicator
        webview.postMessage({ type: 'startLoading' });

        try {
            // Read EXR file - use fs.readFileSync for local files (much faster than vscode.workspace.fs)
            let fileData: Uint8Array;
            if (document.uri.scheme === 'file') {
                fileData = fs.readFileSync(document.uri.fsPath);
            } else {
                fileData = await vscode.workspace.fs.readFile(document.uri);
            }
            perf.lap('Read EXR file from disk');

            // Initialize OpenEXR WASM (cached for subsequent loads)
            // Use extensionPath for reliable path resolution (works both in dev and bundled .vsix)
            const possibleWasmDirs = [
                path.join(this.context.extensionPath, 'out', 'wasm'),    // Compiled output
                path.join(this.context.extensionPath, 'wasm'),           // Development
            ];
            let wasmDir = possibleWasmDirs[0];
            for (const dir of possibleWasmDirs) {
                const testPath = path.join(dir, 'openexr.js');
                if (fs.existsSync(testPath)) {
                    wasmDir = dir;
                    break;
                }
            }
            const wasCached = isOpenEXRInitialized();
            setOpenEXRWasmDirectory(wasmDir);
            const exrModule = await initOpenEXR();
            perf.lap(wasCached ? 'OpenEXR WASM (cached)' : 'Initialize OpenEXR WASM');

            const reader = new EXRReader(exrModule);
            const imageData = reader.read(new Uint8Array(fileData));
            reader.dispose();
            perf.lap(`Parse EXR (${imageData.width}x${imageData.height})`);

            // Store image dimensions in DCTL state for shader built-in parameters
            const dctlState = this.dctlStates.get(panel);
            if (dctlState) {
                dctlState.imageWidth = imageData.width;
                dctlState.imageHeight = imageData.height;
            }

            // Identify color space from chromaticities
            // Default to sRGB if no chromaticities metadata
            let colorSpace = 'sRGB - Texture';
            let colorSpaceDetected = false;
            if (imageData.chromaticities) {
                const identified = identifyColorSpace(imageData.chromaticities);
                if (identified !== 'unknown') {
                    // Map internal names to OCIO color space names
                    const ocioNameMap: Record<string, string> = {
                        'ACES2065-1': 'ACES2065-1',
                        'ACEScg': 'ACEScg',
                        'sRGB': 'sRGB - Texture',
                        'Rec.709': 'sRGB - Texture',
                        'Rec.2020': 'Rec.2020 (OETF)',
                        'DCI-P3': 'P3-D65',
                        'Display P3': 'P3-D65',
                    };
                    colorSpace = ocioNameMap[identified] || identified;
                    colorSpaceDetected = true;
                }
            }

            // Initialize OCIO and get available displays/views/color spaces
            setWasmDirectory(wasmDir);
            await initOCIO();
            const processor = new OCIOProcessor();
            processor.init();

            const colorSpaces = processor.getColorSpaces();
            const displays = processor.getDisplays();
            const displayViewMap: Record<string, string[]> = {};
            for (const display of displays) {
                displayViewMap[display] = processor.getViews(display);
            }
            perf.lap('Initialize OCIO');

            // Get GPU shader for default transform (source -> sRGB display)
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const defaultView = displayViewMap[defaultDisplay]?.[0] || '';

            // Store OCIO state for DCTL shader rebuilding
            this.currentOcioState = { source: colorSpace, display: defaultDisplay, view: defaultView };

            processor.createDisplayTransform(colorSpace, defaultDisplay, defaultView);
            processor.setupGpuProcessor();
            const shaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();
            perf.lap('Generate OCIO GPU shader');

            // Convert GLSL to WGSL for WebGPU
            const extensionPath = this.context.extensionPath;
            const wgslResult = await buildWgslShader(extensionPath, shaderInfo);
            if (!wgslResult.success) {
                writeLog(`WGSL conversion failed: ${wgslResult.error}`);
            }
            perf.lap('Convert GLSL to WGSL');

            // Send image data to webview using ArrayBuffer for efficient transfer
            // Structured clone algorithm handles ArrayBuffers without JSON serialization
            webview.postMessage({
                type: 'loadImage',
                data: {
                    width: imageData.width,
                    height: imageData.height,
                    channels: imageData.channels.length,
                    // Pass ArrayBuffer directly - avoid JSON serialization
                    buffer: imageData.pixels.buffer,
                    byteOffset: imageData.pixels.byteOffset,
                    byteLength: imageData.pixels.byteLength,
                    colorSpace,
                    colorSpaceDetected,
                    compression: imageData.compressionName,
                    bitDepth: imageData.pixelTypeName,
                    colorSpaces,
                    displays,
                    defaultDisplay,
                    defaultView,
                    displayViewMap,
                    // GLSL shader info (for WebGL fallback)
                    shaderInfo: {
                        shaderText: shaderInfo.shaderText,
                        textures: shaderInfo.textures,
                        textures3D: shaderInfo.textures3D,
                        uniforms: shaderInfo.uniforms,
                    },
                    // WGSL shader info (for WebGPU)
                    wgslShaderInfo: wgslResult.success ? {
                        wgslCode: wgslResult.wgslCode,
                        computeWgslCode: wgslResult.computeWgslCode,  // For compute pipeline
                        textures: shaderInfo.textures,
                        textures3D: shaderInfo.textures3D,
                        bindings: wgslResult.bindings,
                    } : null,
                },
            });
            perf.lap('Post message to webview');
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

    private async updateDisplayTransform(
        _document: ExrDocument,
        panel: vscode.WebviewPanel,
        source: string,
        display: string,
        view: string
    ): Promise<void> {
        // Store OCIO state for DCTL shader rebuilding
        this.currentOcioState = { source, display, view };

        // Check if DCTL is active - if so, rebuild with DCTL included
        const dctlState = this.dctlStates.get(panel);
        if (dctlState && dctlState.enabled && dctlState.filePath) {
            writeLog(`Display transform with DCTL active, rebuilding integrated shader`);
            await this.rebuildShaderWithDctl(panel);
            return;
        }

        // No DCTL active - build OCIO-only shader
        try {
            await initOCIO();
            const processor = new OCIOProcessor();
            processor.init();
            processor.createDisplayTransform(source, display, view);
            processor.setupGpuProcessor();
            const shaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            // Convert GLSL to WGSL for WebGPU
            const extensionPath = this.context.extensionPath;
            const wgslResult = await buildWgslShader(extensionPath, shaderInfo);
            if (!wgslResult.success) {
                writeLog(`WGSL conversion failed: ${wgslResult.error}`);
            }

            panel.webview.postMessage({
                type: 'updateShader',
                // GLSL shader info (for WebGL fallback)
                shaderInfo: {
                    shaderText: shaderInfo.shaderText,
                    textures: shaderInfo.textures,
                    textures3D: shaderInfo.textures3D,
                    uniforms: shaderInfo.uniforms,
                },
                // WGSL shader info (for WebGPU)
                wgslShaderInfo: wgslResult.success ? {
                    wgslCode: wgslResult.wgslCode,
                    computeWgslCode: wgslResult.computeWgslCode,  // For compute pipeline
                    textures: shaderInfo.textures,
                    textures3D: shaderInfo.textures3D,
                    bindings: wgslResult.bindings,
                } : null,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            panel.webview.postMessage({
                type: 'error',
                message: `Failed to update display transform: ${message}`,
            });
        }
    }

    // =========================================================================
    // DCTL Handlers
    // =========================================================================

    private async handleSelectDctlFile(panel: vscode.WebviewPanel): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'DCTL Files': ['dctl'],
                'All Files': ['*'],
            },
            title: 'Select DCTL File',
        });

        if (!result || result.length === 0) {
            return;
        }

        const filePath = result[0].fsPath;
        await this.loadDctlFile(panel, filePath);
    }

    private async loadDctlFile(panel: vscode.WebviewPanel, filePath: string): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Loading DCTL file: ${filePath}`);

        try {
            // Read and preprocess DCTL file
            const rawDctlSource = fs.readFileSync(filePath, 'utf-8');
            const preprocessResult = await preprocessDctlSource(rawDctlSource, filePath);

            if (!preprocessResult.success) {
                const errMsg = preprocessResult.errors.map(e => e.message).join(', ');
                throw new Error(`Preprocess failed: ${errMsg}`);
            }

            // Create DctlInfo for Rust compiler path (no transpilation needed)
            const dctlInfo = createDctlInfo(
                preprocessResult.expandedSource,
                state.workingColorSpace,
                preprocessResult.params,
                filePath
            );

            // Store shader info for export
            this.dctlShaderInfos.set(panel, dctlInfo);

            // Update state
            state.filePath = filePath;
            state.enabled = true;
            state.params = dctlInfo.params;
            state.includedFiles = preprocessResult.includedFiles;

            // Initialize param values with defaults
            state.paramValues = {};
            for (const param of dctlInfo.params) {
                state.paramValues[param.name] = param.default;
            }

            writeLog(`DCTL loaded: ${dctlInfo.params.length} params`);

            // Send DCTL info to webview
            panel.webview.postMessage({
                type: 'loadDctl',
                dctl: {
                    filePath,
                    params: dctlInfo.params,
                    enabled: state.enabled,
                    workingColorSpace: state.workingColorSpace,
                },
            });

            // Setup file watcher for hot reload
            this.setupDctlFileWatcher(panel, filePath, preprocessResult.includedFiles);

            // Rebuild shader with DCTL
            await this.rebuildShaderWithDctl(panel);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeLog(`DCTL load error: ${message}`);
            vscode.window.showErrorMessage(`Failed to load DCTL: ${message}`);
        }
    }

    private async handleToggleDctl(panel: vscode.WebviewPanel, enabled: boolean): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Toggle DCTL: ${enabled}`);
        state.enabled = enabled;

        // Rebuild shader
        await this.rebuildShaderWithDctl(panel);
    }

    private async handleToggleRgc(
        panel: vscode.WebviewPanel,
        enabled: boolean,
        peakLuminance?: number
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Toggle RGC: ${enabled}, peak: ${peakLuminance ?? state.rgcPeakLuminance} nits`);
        state.applyRgc = enabled;
        if (peakLuminance) state.rgcPeakLuminance = peakLuminance;

        // Rebuild shader
        await this.rebuildShaderWithDctl(panel);
    }

    private async handleUpdateRgcSettings(
        panel: vscode.WebviewPanel,
        peakLuminance: number
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Update RGC settings: peak=${peakLuminance} nits`);
        state.rgcPeakLuminance = peakLuminance;

        // Only rebuild if RGC is enabled
        if (state.applyRgc) {
            await this.rebuildShaderWithDctl(panel);
        }
    }

    private async handleChangeDctlColorSpace(
        panel: vscode.WebviewPanel,
        colorSpace: 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB'
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Change DCTL color space: ${colorSpace}`);
        state.workingColorSpace = colorSpace;

        // Rebuild shader with new color space
        await this.rebuildShaderWithDctl(panel);
    }

    private async handleUpdateDctlParam(
        panel: vscode.WebviewPanel,
        name: string,
        value: number | boolean | DctlColorValue
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        state.paramValues[name] = value;

        writeLog(`DCTL param update: ${name} = ${JSON.stringify(value)}, useUniformBuffer=${state.useUniformBuffer}, hasDctlSupport=${state.hasDctlSupport}`);

        // Only use fast path if:
        // 1. useUniformBuffer is enabled
        // 2. The webview confirmed DCTL compute pipeline was built (hasDctlSupport)
        if (state.useUniformBuffer && state.hasDctlSupport) {
            // Fast path: Update uniform buffer directly without shader recompilation
            // This reduces latency from 100-200ms to <1ms
            panel.webview.postMessage({
                type: 'updateDctlParamFast',
                name,
                value,
            });
        } else {
            // Slow path: Rebuild shader with new param values baked in as constants
            writeLog(`Using slow path: useUniformBuffer=${state.useUniformBuffer}, hasDctlSupport=${state.hasDctlSupport}`);
            await this.rebuildShaderWithDctl(panel);
        }
    }

    private async rebuildShaderWithDctl(panel: vscode.WebviewPanel): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state || !this.currentOcioState) return;

        try {
            // Get OCIO shader
            await initOCIO();
            const processor = new OCIOProcessor();
            processor.init();
            processor.createDisplayTransform(
                this.currentOcioState.source,
                this.currentOcioState.display,
                this.currentOcioState.view
            );
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            // Build integrated shader (DCTL + OCIO)
            let dctlShaderInfo = undefined;
            let dctlSource: string | undefined = undefined;
            if (state.enabled && state.filePath) {
                const rawDctlSource = fs.readFileSync(state.filePath, 'utf-8');

                // For Rust compiler (Compute Shader path): pass raw source
                // Rust compiler internally handles preprocessing (macros, includes) and parsing
                dctlSource = rawDctlSource;

                // Create DctlInfo for Rust compiler path (no transpilation needed)
                const preprocessResult = await preprocessDctlSource(rawDctlSource, state.filePath);
                if (preprocessResult.success) {
                    dctlShaderInfo = createDctlInfo(
                        preprocessResult.expandedSource,
                        state.workingColorSpace,
                        preprocessResult.params,
                        state.filePath ?? undefined
                    );
                    // Store for export
                    this.dctlShaderInfos.set(panel, dctlShaderInfo);
                }
            }

            const extensionPath = this.context.extensionPath;

            // Log param values being used for shader rebuild
            writeLog(`Shader rebuild: state.enabled=${state.enabled}, dctlShaderInfo=${dctlShaderInfo ? 'exists' : 'undefined'}`);
            writeLog(`Shader rebuild with params: ${JSON.stringify(state.paramValues)}, useUniformBuffer: ${state.useUniformBuffer}`);
            writeLog(`Shader rebuild RGC: applyRgc=${state.applyRgc}, peakLuminance=${state.rgcPeakLuminance}`);

            // Always pass options (even without DCTL) to support RGC without DCTL
            const dctlOptions = {
                paramValues: state.useUniformBuffer ? undefined : state.paramValues,
                enabled: state.enabled,
                imageWidth: state.imageWidth,
                imageHeight: state.imageHeight,
                useUniformBuffer: state.useUniformBuffer,
                useRustCompiler: true,
                dctlSource,
                applyACES2GamutCompression: state.applyRgc,
                peakLuminance: state.rgcPeakLuminance,
            };

            const integratedShader = await buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlShaderInfo,
                dctlOptions
            );

            // Log shader build result
            if (integratedShader.success) {
                writeLog(`Shader rebuild SUCCESS: WGSL length=${integratedShader.wgslCode.length}, useUniformBuffer=${integratedShader.useUniformBuffer}`);

                // Log DCTL compute shader info
                const dctlInfo = integratedShader.dctlComputeShaderInfo;
                if (dctlInfo) {
                    writeLog(`DCTL Compute Shader: success=${dctlInfo.success}, hasDctl=${dctlInfo.hasDctl}, hasFullRgc=${dctlInfo.hasFullRgc}, error=${dctlInfo.error || 'none'}`);
                    writeLog(`DCTL Compute Shader: computeWgsl=${dctlInfo.computeWgsl?.length || 0}, dctlFn=${dctlInfo.dctlFunctionWgsl?.length || 0}, ocioFn=${dctlInfo.ocioFunctionWgsl?.length || 0}`);
                    if (dctlInfo.hasFullRgc) {
                        writeLog(`DCTL Compute Shader RGC: rgcTextures=${dctlInfo.rgcTextures?.length || 0}, rgcTextures3D=${dctlInfo.rgcTextures3D?.length || 0}`);
                    }
                } else {
                    writeLog(`DCTL Compute Shader: not generated`);
                }
            } else {
                writeLog(`Shader rebuild FAILED: ${integratedShader.error}`);
            }

            // Debug: Log what we're about to send
            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            writeLog(`Sending to webview: dctlComputeShaderInfo=${dctlComputeInfo ? 'exists' : 'undefined'}, hasDctl=${dctlComputeInfo?.hasDctl}, hasFullRgc=${dctlComputeInfo?.hasFullRgc}, success=${dctlComputeInfo?.success}`);
            if (dctlComputeInfo) {
                writeLog(`  paramMapping count: ${dctlComputeInfo.paramMapping?.length || 0}`);
            }

            // Send updated shader to webview
            panel.webview.postMessage({
                type: 'updateShader',
                shaderInfo: {
                    shaderText: integratedShader.glslCode || '',
                    textures: ocioShaderInfo.textures,
                    textures3D: ocioShaderInfo.textures3D,
                    uniforms: ocioShaderInfo.uniforms,
                },
                wgslShaderInfo: integratedShader.success ? {
                    wgslCode: integratedShader.wgslCode,
                    computeWgslCode: integratedShader.computeWgslCode,  // For compute pipeline
                    textures: ocioShaderInfo.textures,
                    textures3D: ocioShaderInfo.textures3D,
                    bindings: integratedShader.bindings,
                    dctlBindings: integratedShader.dctlBindings,
                    dctlDefaults: integratedShader.dctlDefaults,
                    // Uniform buffer support for fast DCTL parameter updates
                    paramMapping: integratedShader.paramMapping,
                    useUniformBuffer: integratedShader.useUniformBuffer,
                    uniformBufferBinding: integratedShader.uniformBufferBinding,
                    // DCTL + OCIO compute shader info (for compute pipeline with DCTL support)
                    dctlComputeShaderInfo: integratedShader.dctlComputeShaderInfo,
                } : null,
            });

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeLog(`Shader rebuild error: ${message}`);
        }
    }

    private setupDctlFileWatcher(
        panel: vscode.WebviewPanel,
        mainFile: string,
        includedFiles: string[]
    ): void {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        // Dispose existing watcher
        if (state.fileWatcher) {
            state.fileWatcher.dispose();
        }

        // Watch main file and all included files
        const filesToWatch = [mainFile, ...includedFiles];
        const pattern = filesToWatch.length === 1
            ? mainFile
            : `{${filesToWatch.join(',')}}`;

        state.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const onFileChange = async (uri: vscode.Uri) => {
            writeLog(`DCTL file changed: ${uri.fsPath}`);
            if (state.filePath) {
                await this.loadDctlFile(panel, state.filePath);
            }
        };

        state.fileWatcher.onDidChange(onFileChange);
        state.fileWatcher.onDidCreate(onFileChange);
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'exr-viewer.css')
        );

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
    <link href="${styleUri}" rel="stylesheet">
    <title>EXR Viewer</title>
</head>
<body>
    <div id="toolbar">
        <div class="toolbar-group">
            <label for="source-select">Source:</label>
            <select id="source-select"></select>
        </div>
        <div class="toolbar-group">
            <label for="display-select">Display:</label>
            <select id="display-select"></select>
        </div>
        <div class="toolbar-group">
            <label for="view-select">View:</label>
            <select id="view-select"></select>
        </div>
        <div class="toolbar-group">
            <span id="image-info"></span>
        </div>
        <div class="toolbar-group">
            <span id="color-space-info"></span>
        </div>
        <div class="toolbar-group toolbar-right">
            <button id="export-exr-btn" class="export-btn" title="Export as EXR (with DCTL applied)">Export EXR</button>
        </div>
    </div>
    <div class="main-content">
        <!-- Left Sidebar: Metadata -->
        <aside id="sidebar-left" class="sidebar sidebar-left open">
            <header class="sidebar-header">
                <span class="sidebar-title">Metadata</span>
                <button id="sidebar-left-toggle" class="sidebar-toggle" title="Toggle sidebar">&#9664;</button>
            </header>
            <div class="sidebar-content">
                <div class="sidebar-section">
                    <button class="section-header" data-section="image-info-section">
                        <span class="section-toggle">&#9660;</span>
                        <span class="section-title">Image Info</span>
                    </button>
                    <div id="image-info-section" class="section-content">
                        <div class="metadata-list" id="metadata-image-info"></div>
                    </div>
                </div>
            </div>
        </aside>
        <div id="resize-handle-left" class="resize-handle"></div>
        <div id="canvas-container">
            <canvas id="preview-canvas"></canvas>
            <!-- Loading Overlay (inside canvas container) -->
            <div id="loading-overlay" class="visible">
                <div class="spinner"></div>
                <div id="loading-text">Open an EXR file to view</div>
            </div>
        </div>
        <div id="resize-handle-right" class="resize-handle"></div>
        <!-- Right Sidebar: DCTL -->
        <aside id="sidebar-right" class="sidebar sidebar-right open">
            <header class="sidebar-header">
                <button id="sidebar-right-toggle" class="sidebar-toggle" title="Toggle sidebar">&#9654;</button>
                <span class="sidebar-title">DCTL</span>
            </header>
            <div class="sidebar-content">
                <div id="dctl-panel" class="dctl-panel disabled">
                    <div class="dctl-header">
                        <label class="dctl-enable">
                            <input type="checkbox" id="dctl-enabled" disabled>
                            <span>Enable</span>
                        </label>
                        <select id="dctl-file-select" class="dctl-file-select">
                            <option value="">-- Select DCTL --</option>
                        </select>
                        <button id="dctl-file-btn" class="dctl-file-btn" title="Browse for DCTL file">...</button>
                    </div>
                    <div class="dctl-colorspace">
                        <label for="dctl-colorspace">Working:</label>
                        <select id="dctl-colorspace">
                            <option value="ACES2065-1">ACES2065-1 (AP0)</option>
                            <option value="ACEScg" selected>ACEScg (AP1)</option>
                            <option value="ACEScc">ACEScc (Log)</option>
                            <option value="ACEScct">ACEScct (Log)</option>
                            <option value="linear_sRGB">Linear sRGB</option>
                        </select>
                    </div>
                    <div class="dctl-rgc">
                        <label class="dctl-rgc-enable">
                            <input type="checkbox" id="rgc-enabled">
                            <span>ACES 2.0 RGC</span>
                        </label>
                        <div class="dctl-rgc-options" id="rgc-options" style="display: none;">
                            <div class="dctl-rgc-row">
                                <label for="rgc-peak-luminance">Peak:</label>
                                <select id="rgc-peak-luminance">
                                    <option value="100" selected>100 nits (SDR)</option>
                                    <option value="500">500 nits</option>
                                    <option value="1000">1000 nits</option>
                                    <option value="2000">2000 nits</option>
                                    <option value="4000">4000 nits</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    <div class="dctl-params-section">
                        <div class="dctl-params-header">UI Parameters</div>
                        <div id="dctl-params" class="dctl-params">
                            <span class="dctl-params-empty">Select a DCTL file to see parameters</span>
                        </div>
                    </div>
                </div>
            </div>
        </aside>
    </div>
    <div id="status-bar">
        <div class="zoom-controls">
            <button id="zoom-fit" class="zoom-btn" title="Fit to window">Fit</button>
            <button id="zoom-100" class="zoom-btn" title="100% zoom">1:1</button>
            <span id="zoom-info">100%</span>
        </div>
        <div class="hdr-controls">
            <button id="hdr-toggle" class="hdr-btn" title="Toggle HDR mode (extended tone mapping)">HDR</button>
        </div>
        <span id="pixel-info"></span>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

class ExrDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}

    dispose(): void {
        // Cleanup if needed
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
