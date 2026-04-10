/**
 * ExrEditorProvider — Lifecycle unit tests (Group 1 of A0.1).
 *
 * Uses proxyquire to hijack the `vscode` module import inside
 * ExrEditorProvider.ts so the provider can be instantiated and
 * exercised without a real VS Code Extension Host.
 *
 * proxyquire replaces dependencies at the require() level, so
 * production code stays typed against @types/vscode while tests
 * inject stubs for only the surfaces they exercise.
 */

import { strict as assert } from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyquire = require('proxyquire').noCallThru();

// =============================================================================
// Minimal vscode stubs — only the API surface exercised by these tests
// =============================================================================

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
    dispose(): void {
        this.listeners = [];
    }
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

    static file(p: string): FakeUri {
        return new FakeUri('file', p, p);
    }
    static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
        const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
        return new FakeUri(base.scheme, joined, joined);
    }
    toString(): string {
        return `${this.scheme}://${this.path}`;
    }
}

function createFakeWorkspace() {
    const configValues = new Map<string, unknown>();
    return {
        getConfiguration: (_section?: string) => ({
            get: <T>(_key: string, defaultValue?: T) => {
                const fullKey = _section ? `${_section}.${_key}` : _key;
                if (configValues.has(fullKey)) return configValues.get(fullKey) as T;
                return defaultValue;
            },
            has: () => false,
            update: async () => undefined,
        }),
        createFileSystemWatcher: () => {
            const emitter = new FakeEventEmitter<FakeUri>();
            return {
                onDidChange: emitter.event,
                onDidCreate: emitter.event,
                onDidDelete: emitter.event,
                dispose: () => emitter.dispose(),
            };
        },
        fs: { readFile: async () => { throw new Error('not stubbed'); } },
        onDidChangeConfiguration: new FakeEventEmitter<void>().event,
        /** Test helper: override a config value */
        _setConfig: (key: string, value: unknown) => { configValues.set(key, value); },
        _resetConfig: () => { configValues.clear(); },
    };
}

/**
 * Create a mock WebviewPanel with spying capabilities.
 *
 * messages: every object the host has posted into this webview.
 * simulateReceiveMessage: push a message FROM the webview TO the host.
 */
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
        reveal: () => { /* no-op */ },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            disposeEmitter.fire();
            disposeEmitter.dispose();
            viewStateEmitter.dispose();
            messageEmitter.dispose();
        },
        // Test helpers
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

// =============================================================================
// Build the vscode stub that proxyquire will inject
// =============================================================================

const fakeWorkspace = createFakeWorkspace();

const vscodeMock = {
    '@noCallThru': true,
    '@global': true,
    EventEmitter: FakeEventEmitter,
    Uri: FakeUri,
    workspace: fakeWorkspace,
    window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showOpenDialog: async () => undefined,
        showSaveDialog: async () => undefined,
        onDidChangeVisibleTextEditors: new FakeEventEmitter<void>().event,
        visibleTextEditors: [],
        tabGroups: {
            onDidChangeTabs: new FakeEventEmitter<void>().event,
            all: [],
        },
    },
    commands: {
        registerCommand: () => ({ dispose: () => {} }),
        executeCommand: async () => undefined,
    },
    languages: {
        registerHoverProvider: () => ({ dispose: () => {} }),
        registerCompletionItemProvider: () => ({ dispose: () => {} }),
        createDiagnosticCollection: () => ({
            set: () => {},
            delete: () => {},
            clear: () => {},
            dispose: () => {},
        }),
    },
    // Types / classes that ExrEditorProvider.ts uses at the type level
    // (the `implements` clause) — provide no-ops.
    Disposable: { from: (...ds: any[]) => ({ dispose: () => ds.forEach((d: any) => d.dispose?.()) }) },
    CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }; cancel() {} dispose() {} },
    TabInputText: class { readonly uri: FakeUri; constructor(uri: FakeUri) { this.uri = uri; } },
};

// =============================================================================
// Load ExrEditorProvider with injected stubs
// =============================================================================

// proxyquire resolves paths relative to __dirname (src/test/unit/ at runtime
// under ts-node).  The provider lives at src/editor/ExrEditorProvider.ts.
const { ExrEditorProvider } = proxyquire('../../editor/ExrEditorProvider', {
    'vscode': vscodeMock,
});

// =============================================================================
// Tests — Group 1: Lifecycle
// =============================================================================

describe('ExrEditorProvider — lifecycle (proxyquire)', () => {
    afterEach(() => {
        fakeWorkspace._resetConfig();
    });

    describe('constructor', () => {
        it('accepts a mock ExtensionContext without throwing', () => {
            const ctx = createMockContext();
            assert.doesNotThrow(() => new ExrEditorProvider(ctx));
        });

        it('exposes the static viewType identifier used by package.json', () => {
            assert.equal(ExrEditorProvider.viewType, 'dctlWorkbench.exrEditor');
        });

        it('starts with no active panels', () => {
            const provider = new ExrEditorProvider(createMockContext());
            assert.deepEqual(provider.getActivePanels(), []);
        });
    });

    describe('openCustomDocument', () => {
        it('returns a document wrapping the URI', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const uri = FakeUri.file('/tmp/test.exr');
            const doc = await provider.openCustomDocument(uri, {}, vscodeMock.CancellationTokenSource.prototype.token);

            assert.ok(doc);
            assert.equal(doc.uri.fsPath, '/tmp/test.exr');
            assert.doesNotThrow(() => doc.dispose());
        });

        it('returns a fresh document for each call', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const uri = FakeUri.file('/tmp/same.exr');
            const token = new vscodeMock.CancellationTokenSource().token;

            const a = await provider.openCustomDocument(uri, {}, token);
            const b = await provider.openCustomDocument(uri, {}, token);
            assert.notEqual(a, b);
        });
    });

    describe('resolveCustomEditor', () => {
        it('configures the webview with enableScripts', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const uri = FakeUri.file('/tmp/test.exr');
            const doc = await provider.openCustomDocument(uri, {}, new vscodeMock.CancellationTokenSource().token);
            const panel = createMockWebviewPanel();

            await provider.resolveCustomEditor(doc, panel, new vscodeMock.CancellationTokenSource().token);

            assert.equal(panel.webview.options.enableScripts, true);
        });

        it('writes non-empty HTML into the webview', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const doc = await provider.openCustomDocument(FakeUri.file('/tmp/test.exr'), {}, new vscodeMock.CancellationTokenSource().token);
            const panel = createMockWebviewPanel();

            await provider.resolveCustomEditor(doc, panel, new vscodeMock.CancellationTokenSource().token);

            assert.ok(panel.webview.html.length > 0);
            assert.ok(panel.webview.html.includes('<html') || panel.webview.html.includes('<!DOCTYPE'));

            panel.dispose();
        });

        it('registers the panel in getActivePanels()', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const doc = await provider.openCustomDocument(FakeUri.file('/tmp/foo.exr'), {}, new vscodeMock.CancellationTokenSource().token);
            const panel = createMockWebviewPanel();

            await provider.resolveCustomEditor(doc, panel, new vscodeMock.CancellationTokenSource().token);

            const active = provider.getActivePanels();
            assert.equal(active.length, 1);
            assert.equal(active[0].documentPath, '/tmp/foo.exr');
            assert.equal(active[0].documentName, 'foo.exr');

            panel.dispose();
        });
    });

    describe('panel disposal', () => {
        it('removes the panel from getActivePanels()', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const doc = await provider.openCustomDocument(FakeUri.file('/tmp/test.exr'), {}, new vscodeMock.CancellationTokenSource().token);
            const panel = createMockWebviewPanel();

            await provider.resolveCustomEditor(doc, panel, new vscodeMock.CancellationTokenSource().token);
            assert.equal(provider.getActivePanels().length, 1);

            panel.dispose();
            assert.equal(provider.getActivePanels().length, 0);
        });

        it('double dispose is safe', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const doc = await provider.openCustomDocument(FakeUri.file('/tmp/test.exr'), {}, new vscodeMock.CancellationTokenSource().token);
            const panel = createMockWebviewPanel();

            await provider.resolveCustomEditor(doc, panel, new vscodeMock.CancellationTokenSource().token);
            panel.dispose();
            assert.doesNotThrow(() => panel.dispose());
            assert.equal(provider.getActivePanels().length, 0);
        });
    });

    describe('getActivePanels ordering', () => {
        it('sorts by last-active time, most recent first', async () => {
            const provider = new ExrEditorProvider(createMockContext());
            const token = new vscodeMock.CancellationTokenSource().token;

            const docA = await provider.openCustomDocument(FakeUri.file('/a.exr'), {}, token);
            const docB = await provider.openCustomDocument(FakeUri.file('/b.exr'), {}, token);

            const panelA = createMockWebviewPanel();
            const panelB = createMockWebviewPanel();

            await provider.resolveCustomEditor(docA, panelA, token);
            await provider.resolveCustomEditor(docB, panelB, token);

            // Bump panelA's lastActiveTime by simulating a view state change
            await new Promise(r => setTimeout(r, 5));
            panelA.simulateChangeViewState({ active: true });

            const active = provider.getActivePanels();
            assert.equal(active.length, 2);
            assert.equal(active[0].documentPath, '/a.exr', 'panel A should be most recent');

            panelA.dispose();
            panelB.dispose();
        });
    });
});
