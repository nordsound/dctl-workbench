import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    InputPlugin,
    DemosaicPlugin,
    DctlWorkbenchApi,
} from './plugins/types';
import { ExrEditorProvider } from './editor/ExrEditorProvider';
import { DctlNativeDiagnosticsProvider } from './dctl';
import {
    DctlHoverProvider,
    DctlCompletionProvider,
    COMPLETION_TRIGGER_CHARACTERS
} from './dctl/language';
// Plugin registries
const inputPlugins = new Map<string, InputPlugin>();
const demosaicPlugins = new Map<string, DemosaicPlugin>();

// API version
const API_VERSION = '0.1.0';

/**
 * API exposed to plugin extensions
 */
const api: DctlWorkbenchApi = {
    registerInputPlugin(plugin: InputPlugin): void {
        if (inputPlugins.has(plugin.id)) {
            console.warn(`Input plugin with id "${plugin.id}" is already registered`);
            return;
        }
        inputPlugins.set(plugin.id, plugin);
        console.log(`Registered input plugin: ${plugin.name} (${plugin.id})`);
    },

    unregisterInputPlugin(id: string): boolean {
        const plugin = inputPlugins.get(id);
        if (plugin) {
            plugin.dispose();
            inputPlugins.delete(id);
            console.log(`Unregistered input plugin: ${id}`);
            return true;
        }
        return false;
    },

    registerDemosaicPlugin(plugin: DemosaicPlugin): void {
        if (demosaicPlugins.has(plugin.id)) {
            console.warn(`Demosaic plugin with id "${plugin.id}" is already registered`);
            return;
        }
        demosaicPlugins.set(plugin.id, plugin);
        console.log(`Registered demosaic plugin: ${plugin.name} (${plugin.id})`);
    },

    unregisterDemosaicPlugin(id: string): boolean {
        const deleted = demosaicPlugins.delete(id);
        if (deleted) {
            console.log(`Unregistered demosaic plugin: ${id}`);
        }
        return deleted;
    },

    get apiVersion(): string {
        return API_VERSION;
    },
};

/**
 * Get registered input plugins
 */
export function getInputPlugins(): InputPlugin[] {
    return Array.from(inputPlugins.values());
}

/**
 * Get registered demosaic plugins
 */
export function getDemosaicPlugins(): DemosaicPlugin[] {
    return Array.from(demosaicPlugins.values());
}

/**
 * Find an input plugin that can handle the given file
 */
export function findInputPlugin(extension: string, data?: Uint8Array): InputPlugin | undefined {
    const ext = extension.toLowerCase().replace(/^\./, '');
    for (const plugin of inputPlugins.values()) {
        if (plugin.canHandle(ext, data)) {
            return plugin;
        }
    }
    return undefined;
}

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): DctlWorkbenchApi {
    console.log('dctl-workbench is now active');

    // Register DCTL Diagnostics Provider (using native DCTL parser)
    const dctlDiagnosticsProvider = new DctlNativeDiagnosticsProvider(context.extensionPath);
    context.subscriptions.push(dctlDiagnosticsProvider);

    // Register DCTL Hover Provider
    const dctlHoverProvider = vscode.languages.registerHoverProvider(
        { language: 'dctl', scheme: 'file' },
        new DctlHoverProvider()
    );
    context.subscriptions.push(dctlHoverProvider);

    // Register DCTL Completion Provider
    const dctlCompletionProvider = vscode.languages.registerCompletionItemProvider(
        { language: 'dctl', scheme: 'file' },
        new DctlCompletionProvider(),
        ...COMPLETION_TRIGGER_CHARACTERS
    );
    context.subscriptions.push(dctlCompletionProvider);

    // Register EXR Custom Editor
    const exrEditorProvider = new ExrEditorProvider(context);
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            ExrEditorProvider.viewType,
            exrEditorProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    // Register commands
    const openPreviewCommand = vscode.commands.registerCommand(
        'dctlWorkbench.openPreview',
        async () => {
            // Get current active DCTL file
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || !activeEditor.document.fileName.endsWith('.dctl')) {
                vscode.window.showWarningMessage('Please open a DCTL file first');
                return;
            }

            const dctlPath = activeEditor.document.fileName;
            const dctlName = dctlPath.split(/[/\\]/).pop() || dctlPath;

            // Get active EXR viewer panels
            const activePanels = exrEditorProvider.getActivePanels();

            if (activePanels.length === 0) {
                // No EXR viewer open - prompt to open one
                const result = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'EXR Files': ['exr'],
                        'All Files': ['*'],
                    },
                    title: 'Select EXR file for DCTL preview',
                });

                if (result && result.length > 0) {
                    await exrEditorProvider.openExrWithDctl(result[0].fsPath, dctlPath);
                }
            } else if (activePanels.length === 1) {
                // One viewer - load directly
                await exrEditorProvider.loadDctlIntoPanel(activePanels[0].panel, dctlPath);
                // Focus the panel
                activePanels[0].panel.reveal();
                vscode.window.showInformationMessage(`Loaded ${dctlName} into EXR viewer`);
            } else {
                // Multiple viewers - show QuickPick
                const items = activePanels.map((p, index) => ({
                    label: p.documentName,
                    description: p.documentPath,
                    detail: index === 0 ? '(most recently active)' : undefined,
                    panel: p.panel,
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select EXR viewer to load DCTL into',
                    title: `Load ${dctlName}`,
                });

                if (selected) {
                    await exrEditorProvider.loadDctlIntoPanel(selected.panel, dctlPath);
                    selected.panel.reveal();
                    vscode.window.showInformationMessage(`Loaded ${dctlName} into ${selected.label}`);
                }
            }
        }
    );

    context.subscriptions.push(openPreviewCommand);

    // Register "Copy to DaVinci Resolve" command
    const copyToResolveCommand = vscode.commands.registerCommand(
        'dctlWorkbench.copyToResolve',
        async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || !activeEditor.document.fileName.endsWith('.dctl')) {
                vscode.window.showWarningMessage('Please open a DCTL file first');
                return;
            }

            const srcPath = activeEditor.document.fileName;
            const fileName = path.basename(srcPath);

            // Get configured directory or use OS default
            const config = vscode.workspace.getConfiguration('dctlWorkbench.editor');
            let destDir = config.get<string>('resolveDctlDirectory', '');

            if (!destDir) {
                switch (process.platform) {
                    case 'darwin':
                        destDir = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/DCTL';
                        break;
                    case 'win32':
                        destDir = 'C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\LUT\\DCTL';
                        break;
                    default:
                        destDir = '/opt/resolve/LUT/DCTL';
                        break;
                }
            }

            if (!fs.existsSync(destDir)) {
                const action = await vscode.window.showWarningMessage(
                    `DaVinci Resolve LUT directory not found: ${destDir}`,
                    'Create Directory',
                    'Choose Directory'
                );

                if (action === 'Create Directory') {
                    try {
                        fs.mkdirSync(destDir, { recursive: true });
                    } catch (e) {
                        vscode.window.showErrorMessage(
                            `Failed to create directory: ${(e as Error).message}`
                        );
                        return;
                    }
                } else if (action === 'Choose Directory') {
                    const chosen = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        title: 'Select DaVinci Resolve LUT directory',
                    });
                    if (!chosen || chosen.length === 0) {
                        return;
                    }
                    destDir = chosen[0].fsPath;
                    await config.update('resolveDctlDirectory', destDir, vscode.ConfigurationTarget.Global);
                } else {
                    return;
                }
            }

            const destPath = path.join(destDir, fileName);

            try {
                // Save the document first if it has unsaved changes
                if (activeEditor.document.isDirty) {
                    await activeEditor.document.save();
                }
                fs.copyFileSync(srcPath, destPath);
                vscode.window.showInformationMessage(`Copied ${fileName} to DaVinci Resolve`);
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Failed to copy: ${(e as Error).message}`
                );
            }
        }
    );
    context.subscriptions.push(copyToResolveCommand);

    // Register test commands for E2E testing
    // These commands allow tests to control the EXR viewer programmatically
    const loadDctlCommand = vscode.commands.registerCommand(
        'exrViewer.loadDctl',
        async (dctlPath: string) => {
            const activePanels = exrEditorProvider.getActivePanels();
            if (activePanels.length === 0) {
                throw new Error('No active EXR viewer panel');
            }
            await exrEditorProvider.loadDctlIntoPanel(activePanels[0].panel, dctlPath);
            return true;
        }
    );
    context.subscriptions.push(loadDctlCommand);

    const toggleRgcCommand = vscode.commands.registerCommand(
        'exrViewer.toggleRgc',
        async (enabled: boolean, peakLuminance?: number) => {
            const activePanels = exrEditorProvider.getActivePanels();
            if (activePanels.length === 0) {
                throw new Error('No active EXR viewer panel');
            }
            await exrEditorProvider.toggleRgc(activePanels[0].panel, enabled, peakLuminance ?? 100);
            return true;
        }
    );
    context.subscriptions.push(toggleRgcCommand);

    const exportExrCommand = vscode.commands.registerCommand(
        'exrViewer.exportExr',
        async (outputPath: string) => {
            const activePanels = exrEditorProvider.getActivePanels();
            if (activePanels.length === 0) {
                throw new Error('No active EXR viewer panel');
            }
            return await exrEditorProvider.exportToPath(activePanels[0].panel, outputPath);
        }
    );
    context.subscriptions.push(exportExrCommand);

    // Return API for plugin extensions
    return api;
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
    // Dispose all input plugins
    for (const plugin of inputPlugins.values()) {
        try {
            plugin.dispose();
        } catch (e) {
            console.error(`Error disposing plugin ${plugin.id}:`, e);
        }
    }
    inputPlugins.clear();
    demosaicPlugins.clear();

    console.log('dctl-workbench deactivated');
}
