/**
 * ImageViewerCore — Image-source-agnostic viewer logic.
 *
 * Owns all per-panel state (DCTL, OCIO, RGC) and handles DCTL-related
 * messages from the webview. ExrEditorProvider delegates to this class
 * for all state management and DCTL/shader operations.
 *
 * Responsibilities migrated from ExrEditorProvider:
 * - S4: Class skeleton + state maps
 * - S5: DCTL handlers (toggle, RGC, color space, param, file load/watch)
 * - S6: rebuildShaderWithDctl
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { initOCIO, OCIOProcessor, setWasmDirectory } from '@dctl-workbench/core';
import { buildWgslShader, buildIntegratedShader, buildDctlExportShader } from '../shader';
import { preprocessDctlSource } from '../dctl/preprocessor';
import { createDctlInfo, type DctlParam, type DctlColorValue, type DctlShaderInfo } from '../dctl/types';
import type { DctlState, OcioState } from './viewer-types';
import { getViewerHtml } from './viewer-html';
import { parseWorkingColorSpace } from './settings-helpers';
import { writeLog } from '../shared/logger';

export class ImageViewerCore {
    // Per-panel state maps (sole owner — ExrEditorProvider accesses via public methods)
    private readonly dctlStates = new Map<vscode.WebviewPanel, DctlState>();
    private readonly ocioStates = new Map<vscode.WebviewPanel, OcioState>();
    private readonly panelInfos = new Map<vscode.WebviewPanel, { documentPath: string; lastActiveTime: number }>();
    private readonly dctlShaderInfos = new Map<vscode.WebviewPanel, DctlShaderInfo>();
    private readonly editorChangeSubscriptions = new Map<vscode.WebviewPanel, vscode.Disposable[]>();
    private readonly pendingExports = new Map<string, {
        resolve: (data: { pixels: Float32Array; width: number; height: number }) => void;
        reject: (error: Error) => void;
    }>();

    constructor(
        private readonly context: vscode.ExtensionContext,
    ) {}

    // =========================================================================
    // Panel lifecycle
    // =========================================================================

    /**
     * Attach a panel: register state, set up HTML, wire dispose + view state.
     * Called from ExrEditorProvider.resolveCustomEditor.
     */
    public attach(
        panel: vscode.WebviewPanel,
        documentPath: string,
        handlers?: {
            /** Called when webview sends 'ready'. Provider loads image data here. */
            onReady?: (panel: vscode.WebviewPanel) => Promise<void>;
            /** Called when webview requests EXR export. Provider writes the file. */
            onExport?: (panel: vscode.WebviewPanel) => Promise<void>;
        },
    ): void {
        // Configure webview
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'out'),
                vscode.Uri.joinPath(this.context.extensionUri, 'wasm'),
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        };

        // Set HTML
        const scriptUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.js')
        );
        const styleUri = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'exr-viewer.css')
        );
        panel.webview.html = getViewerHtml(scriptUri, styleUri, panel.webview.cspSource);

        // Initialize DCTL state
        const dctlState = this.createDefaultDctlState();
        this.dctlStates.set(panel, dctlState);

        // Track panel info
        this.panelInfos.set(panel, {
            documentPath,
            lastActiveTime: Date.now(),
        });

        // Update lastActiveTime when panel becomes active
        panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                const info = this.panelInfos.get(panel);
                if (info) {
                    info.lastActiveTime = Date.now();
                }
            }
        });

        // Listen for editor/tab changes to update open DCTL files list
        const subscriptions: vscode.Disposable[] = [];
        subscriptions.push(
            vscode.window.onDidChangeVisibleTextEditors(() => {
                this.sendOpenDctlFiles(panel);
            })
        );
        subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(() => {
                this.sendOpenDctlFiles(panel);
            })
        );
        this.editorChangeSubscriptions.set(panel, subscriptions);

        // Cleanup on panel dispose
        panel.onDidDispose(() => {
            const state = this.dctlStates.get(panel);
            if (state?.fileWatcher) {
                state.fileWatcher.dispose();
            }
            this.dctlStates.delete(panel);
            this.panelInfos.delete(panel);
            this.ocioStates.delete(panel);
            this.dctlShaderInfos.delete(panel);

            const subs = this.editorChangeSubscriptions.get(panel);
            if (subs) {
                subs.forEach(s => s.dispose());
                this.editorChangeSubscriptions.delete(panel);
            }
        });

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'ready':
                    writeLog('Webview ready');
                    if (handlers?.onReady) await handlers.onReady(panel);
                    this.sendOpenDctlFiles(panel);
                    break;
                case 'setDisplayTransform':
                    writeLog(`Display transform: ${message.source} -> ${message.display} / ${message.view}`);
                    await this.updateDisplayTransform(panel, message.source, message.display, message.view);
                    break;
                case 'selectDctlFile':
                    await this.handleSelectDctlFile(panel);
                    break;
                case 'loadDctlFromPath':
                    if (message.path) await this.loadDctlFile(panel, message.path);
                    break;
                case 'toggleDctl':
                    await this.handleToggleDctl(panel, message.enabled);
                    break;
                case 'toggleRgc':
                    await this.handleToggleRgc(panel, message.enabled, message.peakLuminance);
                    break;
                case 'updateRgcSettings':
                    await this.handleUpdateRgcSettings(panel, message.peakLuminance);
                    break;
                case 'changeDctlColorSpace':
                    await this.handleChangeDctlColorSpace(panel, message.colorSpace);
                    break;
                case 'updateDctlParam':
                    await this.handleUpdateDctlParam(panel, message.name, message.value);
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
                    if (handlers?.onExport) {
                        handlers.onExport(panel).catch((error) => {
                            const errMsg = error instanceof Error ? error.message : String(error);
                            vscode.window.showErrorMessage(`Export failed: ${errMsg}`);
                        });
                    }
                    break;
                case 'shaderBuildResult':
                    this.handleShaderBuildResult(panel, message.hasDctlSupport, message.error);
                    break;
                case 'rgcPixelVerification':
                    this.handleRgcPixelVerification(message.isBlack, message.pixels, message.hasFullRgc);
                    break;
            }
        });
    }

    /**
     * Get active panels sorted by last-active time (most recent first).
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

        panels.sort((a, b) => b.lastActiveTime - a.lastActiveTime);

        return panels.map(({ panel, documentPath, documentName }) => ({
            panel,
            documentPath,
            documentName,
        }));
    }

    // =========================================================================
    // State accessors (for ExrEditorProvider during migration)
    // =========================================================================

    public getDctlState(panel: vscode.WebviewPanel): DctlState | undefined {
        return this.dctlStates.get(panel);
    }

    public getOcioState(panel: vscode.WebviewPanel): OcioState | undefined {
        return this.ocioStates.get(panel);
    }

    public setOcioState(panel: vscode.WebviewPanel, state: OcioState): void {
        this.ocioStates.set(panel, state);
    }

    public getDctlShaderInfo(panel: vscode.WebviewPanel): DctlShaderInfo | undefined {
        return this.dctlShaderInfos.get(panel);
    }

    public getPanelInfo(panel: vscode.WebviewPanel): { documentPath: string; lastActiveTime: number } | undefined {
        return this.panelInfos.get(panel);
    }

    // =========================================================================
    // DCTL file detection
    // =========================================================================

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

        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    const uri = tab.input.uri;
                    if (uri.fsPath.endsWith('.dctl')) {
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

    public sendOpenDctlFiles(panel: vscode.WebviewPanel): void {
        const openDctlFiles = this.getOpenDctlFiles();
        panel.webview.postMessage({
            type: 'openDctlFiles',
            files: openDctlFiles,
        });
        writeLog(`Sent ${openDctlFiles.length} open DCTL files to webview`);
    }

    // =========================================================================
    // DCTL message handlers (S5)
    // =========================================================================

    public async handleSelectDctlFile(panel: vscode.WebviewPanel): Promise<void> {
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

    public async loadDctlFile(panel: vscode.WebviewPanel, filePath: string): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Loading DCTL file: ${filePath}`);

        try {
            const rawDctlSource = await fs.promises.readFile(filePath, 'utf-8');
            const preprocessResult = await preprocessDctlSource(rawDctlSource, filePath);

            if (!preprocessResult.success) {
                const errMsg = preprocessResult.errors.map((e: any) => e.message).join(', ');
                throw new Error(`Preprocess failed: ${errMsg}`);
            }

            const dctlInfo = createDctlInfo(
                preprocessResult.expandedSource,
                state.workingColorSpace,
                preprocessResult.params,
                filePath
            );

            this.dctlShaderInfos.set(panel, dctlInfo);

            state.filePath = filePath;
            state.enabled = true;
            state.params = dctlInfo.params;
            state.includedFiles = preprocessResult.includedFiles;

            state.paramValues = {};
            for (const param of dctlInfo.params) {
                state.paramValues[param.name] = param.default;
            }

            writeLog(`DCTL loaded: ${dctlInfo.params.length} params`);

            panel.webview.postMessage({
                type: 'loadDctl',
                dctl: {
                    filePath,
                    params: dctlInfo.params,
                    enabled: state.enabled,
                    workingColorSpace: state.workingColorSpace,
                },
            });

            this.setupDctlFileWatcher(panel, filePath, preprocessResult.includedFiles);

            await this.rebuildShaderWithDctl(panel);

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeLog(`DCTL load error: ${message}`);
            vscode.window.showErrorMessage(`Failed to load DCTL: ${message}`);
        }
    }

    public async handleToggleDctl(panel: vscode.WebviewPanel, enabled: boolean): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Toggle DCTL: ${enabled}`);
        state.enabled = enabled;

        await this.rebuildShaderWithDctl(panel);
    }

    public async handleToggleRgc(
        panel: vscode.WebviewPanel,
        enabled: boolean,
        peakLuminance?: number
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Toggle RGC: ${enabled}, peak: ${peakLuminance ?? state.rgcPeakLuminance} nits`);
        state.applyRgc = enabled;
        if (peakLuminance) state.rgcPeakLuminance = peakLuminance;

        await this.rebuildShaderWithDctl(panel);
    }

    public async handleUpdateRgcSettings(
        panel: vscode.WebviewPanel,
        peakLuminance: number
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Update RGC settings: peak=${peakLuminance} nits`);
        state.rgcPeakLuminance = peakLuminance;

        if (state.applyRgc) {
            await this.rebuildShaderWithDctl(panel);
        }
    }

    public async handleChangeDctlColorSpace(
        panel: vscode.WebviewPanel,
        colorSpace: 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB'
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        writeLog(`Change DCTL color space: ${colorSpace}`);
        state.workingColorSpace = colorSpace;

        await this.rebuildShaderWithDctl(panel);
    }

    public async handleUpdateDctlParam(
        panel: vscode.WebviewPanel,
        name: string,
        value: number | boolean | DctlColorValue
    ): Promise<void> {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        state.paramValues[name] = value;

        writeLog(`DCTL param update: ${name} = ${JSON.stringify(value)}, useUniformBuffer=${state.useUniformBuffer}, hasDctlSupport=${state.hasDctlSupport}`);

        if (state.useUniformBuffer && state.hasDctlSupport) {
            panel.webview.postMessage({
                type: 'updateDctlParamFast',
                name,
                value,
            });
        } else {
            writeLog(`Using slow path: useUniformBuffer=${state.useUniformBuffer}, hasDctlSupport=${state.hasDctlSupport}`);
            await this.rebuildShaderWithDctl(panel);
        }
    }

    public handleShaderBuildResult(
        panel: vscode.WebviewPanel,
        hasDctlSupport: boolean,
        error?: string
    ): void {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        state.hasDctlSupport = hasDctlSupport;
        writeLog(`Shader build result: hasDctlSupport=${hasDctlSupport}${error ? `, error=${error}` : ''}`);
    }

    public handleRgcPixelVerification(
        isBlack: boolean,
        pixels: number[],
        hasFullRgc: boolean
    ): void {
        const pixelStr = pixels.slice(0, 8).map(p => p.toFixed(4)).join(', ');
        const status = isBlack ? 'BLACK (FAIL)' : 'OK (has content)';

        writeLog(`[RGC VERIFICATION] Status: ${status}`);
        writeLog(`[RGC VERIFICATION] hasFullRgc=${hasFullRgc}, isBlack=${isBlack}`);
        writeLog(`[RGC VERIFICATION] Sample pixels: [${pixelStr}...]`);

        if (isBlack) {
            vscode.window.showWarningMessage(
                'RGC rendering verification: Output appears to be BLACK. Check debug.log for details.'
            );
        }
    }

    public handleExportBufferReady(message: {
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
            const bufferType = Object.prototype.toString.call(message.buffer);
            writeLog(`Export buffer received: type=${bufferType}, width=${message.width}, height=${message.height}`);

            let pixels: Float32Array;
            if (message.buffer instanceof ArrayBuffer) {
                pixels = new Float32Array(message.buffer);
            } else if (ArrayBuffer.isView(message.buffer)) {
                const view = message.buffer as unknown as ArrayBufferView;
                pixels = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
            } else {
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

    // =========================================================================
    // Shader rebuild (S6)
    // =========================================================================

    public async rebuildShaderWithDctl(panel: vscode.WebviewPanel): Promise<void> {
        const state = this.dctlStates.get(panel);
        const ocioState = this.ocioStates.get(panel);
        if (!state || !ocioState) return;

        try {
            await initOCIO();
            const processor = new OCIOProcessor();
            processor.init();
            processor.createDisplayTransform(
                ocioState.source,
                ocioState.display,
                ocioState.view
            );
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            let dctlShaderInfo = undefined;
            let dctlSource: string | undefined = undefined;
            if (state.enabled && state.filePath) {
                const rawDctlSource = await fs.promises.readFile(state.filePath, 'utf-8');
                dctlSource = rawDctlSource;

                const preprocessResult = await preprocessDctlSource(rawDctlSource, state.filePath);
                if (preprocessResult.success) {
                    dctlShaderInfo = createDctlInfo(
                        preprocessResult.expandedSource,
                        state.workingColorSpace,
                        preprocessResult.params,
                        state.filePath ?? undefined
                    );
                    this.dctlShaderInfos.set(panel, dctlShaderInfo);
                }
            }

            const extensionPath = this.context.extensionPath;

            writeLog(`Shader rebuild: state.enabled=${state.enabled}, dctlShaderInfo=${dctlShaderInfo ? 'exists' : 'undefined'}`);
            writeLog(`Shader rebuild with params: ${JSON.stringify(state.paramValues)}, useUniformBuffer: ${state.useUniformBuffer}`);
            writeLog(`Shader rebuild RGC: applyRgc=${state.applyRgc}, peakLuminance=${state.rgcPeakLuminance}`);

            const dctlOptions = {
                paramValues: state.useUniformBuffer ? undefined : state.paramValues,
                enabled: state.enabled,
                imageWidth: state.imageWidth,
                imageHeight: state.imageHeight,
                useUniformBuffer: state.useUniformBuffer,
                useRustCompiler: true,
                dctlSource,
                dctlFilePath: state.filePath ?? undefined,
                applyACES2GamutCompression: state.applyRgc,
                peakLuminance: state.rgcPeakLuminance,
            };

            const integratedShader = await buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlShaderInfo,
                dctlOptions
            );

            if (integratedShader.success) {
                writeLog(`Shader rebuild SUCCESS: WGSL length=${integratedShader.wgslCode.length}, useUniformBuffer=${integratedShader.useUniformBuffer}`);
                const dctlInfo = integratedShader.dctlComputeShaderInfo;
                if (dctlInfo) {
                    writeLog(`DCTL Compute Shader: success=${dctlInfo.success}, hasDctl=${dctlInfo.hasDctl}, hasFullRgc=${dctlInfo.hasFullRgc}, error=${dctlInfo.error || 'none'}`);
                }
            } else {
                writeLog(`Shader rebuild FAILED: ${integratedShader.error}`);
            }

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
                    computeWgslCode: integratedShader.computeWgslCode,
                    textures: ocioShaderInfo.textures,
                    textures3D: ocioShaderInfo.textures3D,
                    bindings: integratedShader.bindings,
                    dctlBindings: integratedShader.dctlBindings,
                    dctlDefaults: integratedShader.dctlDefaults,
                    paramMapping: integratedShader.paramMapping,
                    useUniformBuffer: integratedShader.useUniformBuffer,
                    uniformBufferBinding: integratedShader.uniformBufferBinding,
                    dctlComputeShaderInfo: integratedShader.dctlComputeShaderInfo,
                } : null,
            });

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            writeLog(`Shader rebuild error: ${message}`);
        }
    }

    // =========================================================================
    // Display transform (S7)
    // =========================================================================

    /**
     * Update the OCIO display transform for a panel.
     * If DCTL is active, rebuilds the integrated shader; otherwise builds OCIO-only.
     */
    public async updateDisplayTransform(
        panel: vscode.WebviewPanel,
        source: string,
        display: string,
        view: string
    ): Promise<void> {
        // Store OCIO state per panel for DCTL shader rebuilding
        this.ocioStates.set(panel, { source, display, view });

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
                    computeWgslCode: wgslResult.computeWgslCode,
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

    /**
     * Load decoded image data into a panel: OCIO init, shader build, webview postMessage.
     * Called from ExrEditorProvider after EXR-specific decoding is done.
     */
    public async loadImageData(
        panel: vscode.WebviewPanel,
        imageData: {
            width: number;
            height: number;
            channels: number;
            buffer: ArrayBuffer;
            byteOffset: number;
            byteLength: number;
            colorSpace: string;
            colorSpaceDetected: boolean;
            compression: string;
            bitDepth: string;
        },
        wasmDir: string
    ): Promise<void> {
        // Store image dimensions in DCTL state for shader built-in parameters
        const dctlState = this.dctlStates.get(panel);
        if (dctlState) {
            dctlState.imageWidth = imageData.width;
            dctlState.imageHeight = imageData.height;
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

        // Get GPU shader for default transform (source -> sRGB display)
        const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
        const defaultView = displayViewMap[defaultDisplay]?.[0] || '';

        // Store OCIO state per panel for DCTL shader rebuilding
        this.ocioStates.set(panel, { source: imageData.colorSpace, display: defaultDisplay, view: defaultView });

        processor.createDisplayTransform(imageData.colorSpace, defaultDisplay, defaultView);
        processor.setupGpuProcessor();
        const shaderInfo = processor.extractGpuShaderInfo();
        processor.dispose();

        // Convert GLSL to WGSL for WebGPU
        const extensionPath = this.context.extensionPath;
        const wgslResult = await buildWgslShader(extensionPath, shaderInfo);
        if (!wgslResult.success) {
            writeLog(`WGSL conversion failed: ${wgslResult.error}`);
        }

        // Send image data to webview using ArrayBuffer for efficient transfer
        panel.webview.postMessage({
            type: 'loadImage',
            data: {
                width: imageData.width,
                height: imageData.height,
                channels: imageData.channels,
                buffer: imageData.buffer,
                byteOffset: imageData.byteOffset,
                byteLength: imageData.byteLength,
                colorSpace: imageData.colorSpace,
                colorSpaceDetected: imageData.colorSpaceDetected,
                compression: imageData.compression,
                bitDepth: imageData.bitDepth,
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
                    computeWgslCode: wgslResult.computeWgslCode,
                    textures: shaderInfo.textures,
                    textures3D: shaderInfo.textures3D,
                    bindings: wgslResult.bindings,
                } : null,
            },
        });
    }

    // =========================================================================
    // Export pipeline (S10)
    // =========================================================================

    /**
     * Build a DCTL export shader, send it to the webview, and return the
     * rendered pixel buffer. This is the format-agnostic part of export —
     * the caller writes the pixels to whatever output format it needs.
     *
     * @throws if no DCTL is loaded or shader build fails
     */
    public async getExportedPixels(panel: vscode.WebviewPanel): Promise<{
        pixels: Float32Array;
        width: number;
        height: number;
    }> {
        const state = this.dctlStates.get(panel);
        if (!state || !state.filePath) {
            throw new Error('No DCTL file loaded');
        }

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

        // Send shader to webview and request rendered buffer in one round-trip
        const requestId = `export-${crypto.randomUUID()}`;

        return new Promise((resolve, reject) => {
            // On timeout we delete the pending entry and reject. The webview may
            // still send exportBufferReady later — handleExportBufferReady logs
            // "unknown request" and discards it safely.
            const timeout = setTimeout(() => {
                this.pendingExports.delete(requestId);
                reject(new Error('Export timeout'));
            }, 30000);

            this.pendingExports.set(requestId, {
                resolve: (data) => {
                    clearTimeout(timeout);
                    resolve(data);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });

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
    }

    // =========================================================================
    // File watcher
    // =========================================================================

    private setupDctlFileWatcher(
        panel: vscode.WebviewPanel,
        mainFile: string,
        includedFiles: string[]
    ): void {
        const state = this.dctlStates.get(panel);
        if (!state) return;

        if (state.fileWatcher) {
            state.fileWatcher.dispose();
        }

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

    // =========================================================================
    // Default state
    // =========================================================================

    private createDefaultDctlState(): DctlState {
        return {
            filePath: null,
            enabled: false,
            workingColorSpace: parseWorkingColorSpace(
                vscode.workspace.getConfiguration('dctlWorkbench').get('exr_viewer.defaultWorkingColorSpace', 'ACEScct')
            ),
            params: [],
            paramValues: {},
            fileWatcher: null,
            includedFiles: [],
            imageWidth: 1920,
            imageHeight: 1080,
            useUniformBuffer: true,
            hasDctlSupport: false,
            applyRgc: false,
            rgcPeakLuminance: 100,
        };
    }

    public dispose(): void {
        for (const [, state] of this.dctlStates) {
            if (state.fileWatcher) {
                state.fileWatcher.dispose();
            }
        }
        this.dctlStates.clear();
        this.panelInfos.clear();
        this.ocioStates.clear();
        this.dctlShaderInfos.clear();
        this.pendingExports.clear();

        for (const [, subs] of this.editorChangeSubscriptions) {
            subs.forEach(s => s.dispose());
        }
        this.editorChangeSubscriptions.clear();
    }
}
