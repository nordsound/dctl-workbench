/**
 * Shared test infrastructure for ExrEditorProvider unit tests.
 *
 * Provides minimal vscode API stubs that can be composed into
 * per-test-file vscodeMock objects injected via proxyquire.
 */

export class FakeEventEmitter<T> {
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

export class FakeUri {
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

/**
 * Create a mock WebviewPanel with spying capabilities.
 *
 * messages: every object the host has posted into this webview.
 * simulateReceiveMessage: push a message FROM the webview TO the host.
 */
export function createMockWebviewPanel() {
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

/**
 * Default mock EXR data used by createMockExrInputPlugin.
 */
export const DEFAULT_MOCK_EXR_DATA = {
    width: 1920,
    height: 1080,
    channels: ['R', 'G', 'B'],
    pixels: new Float32Array(1920 * 1080 * 3),
    chromaticities: {
        redX: 0.7347, redY: 0.2653,
        greenX: 0.0, greenY: 1.0,
        blueX: 0.0001, blueY: -0.077,
        whiteX: 0.32168, whiteY: 0.33767,
    } as const,
    compressionName: 'ZIP' as string,
    pixelTypeName: 'HALF' as string,
};

/**
 * Create a minimal mock InputPlugin for EXR file tests.
 *
 * The plugin:
 * - claims to handle the `exr` extension
 * - on `load()` snapshots the result of `getData()` (defaults to DEFAULT_MOCK_EXR_DATA)
 * - on `getImageData()` pads to 4-channel RGBA (matching BuiltinExrInputPlugin)
 * - on `getMetadata()` returns the chromaticities captured during load
 *
 * Override `load`/`getImageData`/`getMetadata` individually to exercise
 * error paths without rebuilding the whole plugin object.
 */
export function createMockExrInputPlugin(options?: {
    getData?: () => any;
    load?: (data: Uint8Array) => Promise<void>;
    getImageData?: () => Promise<any>;
    getMetadata?: () => any;
    canHandle?: (ext: string) => boolean;
}) {
    const getData = options?.getData ?? (() => DEFAULT_MOCK_EXR_DATA);
    let parsed: any = null;

    const defaultLoad = async (_data: Uint8Array) => {
        parsed = getData();
    };
    const defaultGetImageData = async () => {
        if (!parsed) throw new Error('mock plugin: load() was not called');
        const { width, height, pixels } = parsed;
        const channels = parsed.channels?.length ?? 3;
        const rgba = new Float32Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            rgba[i * 4]     = pixels[i * channels] ?? 0;
            rgba[i * 4 + 1] = channels > 1 ? (pixels[i * channels + 1] ?? 0) : 0;
            rgba[i * 4 + 2] = channels > 2 ? (pixels[i * channels + 2] ?? 0) : 0;
            rgba[i * 4 + 3] = 1.0;
        }
        // Mirror BuiltinExrInputPlugin: if chromaticities missing, fall back to sRGB
        const colorSpace = parsed.chromaticities ? 'ACES2065-1' : 'sRGB - Texture';
        return {
            pixels: rgba,
            pixelFormat: 'rgba32float',
            width,
            height,
            channels: 4,
            bitsPerSample: parsed.pixelTypeName === 'HALF' ? 16 : 32,
            colorSpace,
        };
    };
    const defaultGetMetadata = () => ({
        chromaticities: parsed?.chromaticities,
    });

    return {
        id: 'test.mock-exr',
        name: 'Mock EXR',
        version: '1.0.0',
        license: 'MIT',
        supportedExtensions: ['exr'],
        canHandle: options?.canHandle ?? ((ext: string) => ext.toLowerCase() === 'exr'),
        load: options?.load ?? defaultLoad,
        getImageData: options?.getImageData ?? defaultGetImageData,
        getMetadata: options?.getMetadata ?? defaultGetMetadata,
        dispose: () => { parsed = null; },
    };
}

export function createMockContext(extensionPath = '/mock/dctl-workbench') {
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
