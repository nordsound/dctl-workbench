/**
 * ExrEditorProvider — Supplemental tests (A0.7).
 *
 * Covers functionality not exercised by A0.1 Groups 1-5:
 * - DCTL hot reload via file watcher
 * - Open DCTL file detection (editors + tabs)
 * - Editor/tab change listeners → automatic openDctlFiles updates
 * - loadDctlIntoPanel public API
 * - getHtmlForWebview (nonce, CSP, URIs)
 * - Default DCTL state configuration
 */

import { strict as assert } from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Spy tracking
// ---------------------------------------------------------------------------

const spy = {
    errorMessages: [] as string[],
    warningMessages: [] as string[],
    logMessages: [] as string[],
    fileWatcherDisposals: 0,
    reset() {
        this.errorMessages.length = 0;
        this.warningMessages.length = 0;
        this.logMessages.length = 0;
        this.fileWatcherDisposals = 0;
    },
};

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                const idx = this.listeners.indexOf(listener);
                if (idx !== -1) this.listeners.splice(idx, 1);
            },
        };
    };
    fire(data: T): void {
        for (const fn of this.listeners.slice()) fn(data);
    }
    dispose(): void { this.listeners = []; }
}

class FakeUri {
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    private constructor(scheme: string, path: string, fsPath: string) {
        this.scheme = scheme;
        this.path = path;
        this.fsPath = fsPath;
    }
    static file(p: string): FakeUri { return new FakeUri('file', p, p); }
    static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
        const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
        return new FakeUri(base.scheme, joined, joined);
    }
    toString(): string { return `${this.scheme}://${this.path}`; }
}

/** File system watcher that exposes its change emitter for testing. */
function createFakeFileSystemWatcher() {
    const changeEmitter = new FakeEventEmitter<FakeUri>();
    const createEmitter = new FakeEventEmitter<FakeUri>();
    const deleteEmitter = new FakeEventEmitter<FakeUri>();
    return {
        watcher: {
            onDidChange: changeEmitter.event,
            onDidCreate: createEmitter.event,
            onDidDelete: deleteEmitter.event,
            dispose: () => {
                spy.fileWatcherDisposals++;
                changeEmitter.dispose();
                createEmitter.dispose();
                deleteEmitter.dispose();
            },
        },
        fireChange: (uri: FakeUri) => changeEmitter.fire(uri),
        fireCreate: (uri: FakeUri) => createEmitter.fire(uri),
    };
}

/** Track all created file watchers so tests can fire events on them. */
let latestWatcher: ReturnType<typeof createFakeFileSystemWatcher> | null = null;

function createMockWebviewPanel() {
    const disposeEmitter = new FakeEventEmitter<void>();
    const viewStateEmitter = new FakeEventEmitter<{ webviewPanel: unknown }>();
    const messageEmitter = new FakeEventEmitter<unknown>();
    const messages: unknown[] = [];
    let disposed = false;

    const panel = {
        viewType: 'dctlWorkbench.exrEditor',
        active: true,
        visible: true,
        webview: {
            html: '',
            options: {} as Record<string, unknown>,
            cspSource: 'vscode-webview://mock',
            asWebviewUri: (uri: FakeUri) => uri,
            postMessage: async (msg: unknown) => { messages.push(msg); return true; },
            onDidReceiveMessage: messageEmitter.event,
        },
        onDidDispose: disposeEmitter.event,
        onDidChangeViewState: viewStateEmitter.event,
        reveal: () => {},
        dispose: () => {
            if (disposed) return;
            disposed = true;
            disposeEmitter.fire();
            disposeEmitter.dispose();
            viewStateEmitter.dispose();
            messageEmitter.dispose();
        },
        messages,
        simulateReceiveMessage: (msg: unknown) => messageEmitter.fire(msg),
        simulateChangeViewState: (opts: { active?: boolean }) => {
            if (opts.active !== undefined) panel.active = opts.active;
            viewStateEmitter.fire({ webviewPanel: panel });
        },
        get isDisposed() { return disposed; },
    };
    return panel;
}

function createMockContext(extensionPath = '/mock/dctl-workbench') {
    return {
        subscriptions: [] as Array<{ dispose(): void }>,
        extensionPath,
        extensionUri: FakeUri.file(extensionPath),
        globalStorageUri: FakeUri.file(`${extensionPath}/globalStorage`),
        storageUri: FakeUri.file(`${extensionPath}/storage`),
        workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] },
        globalState: { get: () => undefined, update: async () => undefined, keys: () => [] },
        asAbsolutePath: (rel: string) => `${extensionPath}/${rel}`,
    };
}

// ---------------------------------------------------------------------------
// Module stubs — overridable per-test
// ---------------------------------------------------------------------------

const visibleTextEditorsEmitter = new FakeEventEmitter<void>();
const tabChangesEmitter = new FakeEventEmitter<void>();

/** Mutable list of visible editors — tests can modify this to simulate editor state. */
let mockVisibleEditors: Array<{ document: { fileName: string } }> = [];

/** Mutable list of tab groups — tests can modify to simulate tab state. */
let mockTabGroups: Array<{ tabs: Array<{ input: any }> }> = [];

const vscodeMock = {
    '@noCallThru': true,
    '@global': true,
    EventEmitter: FakeEventEmitter,
    Uri: FakeUri,
    workspace: {
        getConfiguration: (_section?: string) => ({
            get: (_k: string, d?: unknown) => d,
            has: () => false,
            update: async () => undefined,
        }),
        createFileSystemWatcher: () => {
            const w = createFakeFileSystemWatcher();
            latestWatcher = w;
            return w.watcher;
        },
        fs: { readFile: async () => { throw new Error('not stubbed'); } },
        onDidChangeConfiguration: new FakeEventEmitter<void>().event,
    },
    window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: async (msg: string) => { spy.warningMessages.push(msg); },
        showErrorMessage: async (msg: string) => { spy.errorMessages.push(msg); },
        showOpenDialog: async () => undefined,
        showSaveDialog: async () => undefined,
        onDidChangeVisibleTextEditors: visibleTextEditorsEmitter.event,
        get visibleTextEditors() { return mockVisibleEditors; },
        tabGroups: {
            onDidChangeTabs: tabChangesEmitter.event,
            get all() { return mockTabGroups; },
        },
    },
    commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => undefined },
    languages: {
        registerHoverProvider: () => ({ dispose: () => {} }),
        registerCompletionItemProvider: () => ({ dispose: () => {} }),
        createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }),
    },
    Disposable: { from: (...ds: any[]) => ({ dispose: () => ds.forEach((d: any) => d.dispose?.()) }) },
    CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }; cancel() {} dispose() {} },
    TabInputText: class {
        readonly uri: FakeUri;
        constructor(uri: FakeUri) { this.uri = uri; }
    },
};

const coreStub = {
    '@noCallThru': true,
    '@global': true,
    initOCIO: async () => {},
    OCIOProcessor: class {
        init() {}
        getColorSpaces() { return ['ACES2065-1', 'ACEScg', 'sRGB - Texture']; }
        getDisplays() { return ['sRGB']; }
        getViews() { return ['ACES 1.0 - SDR Video']; }
        createDisplayTransform() {}
        setupGpuProcessor() {}
        extractGpuShaderInfo() {
            return { shaderText: 'void main() {}', textures: [], textures3D: [], uniforms: [] };
        }
        dispose() {}
    },
    setWasmDirectory: () => {},
    DctlRuntime: class { async init() {} async writeExr() {} },
};

const shaderStub = {
    '@noCallThru': true,
    '@global': true,
    buildWgslShader: async () => ({
        success: true, wgslCode: '// wgsl', computeWgslCode: '// compute', bindings: [],
    }),
    buildIntegratedShader: async () => ({
        success: true, wgslCode: '// integrated', computeWgslCode: '// compute',
        glslCode: '// glsl', bindings: [], dctlBindings: [], dctlDefaults: {},
        paramMapping: [], useUniformBuffer: true, uniformBufferBinding: 5,
        dctlComputeShaderInfo: null,
    }),
    buildDctlExportShader: async () => ({
        success: true, wgslCode: '// export', bindings: [],
        rgcTextures: [], rgcTextures3D: [],
    }),
};

const exrStub = {
    '@noCallThru': true,
    '@global': true,
    EXRReader: class {
        read() {
            return {
                width: 1920, height: 1080,
                channels: ['R', 'G', 'B'],
                pixels: new Float32Array(1920 * 1080 * 3),
                chromaticities: {
                    redX: 0.7347, redY: 0.2653, greenX: 0.0, greenY: 1.0,
                    blueX: 0.0001, blueY: -0.077, whiteX: 0.32168, whiteY: 0.33767,
                },
                compressionName: 'ZIP', pixelTypeName: 'HALF',
            };
        }
        dispose() {}
    },
    EXRWriter: class { write() { return new Uint8Array(100); } dispose() {} },
    Compression: {},
    PixelType: { HALF: 1 },
    identifyColorSpace: () => 'ACES2065-1',
    initOpenEXR: async () => ({}),
    setOpenEXRWasmDirectory: () => {},
    isOpenEXRInitialized: () => true,
};

const preprocessorStub = {
    '@noCallThru': true,
    '@global': true,
    preprocessDctlSource: async () => ({
        success: true,
        expandedSource: '// preprocessed',
        params: [{ name: 'gain', type: 'float', default: 1.0, min: 0.0, max: 10.0, label: 'Gain' }],
        includedFiles: ['/tmp/include.h'],
        errors: [],
    }),
};

const dctlTypesStub = {
    '@noCallThru': true,
    '@global': true,
    createDctlInfo: (_source: string, colorSpace: string, params: any[], filePath: string) => ({
        expandedSource: '// dctl info', workingColorSpace: colorSpace, params, filePath,
    }),
};

const fsStub = {
    '@global': true,
    readFileSync: (_path: string, encoding?: string) => {
        if (encoding === 'utf-8') return '// DCTL source';
        return Buffer.from([0x76, 0x2f, 0x31, 0x01]);
    },
    writeFileSync: () => {},
    existsSync: () => true,
};

const loggerStub = {
    '@noCallThru': true,
    '@global': true,
    initLog: () => {},
    writeLog: (msg: string) => { spy.logMessages.push(msg); },
};

// ---------------------------------------------------------------------------
// Load ExrEditorProvider
// ---------------------------------------------------------------------------

const { ExrEditorProvider } = proxyquire('../../editor/ExrEditorProvider', {
    'vscode': vscodeMock,
    '@dctl-workbench/core': coreStub,
    '../shader': shaderStub,
    '../exr': exrStub,
    '../dctl/preprocessor': preprocessorStub,
    '../dctl/types': dctlTypesStub,
    'fs': fsStub,
    '../shared/logger': loggerStub,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushAsync(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

async function openPanel(provider: any, filePath: string) {
    const uri = FakeUri.file(filePath);
    const token = new vscodeMock.CancellationTokenSource().token;
    const doc = await provider.openCustomDocument(uri, {}, token);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, token);
    return { doc, panel };
}

async function openReadyPanel(provider: any, filePath: string) {
    const { doc, panel } = await openPanel(provider, filePath);
    panel.simulateReceiveMessage({ type: 'ready' });
    await flushAsync();
    return { doc, panel };
}

// ---------------------------------------------------------------------------
// Tests — A0.7: Supplemental coverage
// ---------------------------------------------------------------------------

describe('ExrEditorProvider — supplemental (A0.7)', () => {
    afterEach(() => {
        spy.reset();
        mockVisibleEditors = [];
        mockTabGroups = [];
        latestWatcher = null;
    });

    // -----------------------------------------------------------------------
    // DCTL hot reload via file watcher
    // -----------------------------------------------------------------------

    describe('DCTL hot reload', () => {
        it('file change triggers DCTL reload', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/test.dctl' });
            await flushAsync();

            const watcher = latestWatcher;
            assert.ok(watcher, 'file watcher should be created');

            const countBefore = panel.messages.length;
            watcher!.fireChange(FakeUri.file('/tmp/test.dctl'));
            await flushAsync();

            // Should re-send loadDctl and updateShader
            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'loadDctl'), 'should reload DCTL');
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'), 'should rebuild shader');
            panel.dispose();
        });

        it('file create also triggers reload', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/test.dctl' });
            await flushAsync();

            const watcher = latestWatcher;
            const countBefore = panel.messages.length;
            watcher!.fireCreate(FakeUri.file('/tmp/test.dctl'));
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'loadDctl'));
            panel.dispose();
        });

        it('loading a new DCTL disposes the old watcher', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/first.dctl' });
            await flushAsync();
            const firstDisposals = spy.fileWatcherDisposals;

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/second.dctl' });
            await flushAsync();

            assert.ok(spy.fileWatcherDisposals > firstDisposals,
                'old watcher should be disposed when loading new DCTL');
            panel.dispose();
        });

        it('panel dispose cleans up file watcher', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/test.dctl' });
            await flushAsync();
            const disposalsBefore = spy.fileWatcherDisposals;

            panel.dispose();

            assert.ok(spy.fileWatcherDisposals > disposalsBefore,
                'file watcher should be disposed with panel');
        });
    });

    // -----------------------------------------------------------------------
    // Open DCTL file detection
    // -----------------------------------------------------------------------

    describe('open DCTL file detection', () => {
        it('detects DCTL files from visible text editors', async () => {
            mockVisibleEditors = [
                { document: { fileName: '/tmp/color.dctl' } },
                { document: { fileName: '/tmp/code.ts' } },
            ];

            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            const openDctlMsg = (panel.messages as any[]).find((m: any) => m.type === 'openDctlFiles');
            assert.ok(openDctlMsg);
            assert.equal(openDctlMsg.files.length, 1);
            assert.equal(openDctlMsg.files[0].path, '/tmp/color.dctl');
            assert.equal(openDctlMsg.files[0].name, 'color.dctl');
            panel.dispose();
        });

        it('detects DCTL files from tab groups', async () => {
            mockVisibleEditors = [];
            mockTabGroups = [{
                tabs: [
                    { input: new vscodeMock.TabInputText(FakeUri.file('/tmp/tab.dctl')) },
                    { input: new vscodeMock.TabInputText(FakeUri.file('/tmp/readme.md')) },
                ],
            }];

            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            const openDctlMsg = (panel.messages as any[]).find((m: any) => m.type === 'openDctlFiles');
            assert.ok(openDctlMsg);
            assert.equal(openDctlMsg.files.length, 1);
            assert.equal(openDctlMsg.files[0].path, '/tmp/tab.dctl');
            panel.dispose();
        });

        it('deduplicates between editors and tabs', async () => {
            mockVisibleEditors = [
                { document: { fileName: '/tmp/same.dctl' } },
            ];
            mockTabGroups = [{
                tabs: [
                    { input: new vscodeMock.TabInputText(FakeUri.file('/tmp/same.dctl')) },
                ],
            }];

            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            const openDctlMsg = (panel.messages as any[]).find((m: any) => m.type === 'openDctlFiles');
            assert.equal(openDctlMsg.files.length, 1, 'should deduplicate same path');
            panel.dispose();
        });

        it('handles tabs with non-TabInputText input gracefully', async () => {
            mockVisibleEditors = [];
            mockTabGroups = [{
                tabs: [
                    { input: { uri: FakeUri.file('/tmp/img.png') } },  // Not TabInputText
                    { input: new vscodeMock.TabInputText(FakeUri.file('/tmp/valid.dctl')) },
                ],
            }];

            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            const openDctlMsg = (panel.messages as any[]).find((m: any) => m.type === 'openDctlFiles');
            assert.equal(openDctlMsg.files.length, 1);
            assert.equal(openDctlMsg.files[0].path, '/tmp/valid.dctl');
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // Editor/tab change listeners
    // -----------------------------------------------------------------------

    describe('editor/tab change listeners', () => {
        it('visible editor change fires openDctlFiles update', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');
            const countBefore = panel.messages.length;

            // Simulate opening a .dctl editor
            mockVisibleEditors = [{ document: { fileName: '/tmp/new.dctl' } }];
            visibleTextEditorsEmitter.fire();
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            const dctlMsg = msgs.find((m: any) => m.type === 'openDctlFiles');
            assert.ok(dctlMsg, 'should send openDctlFiles on editor change');
            assert.equal(dctlMsg.files.length, 1);
            assert.equal(dctlMsg.files[0].path, '/tmp/new.dctl');
            panel.dispose();
        });

        it('tab change fires openDctlFiles update', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');
            const countBefore = panel.messages.length;

            mockTabGroups = [{
                tabs: [
                    { input: new vscodeMock.TabInputText(FakeUri.file('/tmp/added.dctl')) },
                ],
            }];
            tabChangesEmitter.fire();
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            const dctlMsg = msgs.find((m: any) => m.type === 'openDctlFiles');
            assert.ok(dctlMsg, 'should send openDctlFiles on tab change');
            assert.equal(dctlMsg.files[0].path, '/tmp/added.dctl');
            panel.dispose();
        });

        it('editor change subscriptions are cleaned up on panel dispose', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.dispose();

            // After dispose, firing editor changes should NOT crash
            // (subscriptions were cleaned up in onDidDispose handler)
            assert.doesNotThrow(() => {
                visibleTextEditorsEmitter.fire();
                tabChangesEmitter.fire();
            });
        });
    });

    // -----------------------------------------------------------------------
    // loadDctlIntoPanel public API
    // -----------------------------------------------------------------------

    describe('loadDctlIntoPanel', () => {
        it('loads DCTL via public API', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');
            const countBefore = panel.messages.length;

            await provider.loadDctlIntoPanel(panel, '/tmp/api.dctl');

            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'loadDctl'));
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'));
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // getHtmlForWebview
    // -----------------------------------------------------------------------

    describe('getHtmlForWebview', () => {
        it('HTML contains DOCTYPE and nonce', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/test.exr');

            assert.ok(panel.webview.html.includes('<!DOCTYPE html>'));
            assert.ok(panel.webview.html.includes('nonce-'));
            panel.dispose();
        });

        it('HTML contains Content-Security-Policy meta tag', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/test.exr');

            assert.ok(panel.webview.html.includes('Content-Security-Policy'));
            assert.ok(panel.webview.html.includes(panel.webview.cspSource));
            panel.dispose();
        });

        it('HTML includes script and style URIs', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/test.exr');

            assert.ok(panel.webview.html.includes('webview.js'));
            assert.ok(panel.webview.html.includes('exr-viewer.css'));
            panel.dispose();
        });

        it('each panel gets unique nonce', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel: panelA } = await openPanel(provider, '/tmp/a.exr');
            const { panel: panelB } = await openPanel(provider, '/tmp/b.exr');

            // Extract nonces from HTML
            const nonceA = panelA.webview.html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
            const nonceB = panelB.webview.html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
            assert.ok(nonceA);
            assert.ok(nonceB);
            assert.notEqual(nonceA, nonceB, 'each panel should have a unique nonce');
            panelA.dispose();
            panelB.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // Default DCTL state
    // -----------------------------------------------------------------------

    describe('default DCTL state', () => {
        it('new panel starts with DCTL disabled', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            // toggleDctl with enabled=false should not fail (state exists)
            panel.simulateReceiveMessage({ type: 'toggleDctl', enabled: false });
            await flushAsync();

            // The log should show the toggle
            assert.ok(spy.logMessages.some(m => m.includes('Toggle DCTL: false')));
            panel.dispose();
        });

        it('new panel starts with RGC disabled', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');
            const countBefore = panel.messages.length;

            // updateRgcSettings should NOT rebuild (RGC is disabled by default)
            panel.simulateReceiveMessage({ type: 'updateRgcSettings', peakLuminance: 500 });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(!msgs.some((m: any) => m.type === 'updateShader'),
                'should not rebuild shader when RGC is disabled');
            panel.dispose();
        });

        it('new panel starts with useUniformBuffer=true', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            // Set hasDctlSupport and send updateDctlParam → should use fast path
            panel.simulateReceiveMessage({ type: 'shaderBuildResult', hasDctlSupport: true });
            await flushAsync();
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'updateDctlParam', name: 'x', value: 1 });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'updateDctlParamFast'),
                'useUniformBuffer should be true by default → fast path');
            panel.dispose();
        });
    });
});
