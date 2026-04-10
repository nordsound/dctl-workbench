/**
 * ExrEditorProvider — Multi-panel state isolation tests (Group 2 of A0.1).
 *
 * Verifies that opening multiple EXR files simultaneously produces
 * independent per-panel state: disposing one panel must not disturb
 * another, and each panel tracks its own document path.
 *
 * These tests deliberately do NOT trigger webview 'ready' messages,
 * so no loadImage / OCIO / shader code runs. Tests that exercise DCTL
 * load, RGC toggle, and OCIO display transform (which depend on
 * additional module stubs) belong to Group 3 (message handlers).
 */

import { strict as assert } from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Stubs (shared with Group 1 — duplicated here so each test file is
// self-contained and does not depend on test-internal imports).
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

const vscodeMock = {
    '@noCallThru': true,
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
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showOpenDialog: async () => undefined,
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

const { ExrEditorProvider } = proxyquire('../../editor/ExrEditorProvider', {
    'vscode': vscodeMock,
});

// ---------------------------------------------------------------------------
// Helper: open a document and resolve a panel in one step
// ---------------------------------------------------------------------------

async function openPanel(provider: any, filePath: string) {
    const uri = FakeUri.file(filePath);
    const token = new vscodeMock.CancellationTokenSource().token;
    const doc = await provider.openCustomDocument(uri, {}, token);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomEditor(doc, panel, token);
    return { doc, panel };
}

// ---------------------------------------------------------------------------
// Tests — Group 2: Multi-panel state isolation
// ---------------------------------------------------------------------------

describe('ExrEditorProvider — multi-panel state isolation', () => {
    it('two panels opened for different files are independently tracked', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: panelA } = await openPanel(provider, '/tmp/a.exr');
        const { panel: panelB } = await openPanel(provider, '/tmp/b.exr');

        const active = provider.getActivePanels();
        assert.equal(active.length, 2);

        const paths = active.map((p: any) => p.documentPath).sort();
        assert.deepEqual(paths, ['/tmp/a.exr', '/tmp/b.exr']);

        panelA.dispose();
        panelB.dispose();
    });

    it('disposing panel A does not affect panel B', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: panelA } = await openPanel(provider, '/tmp/a.exr');
        const { panel: panelB } = await openPanel(provider, '/tmp/b.exr');

        panelA.dispose();

        const active = provider.getActivePanels();
        assert.equal(active.length, 1);
        assert.equal(active[0].documentPath, '/tmp/b.exr');
        assert.equal(active[0].panel, panelB);

        panelB.dispose();
    });

    it('disposing panel B does not affect panel A', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: panelA } = await openPanel(provider, '/tmp/a.exr');
        const { panel: panelB } = await openPanel(provider, '/tmp/b.exr');

        panelB.dispose();

        const active = provider.getActivePanels();
        assert.equal(active.length, 1);
        assert.equal(active[0].documentPath, '/tmp/a.exr');
        assert.equal(active[0].panel, panelA);

        panelA.dispose();
    });

    it('five panels open simultaneously are all tracked independently', async () => {
        const provider = new ExrEditorProvider(createMockContext());
        const panels: ReturnType<typeof createMockWebviewPanel>[] = [];

        for (let i = 0; i < 5; i++) {
            const { panel } = await openPanel(provider, `/tmp/file${i}.exr`);
            panels.push(panel);
        }

        assert.equal(provider.getActivePanels().length, 5);

        // Dispose all
        for (const p of panels) p.dispose();

        assert.equal(provider.getActivePanels().length, 0);
    });

    it('disposing panels in reverse order leaves the remaining panels intact', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: p1 } = await openPanel(provider, '/tmp/1.exr');
        const { panel: p2 } = await openPanel(provider, '/tmp/2.exr');
        const { panel: p3 } = await openPanel(provider, '/tmp/3.exr');

        p3.dispose();
        assert.equal(provider.getActivePanels().length, 2);

        p2.dispose();
        assert.equal(provider.getActivePanels().length, 1);
        assert.equal(provider.getActivePanels()[0].documentPath, '/tmp/1.exr');

        p1.dispose();
        assert.equal(provider.getActivePanels().length, 0);
    });

    it('the same file can be opened in two panels with independent state', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: panelA } = await openPanel(provider, '/tmp/same.exr');
        const { panel: panelB } = await openPanel(provider, '/tmp/same.exr');

        assert.notEqual(panelA, panelB, 'panels should be different objects');
        assert.equal(provider.getActivePanels().length, 2);

        // Both report the same documentPath
        const paths = provider.getActivePanels().map((p: any) => p.documentPath);
        assert.deepEqual(paths.sort(), ['/tmp/same.exr', '/tmp/same.exr']);

        // Disposing one does not affect the other
        panelA.dispose();
        assert.equal(provider.getActivePanels().length, 1);
        assert.equal(provider.getActivePanels()[0].panel, panelB);

        panelB.dispose();
    });

    it('view state changes on panel A do not affect panel B ordering', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: panelA } = await openPanel(provider, '/tmp/a.exr');
        const { panel: panelB } = await openPanel(provider, '/tmp/b.exr');

        // Wait to ensure time difference
        await new Promise(r => setTimeout(r, 5));

        // Activate panel A — should bump its lastActiveTime
        panelA.simulateChangeViewState({ active: true });

        const active = provider.getActivePanels();
        assert.equal(active[0].documentPath, '/tmp/a.exr', 'panel A should now be most recent');
        assert.equal(active[1].documentPath, '/tmp/b.exr');

        // Now activate panel B
        await new Promise(r => setTimeout(r, 5));
        panelB.simulateChangeViewState({ active: true });

        const active2 = provider.getActivePanels();
        assert.equal(active2[0].documentPath, '/tmp/b.exr', 'panel B should now be most recent');

        panelA.dispose();
        panelB.dispose();
    });

    it('each panel receives its own webview HTML (not shared)', async () => {
        const provider = new ExrEditorProvider(createMockContext());

        const { panel: panelA } = await openPanel(provider, '/tmp/a.exr');
        const { panel: panelB } = await openPanel(provider, '/tmp/b.exr');

        // Both should have HTML set
        assert.ok(panelA.webview.html.length > 0);
        assert.ok(panelB.webview.html.length > 0);

        // HTML contains a nonce, so the two strings should differ
        assert.notEqual(panelA.webview.html, panelB.webview.html,
            'each panel should get its own HTML with a unique nonce');

        panelA.dispose();
        panelB.dispose();
    });
});
