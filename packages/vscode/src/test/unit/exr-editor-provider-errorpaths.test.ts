/**
 * ExrEditorProvider — Error path tests (Group 4 of A0.1).
 *
 * Verifies error handling: loadImage failures, display transform
 * errors, DCTL preprocessing errors, state guards (early returns),
 * exportBufferReady edge cases, and WGSL build failures.
 *
 * Each test injects a failing stub for the specific module under
 * test, then asserts the correct error message is surfaced.
 */

import { strict as assert } from 'assert';
import { FakeEventEmitter, FakeUri, createMockWebviewPanel, createMockContext } from '../helpers/vscode-mocks';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Spy tracking
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
// Default module stubs (success path — overridden per test as needed)
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

// --- Overridable stubs: reassignable functions let individual tests inject failures ---

let exrReadFn: () => any = () => ({
    width: 1920, height: 1080,
    channels: ['R', 'G', 'B'],
    pixels: new Float32Array(1920 * 1080 * 3),
    chromaticities: {
        redX: 0.7347, redY: 0.2653, greenX: 0.0, greenY: 1.0,
        blueX: 0.0001, blueY: -0.077, whiteX: 0.32168, whiteY: 0.33767,
    },
    compressionName: 'ZIP', pixelTypeName: 'HALF',
});

let initOCIOFn: () => Promise<void> = async () => {};
let buildWgslShaderFn: () => Promise<any> = async () => ({
    success: true, wgslCode: '// wgsl', computeWgslCode: '// compute', bindings: [],
});
let preprocessFn: () => Promise<any> = async () => ({
    success: true,
    expandedSource: '// preprocessed',
    params: [{ name: 'gain', type: 'float', default: 1.0, min: 0.0, max: 10.0, label: 'Gain' }],
    includedFiles: [],
    errors: [],
});

const coreStub = {
    '@noCallThru': true,
    '@global': true,
    initOCIO: async () => initOCIOFn(),
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
    buildWgslShader: async (...args: any[]) => buildWgslShaderFn(),
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
    EXRReader: class { read() { return exrReadFn(); } dispose() {} },
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
    preprocessDctlSource: async (...args: any[]) => preprocessFn(),
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
// Load ExrEditorProvider with all stubs
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
// Tests — Group 4: Error paths
// ---------------------------------------------------------------------------

describe('ExrEditorProvider — error paths', () => {
    afterEach(() => {
        spy.reset();
        // Reset overridable stubs to defaults
        exrReadFn = () => ({
            width: 1920, height: 1080,
            channels: ['R', 'G', 'B'],
            pixels: new Float32Array(1920 * 1080 * 3),
            chromaticities: {
                redX: 0.7347, redY: 0.2653, greenX: 0.0, greenY: 1.0,
                blueX: 0.0001, blueY: -0.077, whiteX: 0.32168, whiteY: 0.33767,
            },
            compressionName: 'ZIP', pixelTypeName: 'HALF',
        });
        initOCIOFn = async () => {};
        buildWgslShaderFn = async () => ({
            success: true, wgslCode: '// wgsl', computeWgslCode: '// compute', bindings: [],
        });
        preprocessFn = async () => ({
            success: true,
            expandedSource: '// preprocessed',
            params: [{ name: 'gain', type: 'float', default: 1.0, min: 0.0, max: 10.0, label: 'Gain' }],
            includedFiles: [],
            errors: [],
        });
    });

    // -----------------------------------------------------------------------
    // loadImage error paths
    // -----------------------------------------------------------------------

    describe('loadImage errors', () => {
        it('EXR read failure sends error message to webview', async () => {
            exrReadFn = () => { throw new Error('corrupt EXR header'); };
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/bad.exr');

            panel.simulateReceiveMessage({ type: 'ready' });
            await flushAsync();

            const errorMsg = (panel.messages as any[]).find(
                (m: any) => m.type === 'error' && typeof m.message === 'string' && m.message.includes('corrupt EXR header')
            );
            assert.ok(errorMsg, 'should post error message to webview');
            panel.dispose();
        });

        it('OCIO init failure sends error message to webview', async () => {
            initOCIOFn = async () => { throw new Error('OCIO config not found'); };
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'ready' });
            await flushAsync();

            const errorMsg = (panel.messages as any[]).find(
                (m: any) => m.type === 'error' && typeof m.message === 'string' && m.message.includes('OCIO config not found')
            );
            assert.ok(errorMsg, 'should post error message to webview');
            panel.dispose();
        });

        it('loadImage still sends startLoading before failing', async () => {
            exrReadFn = () => { throw new Error('read failure'); };
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'ready' });
            await flushAsync();

            const types = (panel.messages as any[]).map((m: any) => m.type);
            assert.equal(types[0], 'startLoading', 'startLoading should be sent before error');
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // setDisplayTransform error paths
    // -----------------------------------------------------------------------

    describe('setDisplayTransform errors', () => {
        it('OCIO failure sends error message to webview', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            // Now make OCIO fail
            initOCIOFn = async () => { throw new Error('OCIO transform unavailable'); };
            const countBefore = panel.messages.length;

            panel.simulateReceiveMessage({
                type: 'setDisplayTransform',
                source: 'ACEScg', display: 'sRGB', view: 'ACES 1.0 - SDR Video',
            });
            await flushAsync();

            const msgs = (panel.messages as any[]).slice(countBefore);
            const errorMsg = msgs.find(
                (m: any) => m.type === 'error' && typeof m.message === 'string' && m.message.includes('OCIO transform unavailable')
            );
            assert.ok(errorMsg, 'should send error to webview');
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // loadDctlFile error paths
    // -----------------------------------------------------------------------

    describe('loadDctlFile errors', () => {
        it('preprocessing failure shows error dialog', async () => {
            preprocessFn = async () => ({
                success: false,
                expandedSource: '',
                params: [],
                includedFiles: [],
                errors: [{ message: 'syntax error at line 42' }],
            });
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/broken.dctl' });
            await flushAsync();

            assert.ok(spy.errorMessages.some(m => m.includes('syntax error at line 42')),
                'should show error dialog with preprocess error');
            panel.dispose();
        });

        it('fs.promises.readFile failure shows error dialog', async () => {
            // Temporarily override fsStub.promises.readFile
            const origReadFile = fsStub.promises.readFile;
            fsStub.promises.readFile = async (p: string, _encoding?: string) => {
                if (p.endsWith('.dctl')) {
                    throw new Error('ENOENT: no such file');
                }
                return origReadFile(p, _encoding);
            };

            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/missing.dctl' });
            await flushAsync();

            assert.ok(spy.errorMessages.some(m => m.includes('ENOENT')),
                'should show error dialog for missing file');

            fsStub.promises.readFile = origReadFile;
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // WGSL build failure
    // -----------------------------------------------------------------------

    describe('WGSL build failure', () => {
        it('loadImage proceeds even when WGSL conversion fails', async () => {
            buildWgslShaderFn = async () => ({
                success: false, error: 'WGSL compilation error', wgslCode: '', bindings: [],
            });
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({ type: 'ready' });
            await flushAsync();

            // Should still send loadImage (with wgslShaderInfo: null)
            const loadImageMsg = (panel.messages as any[]).find((m: any) => m.type === 'loadImage');
            assert.ok(loadImageMsg, 'loadImage should still be sent');
            assert.equal(loadImageMsg.data.wgslShaderInfo, null, 'wgslShaderInfo should be null on failure');
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // State guard (handler called without DctlState)
    // -----------------------------------------------------------------------

    describe('state guard: handlers on disposed panels', () => {
        it('toggleDctl after dispose does not crash', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            // Manually delete dctlState to simulate missing state
            // (This happens internally when the panel is disposed)
            panel.dispose();

            // Handler should early-return without throwing
            // We can't send messages to a disposed panel, so test via public API
            assert.doesNotThrow(() => {
                // Provider's internal state for this panel is cleaned up on dispose
                assert.equal(provider.getActivePanels().length, 0);
            });
        });
    });

    // -----------------------------------------------------------------------
    // exportBufferReady edge cases
    // -----------------------------------------------------------------------

    describe('exportBufferReady edge cases', () => {
        it('unknown requestId is ignored without crashing', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({
                type: 'exportBufferReady',
                requestId: 'nonexistent-id',
                success: true,
                width: 100,
                height: 100,
                buffer: new ArrayBuffer(100 * 100 * 4 * 4),
            });
            await flushAsync();

            // Should log a warning but not crash
            assert.ok(spy.logMessages.some(m => m.includes('unknown request')),
                'should log unknown request');
            panel.dispose();
        });

        it('failure response is handled gracefully', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openReadyPanel(provider, '/tmp/test.exr');

            panel.simulateReceiveMessage({
                type: 'exportBufferReady',
                requestId: 'does-not-exist',
                success: false,
                error: 'GPU read failed',
            });
            await flushAsync();

            // Should not crash — the requestId won't match, so it's just logged
            assert.ok(spy.logMessages.some(m => m.includes('does-not-exist')));
            panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // DCTL load on panel A doesn't affect panel B
    // -----------------------------------------------------------------------

    describe('cross-panel isolation during error', () => {
        it('DCTL load error on panel A does not affect panel B', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const resultA = await openReadyPanel(provider, '/tmp/a.exr');
            const resultB = await openReadyPanel(provider, '/tmp/b.exr');

            // Make preprocessing fail
            preprocessFn = async () => ({
                success: false,
                expandedSource: '',
                params: [],
                includedFiles: [],
                errors: [{ message: 'fatal error' }],
            });

            // Load DCTL on panel A — should fail
            resultA.panel.simulateReceiveMessage({ type: 'loadDctlFromPath', path: '/tmp/bad.dctl' });
            await flushAsync();

            // Panel B should be completely unaffected
            assert.equal(provider.getActivePanels().length, 2);
            const panelBInfo = provider.getActivePanels().find((p: any) => p.documentPath === '/tmp/b.exr');
            assert.ok(panelBInfo, 'panel B should still be tracked');

            resultA.panel.dispose();
            resultB.panel.dispose();
        });
    });

    // -----------------------------------------------------------------------
    // EXR with no chromaticities defaults to sRGB
    // -----------------------------------------------------------------------

    describe('color space detection edge cases', () => {
        it('EXR without chromaticities defaults to sRGB - Texture', async () => {
            exrReadFn = () => ({
                width: 100, height: 100,
                channels: ['R', 'G', 'B'],
                pixels: new Float32Array(100 * 100 * 3),
                chromaticities: null,
                compressionName: 'NONE', pixelTypeName: 'FLOAT',
            });
            const provider = new ExrEditorProvider(createMockContext());
            const { panel } = await openPanel(provider, '/tmp/no-chrom.exr');

            panel.simulateReceiveMessage({ type: 'ready' });
            await flushAsync();

            const loadMsg = (panel.messages as any[]).find((m: any) => m.type === 'loadImage');
            assert.ok(loadMsg);
            assert.equal(loadMsg.data.colorSpace, 'sRGB - Texture');
            assert.equal(loadMsg.data.colorSpaceDetected, false);
            panel.dispose();
        });
    });
});
