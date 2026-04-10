/**
 * ExrEditorProvider — Message handler tests (Group 3 of A0.1).
 *
 * Verifies that webview → extension message handlers produce the
 * correct side effects: messages posted back to the webview,
 * error/warning dialogs, and state mutations observable through
 * subsequent handler behavior.
 *
 * All WASM-dependent modules (OCIO, OpenEXR, shader compiler) are
 * stubbed via proxyquire so no real WASM binaries are needed.
 */

import { strict as assert } from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Spy tracking — captures side effects for assertions
// ---------------------------------------------------------------------------

const spy = {
    errorMessages: [] as string[],
    warningMessages: [] as string[],
    infoMessages: [] as string[],
    logMessages: [] as string[],
    reset() {
        this.errorMessages.length = 0;
        this.warningMessages.length = 0;
        this.infoMessages.length = 0;
        this.logMessages.length = 0;
    },
};

// ---------------------------------------------------------------------------
// Stubs (self-contained — see Group 1/2 comment)
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
// Module stubs injected via proxyquire
// ---------------------------------------------------------------------------

const vscodeMock = {
    '@noCallThru': true,
    '@global': true,
    EventEmitter: FakeEventEmitter,
    Uri: FakeUri,
    workspace: {
        getConfiguration: () => ({
            get: (_k: string, d?: unknown) => d,
            has: () => false,
            update: async () => undefined,
        }),
        createFileSystemWatcher: () => {
            const e = new FakeEventEmitter<FakeUri>();
            return { onDidChange: e.event, onDidCreate: e.event, onDidDelete: e.event, dispose: () => e.dispose() };
        },
        fs: { readFile: async () => { throw new Error('not stubbed'); } },
        onDidChangeConfiguration: new FakeEventEmitter<void>().event,
    },
    window: {
        showInformationMessage: async (msg: string) => { spy.infoMessages.push(msg); },
        showWarningMessage: async (msg: string) => { spy.warningMessages.push(msg); },
        showErrorMessage: async (msg: string) => { spy.errorMessages.push(msg); },
        showOpenDialog: async () => undefined as unknown,
        showSaveDialog: async () => undefined,
        onDidChangeVisibleTextEditors: new FakeEventEmitter<void>().event,
        visibleTextEditors: [],
        tabGroups: { onDidChangeTabs: new FakeEventEmitter<void>().event, all: [] },
    },
    commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => undefined },
    languages: {
        registerHoverProvider: () => ({ dispose: () => {} }),
        registerCompletionItemProvider: () => ({ dispose: () => {} }),
        createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }),
    },
    Disposable: { from: (...ds: any[]) => ({ dispose: () => ds.forEach((d: any) => d.dispose?.()) }) },
    CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }; cancel() {} dispose() {} },
    TabInputText: class { readonly uri: FakeUri; constructor(uri: FakeUri) { this.uri = uri; } },
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
        success: true, wgslCode: '// wgsl stub', computeWgslCode: '// compute stub', bindings: [],
    }),
    buildIntegratedShader: async () => ({
        success: true,
        wgslCode: '// integrated wgsl',
        computeWgslCode: '// integrated compute',
        glslCode: '// integrated glsl',
        bindings: [],
        dctlBindings: [],
        dctlDefaults: {},
        paramMapping: [],
        useUniformBuffer: true,
        uniformBufferBinding: 5,
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
                compressionName: 'ZIP',
                pixelTypeName: 'HALF',
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
        expandedSource: '// preprocessed DCTL',
        params: [
            { name: 'gain', type: 'float', default: 1.0, min: 0.0, max: 10.0, label: 'Gain' },
        ],
        includedFiles: [],
        errors: [],
    }),
};

const dctlTypesStub = {
    '@noCallThru': true,
    '@global': true,
    createDctlInfo: (_source: string, colorSpace: string, params: any[], filePath: string) => ({
        expandedSource: '// dctl info',
        workingColorSpace: colorSpace,
        params,
        filePath,
    }),
};

const fsStub = {
    '@global': true,
    readFileSync: (_path: string, encoding?: string) => {
        if (encoding === 'utf-8') return '// DCTL source';
        return Buffer.from([0x76, 0x2f, 0x31, 0x01]);
    },
    promises: {
        readFile: async (_path: string, _encoding?: string) => '// DCTL source',
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
// Load ExrEditorProvider with all stubs injected
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

/** Open a panel and send 'ready' to initialize OCIO state + image. */
async function openReadyPanel(provider: any, filePath: string) {
    const { doc, panel } = await openPanel(provider, filePath);
    panel.simulateReceiveMessage({ type: 'ready' });
    await flushAsync();
    return { doc, panel, readyMsgCount: panel.messages.length };
}

// ---------------------------------------------------------------------------
// Tests — Group 3: Message handlers
// ---------------------------------------------------------------------------

describe('ExrEditorProvider — message handlers', () => {
    let provider: any;
    let panel: ReturnType<typeof createMockWebviewPanel>;
    let readyMsgCount: number;

    beforeEach(async () => {
        spy.reset();
        vscodeMock.window.showOpenDialog = async () => undefined as unknown;
        provider = new ExrEditorProvider(createMockContext());
        const result = await openReadyPanel(provider, '/tmp/test.exr');
        panel = result.panel;
        readyMsgCount = result.readyMsgCount;
    });

    afterEach(() => {
        panel.dispose();
    });

    function newMessages(): any[] {
        return (panel.messages as any[]).slice(readyMsgCount);
    }

    // -----------------------------------------------------------------------
    // ready
    // -----------------------------------------------------------------------

    describe('ready', () => {
        it('sends startLoading followed by loadImage', () => {
            const types = (panel.messages as any[]).map((m: any) => m.type);
            assert.equal(types[0], 'startLoading');
            assert.equal(types[1], 'loadImage');
        });

        it('loadImage includes correct dimensions and color space', () => {
            const msg = (panel.messages as any[]).find((m: any) => m.type === 'loadImage');
            assert.equal(msg.data.width, 1920);
            assert.equal(msg.data.height, 1080);
            assert.equal(msg.data.channels, 4);
            assert.equal(msg.data.colorSpace, 'ACES2065-1');
            assert.equal(msg.data.colorSpaceDetected, true);
        });

        it('loadImage includes OCIO displays/views and WGSL shader info', () => {
            const msg = (panel.messages as any[]).find((m: any) => m.type === 'loadImage');
            assert.deepEqual(msg.data.displays, ['sRGB']);
            assert.equal(msg.data.defaultDisplay, 'sRGB');
            assert.ok(msg.data.wgslShaderInfo, 'should include wgslShaderInfo');
            assert.ok(msg.data.wgslShaderInfo.wgslCode);
        });

        it('sends openDctlFiles list to webview', () => {
            const msg = (panel.messages as any[]).find((m: any) => m.type === 'openDctlFiles');
            assert.ok(msg, 'should send openDctlFiles');
            assert.deepEqual(msg.files, []);
        });
    });

    // -----------------------------------------------------------------------
    // setDisplayTransform
    // -----------------------------------------------------------------------

    describe('setDisplayTransform', () => {
        it('sends updateShader with new OCIO transform', async () => {
            panel.simulateReceiveMessage({
                type: 'setDisplayTransform',
                source: 'ACEScg',
                display: 'sRGB',
                view: 'ACES 1.0 - SDR Video',
            });
            await flushAsync();

            const msgs = newMessages();
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'));
        });
    });

    // -----------------------------------------------------------------------
    // selectDctlFile
    // -----------------------------------------------------------------------

    describe('selectDctlFile', () => {
        it('loads the selected DCTL file', async () => {
            vscodeMock.window.showOpenDialog = async () => [FakeUri.file('/tmp/chosen.dctl')];

            panel.simulateReceiveMessage({ type: 'selectDctlFile' });
            await flushAsync();

            const msgs = newMessages();
            assert.ok(msgs.some((m: any) => m.type === 'loadDctl'), 'should send loadDctl');
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'), 'should send updateShader');
        });

        it('does nothing when the user cancels the dialog', async () => {
            vscodeMock.window.showOpenDialog = async () => undefined as unknown;
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'selectDctlFile' });
            await flushAsync();

            assert.equal(panel.messages.length, countBefore);
        });
    });

    // -----------------------------------------------------------------------
    // loadDctlFromPath
    // -----------------------------------------------------------------------

    describe('loadDctlFromPath', () => {
        it('sends loadDctl and updateShader messages', async () => {
            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/test.dctl' });
            await flushAsync();

            const msgs = newMessages();
            const types = msgs.map((m: any) => m.type);
            assert.ok(types.includes('loadDctl'));
            assert.ok(types.includes('updateShader'));
        });

        it('loadDctl message includes filePath, params, and enabled state', async () => {
            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/test.dctl' });
            await flushAsync();

            const msg = newMessages().find((m: any) => m.type === 'loadDctl');
            assert.ok(msg);
            assert.equal(msg.dctl.filePath, '/tmp/test.dctl');
            assert.equal(msg.dctl.enabled, true);
            assert.ok(Array.isArray(msg.dctl.params));
            assert.equal(msg.dctl.params.length, 1);
            assert.equal(msg.dctl.params[0].name, 'gain');
        });

        it('ignores message with no path', async () => {
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath' });
            await flushAsync();

            assert.equal(panel.messages.length, countBefore);
        });
    });

    // -----------------------------------------------------------------------
    // toggleDctl
    // -----------------------------------------------------------------------

    describe('toggleDctl', () => {
        it('enabled=true triggers shader rebuild', async () => {
            panel.simulateReceiveMessage({ type: 'toggleDctl', enabled: true });
            await flushAsync();

            assert.ok(newMessages().some((m: any) => m.type === 'updateShader'));
        });

        it('enabled=false triggers shader rebuild', async () => {
            panel.simulateReceiveMessage({ type: 'toggleDctl', enabled: false });
            await flushAsync();

            assert.ok(newMessages().some((m: any) => m.type === 'updateShader'));
        });
    });

    // -----------------------------------------------------------------------
    // toggleRgc
    // -----------------------------------------------------------------------

    describe('toggleRgc', () => {
        it('enabled=true triggers shader rebuild', async () => {
            panel.simulateReceiveMessage({ type: 'toggleRgc', enabled: true });
            await flushAsync();

            assert.ok(newMessages().some((m: any) => m.type === 'updateShader'));
        });

        it('stores peakLuminance when provided', async () => {
            panel.simulateReceiveMessage({ type: 'toggleRgc', enabled: true, peakLuminance: 500 });
            await flushAsync();

            assert.ok(spy.logMessages.some(m => m.includes('500')));
        });
    });

    // -----------------------------------------------------------------------
    // updateRgcSettings
    // -----------------------------------------------------------------------

    describe('updateRgcSettings', () => {
        it('rebuilds shader when RGC is enabled', async () => {
            // Enable RGC first
            panel.simulateReceiveMessage({ type: 'toggleRgc', enabled: true });
            await flushAsync();
            const countAfterToggle = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'updateRgcSettings', peakLuminance: 1000 });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countAfterToggle);
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'), 'should rebuild when RGC enabled');
        });

        it('does NOT rebuild shader when RGC is disabled', async () => {
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'updateRgcSettings', peakLuminance: 1000 });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(!msgs.some((m: any) => m.type === 'updateShader'), 'should not rebuild');
        });
    });

    // -----------------------------------------------------------------------
    // changeDctlColorSpace
    // -----------------------------------------------------------------------

    describe('changeDctlColorSpace', () => {
        it('triggers shader rebuild', async () => {
            panel.simulateReceiveMessage({ type: 'changeDctlColorSpace', colorSpace: 'ACEScg' });
            await flushAsync();

            assert.ok(newMessages().some((m: any) => m.type === 'updateShader'));
            assert.ok(spy.logMessages.some(m => m.includes('ACEScg')));
        });
    });

    // -----------------------------------------------------------------------
    // updateDctlParam
    // -----------------------------------------------------------------------

    describe('updateDctlParam', () => {
        it('uses fast path when hasDctlSupport is true', async () => {
            panel.simulateReceiveMessage({ type: 'shaderBuildResult', hasDctlSupport: true });
            await flushAsync();
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'updateDctlParam', name: 'gain', value: 2.5 });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            const fastMsg = msgs.find((m: any) => m.type === 'updateDctlParamFast');
            assert.ok(fastMsg, 'should use fast path');
            assert.equal(fastMsg.name, 'gain');
            assert.equal(fastMsg.value, 2.5);
        });

        it('uses slow path (shader rebuild) when hasDctlSupport is false', async () => {
            // hasDctlSupport defaults to false
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({ type: 'updateDctlParam', name: 'gain', value: 3.0 });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'), 'should use slow path');
            assert.ok(!msgs.some((m: any) => m.type === 'updateDctlParamFast'), 'should not use fast path');
        });
    });

    // -----------------------------------------------------------------------
    // shaderBuildResult
    // -----------------------------------------------------------------------

    describe('shaderBuildResult', () => {
        it('enables fast path for subsequent updateDctlParam', async () => {
            // Before: slow path (hasDctlSupport defaults to false)
            let countBefore = panel.messages.length;
            panel.simulateReceiveMessage({ type: 'updateDctlParam', name: 'x', value: 1 });
            await flushAsync();
            let msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'updateShader'), 'slow path before');

            // Set hasDctlSupport
            panel.simulateReceiveMessage({ type: 'shaderBuildResult', hasDctlSupport: true });
            await flushAsync();

            // After: fast path
            countBefore = panel.messages.length;
            panel.simulateReceiveMessage({ type: 'updateDctlParam', name: 'x', value: 2 });
            await flushAsync();
            msgs = (panel.messages as any[]).slice(countBefore);
            assert.ok(msgs.some((m: any) => m.type === 'updateDctlParamFast'), 'fast path after');
        });
    });

    // -----------------------------------------------------------------------
    // log / error
    // -----------------------------------------------------------------------

    describe('log', () => {
        it('forwards webview log message to writeLog', async () => {
            panel.simulateReceiveMessage({ type: 'log', message: 'test-log-12345' });
            await flushAsync();

            assert.ok(spy.logMessages.some(m => m.includes('test-log-12345')));
        });
    });

    describe('error', () => {
        it('shows error message dialog', async () => {
            panel.simulateReceiveMessage({ type: 'error', message: 'render failure' });
            await flushAsync();

            assert.ok(spy.errorMessages.some(m => m.includes('render failure')));
        });
    });

    // -----------------------------------------------------------------------
    // rgcPixelVerification
    // -----------------------------------------------------------------------

    describe('rgcPixelVerification', () => {
        it('shows warning when output is black', async () => {
            panel.simulateReceiveMessage({
                type: 'rgcPixelVerification',
                isBlack: true,
                pixels: [0, 0, 0, 0, 0, 0, 0, 0],
                hasFullRgc: true,
            });
            await flushAsync();

            assert.ok(spy.warningMessages.length > 0, 'should show warning');
            assert.ok(spy.warningMessages[0].includes('BLACK'));
        });

        it('does not show warning when output has content', async () => {
            const warningsBefore = spy.warningMessages.length;

            panel.simulateReceiveMessage({
                type: 'rgcPixelVerification',
                isBlack: false,
                pixels: [0.5, 0.3, 0.2, 1.0, 0.5, 0.3, 0.2, 1.0],
                hasFullRgc: true,
            });
            await flushAsync();

            assert.equal(spy.warningMessages.length, warningsBefore, 'no warning expected');
        });
    });
});
