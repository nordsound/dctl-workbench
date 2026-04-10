/**
 * ImageViewerCore — Image-source-agnostic viewer logic.
 *
 * Manages per-panel state (DCTL, OCIO, RGC), shader compilation,
 * webview messaging, and export pipeline. The image decoding itself
 * is delegated to an InputPlugin (e.g. BuiltinExrInputPlugin).
 *
 * Created as an empty skeleton in A1/S4. Methods are migrated from
 * ExrEditorProvider in subsequent steps (S5-S11).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { performance } from 'perf_hooks';
import type { DctlShaderInfo } from '../dctl/types';
import type { DctlState, OcioState } from './viewer-types';
import { getViewerHtml } from './viewer-html';
import { parseWorkingColorSpace } from './settings-helpers';
import { writeLog } from '../shared/logger';

export class ImageViewerCore {
    // Per-panel state maps
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

    /**
     * Get list of active panels sorted by last-active time (most recent first).
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

    /**
     * Attach a panel to the core: register state, set up HTML, wire message handlers.
     * Called from ExrEditorProvider.resolveCustomEditor.
     */
    public attach(panel: vscode.WebviewPanel, documentPath: string): void {
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
    }

    /**
     * Get the DCTL state for a panel (used by ExrEditorProvider during migration).
     */
    public getDctlState(panel: vscode.WebviewPanel): DctlState | undefined {
        return this.dctlStates.get(panel);
    }

    /**
     * Get the OCIO state for a panel.
     */
    public getOcioState(panel: vscode.WebviewPanel): OcioState | undefined {
        return this.ocioStates.get(panel);
    }

    /**
     * Set the OCIO state for a panel.
     */
    public setOcioState(panel: vscode.WebviewPanel, state: OcioState): void {
        this.ocioStates.set(panel, state);
    }

    /**
     * Get the DCTL shader info for a panel.
     */
    public getDctlShaderInfo(panel: vscode.WebviewPanel): DctlShaderInfo | undefined {
        return this.dctlShaderInfos.get(panel);
    }

    /**
     * Set the DCTL shader info for a panel.
     */
    public setDctlShaderInfo(panel: vscode.WebviewPanel, info: DctlShaderInfo): void {
        this.dctlShaderInfos.set(panel, info);
    }

    /**
     * Get the pending exports map (for export pipeline).
     */
    public getPendingExports(): Map<string, {
        resolve: (data: { pixels: Float32Array; width: number; height: number }) => void;
        reject: (error: Error) => void;
    }> {
        return this.pendingExports;
    }

    /**
     * Set editor change subscriptions for a panel.
     */
    public setEditorChangeSubscriptions(panel: vscode.WebviewPanel, subs: vscode.Disposable[]): void {
        this.editorChangeSubscriptions.set(panel, subs);
    }

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

    // =========================================================================
    // Message handlers (migrated from ExrEditorProvider in S5)
    // =========================================================================

    /**
     * Handle shader build result from webview — sets hasDctlSupport flag.
     */
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

    public dispose(): void {
        // Dispose all panels' state
        for (const [panel, state] of this.dctlStates) {
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
