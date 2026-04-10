/**
 * Manual mock of the `vscode` module for unit tests.
 *
 * Importing real `vscode` from a Node.js / ts-node process fails with
 * ERR_MODULE_NOT_FOUND because the API is only available inside the
 * extension host. This mock is mapped to the `vscode` import via the
 * `paths` option in tsconfig.test.json so that any test under
 * src/test/** that does `import * as vscode from 'vscode'` resolves
 * here at type-check time, and tsconfig-paths/register handles the
 * runtime resolution when mocha + ts-node executes the test.
 *
 * The mock starts intentionally minimal — it only exposes the API
 * surface that current tests need. Add more stubs as more tests
 * require them; do NOT try to mirror the entire vscode API.
 */

// =============================================================================
// Disposable
// =============================================================================

export interface Disposable {
    dispose(): unknown;
}

export const Disposable = {
    from(...disposables: Disposable[]): Disposable {
        return {
            dispose() {
                for (const d of disposables) {
                    try {
                        d.dispose();
                    } catch {
                        // ignore
                    }
                }
            },
        };
    },
};

// =============================================================================
// EventEmitter
// =============================================================================

export type Event<T> = (listener: (e: T) => unknown) => Disposable;

export class EventEmitter<T> {
    private listeners: Array<(e: T) => unknown> = [];

    readonly event: Event<T> = (listener) => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                const index = this.listeners.indexOf(listener);
                if (index !== -1) this.listeners.splice(index, 1);
            },
        };
    };

    fire(data: T): void {
        for (const listener of this.listeners.slice()) {
            listener(data);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

// =============================================================================
// CancellationToken
// =============================================================================

export interface CancellationToken {
    isCancellationRequested: boolean;
    onCancellationRequested: Event<unknown>;
}

export class CancellationTokenSource {
    private _token: CancellationToken;
    private _emitter = new EventEmitter<unknown>();

    constructor() {
        this._token = {
            isCancellationRequested: false,
            onCancellationRequested: this._emitter.event,
        };
    }

    get token(): CancellationToken {
        return this._token;
    }

    cancel(): void {
        this._token.isCancellationRequested = true;
        this._emitter.fire(undefined);
    }

    dispose(): void {
        this._emitter.dispose();
    }
}

// =============================================================================
// Uri (minimal)
// =============================================================================

export class Uri {
    private constructor(
        public readonly scheme: string,
        public readonly authority: string,
        public readonly path: string,
        public readonly query: string,
        public readonly fragment: string,
        public readonly fsPath: string
    ) {}

    static file(path: string): Uri {
        return new Uri('file', '', path, '', '', path);
    }

    static parse(value: string): Uri {
        // Extremely small parser — only handles file:// URIs which is
        // what dctl-workbench uses internally.
        if (value.startsWith('file://')) {
            const path = value.slice('file://'.length);
            return Uri.file(path);
        }
        const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(value);
        if (m) {
            return new Uri(m[1], '', m[2], '', '', m[2]);
        }
        return new Uri('', '', value, '', '', value);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
        const joined = [base.path, ...segments].filter(Boolean).join('/').replace(/\/+/g, '/');
        return new Uri(base.scheme, base.authority, joined, '', '', joined);
    }

    toString(): string {
        if (this.scheme === 'file') return `file://${this.path}`;
        return `${this.scheme}:${this.path}`;
    }

    with(change: { scheme?: string; path?: string; query?: string; fragment?: string }): Uri {
        return new Uri(
            change.scheme ?? this.scheme,
            this.authority,
            change.path ?? this.path,
            change.query ?? this.query,
            change.fragment ?? this.fragment,
            change.path ?? this.fsPath
        );
    }
}

// =============================================================================
// Position / Range / Location
// =============================================================================

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
}

export class Location {
    constructor(public readonly uri: Uri, public readonly range: Range) {}
}

// =============================================================================
// Diagnostic
// =============================================================================

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export class Diagnostic {
    severity: DiagnosticSeverity = DiagnosticSeverity.Error;
    constructor(
        public range: Range,
        public message: string,
        severity?: DiagnosticSeverity
    ) {
        if (severity !== undefined) this.severity = severity;
    }
}

// =============================================================================
// WebviewPanel mock
// =============================================================================

export interface Webview {
    html: string;
    options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
    cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage: Event<unknown>;
}

export interface WebviewPanel {
    readonly viewType: string;
    readonly webview: Webview;
    readonly active: boolean;
    readonly visible: boolean;
    onDidDispose: Event<unknown>;
    onDidChangeViewState: Event<unknown>;
    reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
    dispose(): void;
}

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3,
}

// =============================================================================
// ExtensionContext mock
// =============================================================================

export interface Memento {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Promise<void>;
    keys(): readonly string[];
}

export interface ExtensionContext {
    subscriptions: Disposable[];
    extensionPath: string;
    extensionUri: Uri;
    globalStorageUri: Uri;
    storageUri: Uri | undefined;
    workspaceState: Memento;
    globalState: Memento;
    asAbsolutePath(relativePath: string): string;
}

// =============================================================================
// Workspace / window namespaces — populated by tests via spies
// =============================================================================

export interface WorkspaceConfiguration {
    get<T>(section: string): T | undefined;
    get<T>(section: string, defaultValue: T): T;
    has(section: string): boolean;
    update(section: string, value: unknown, configurationTarget?: unknown): Promise<void>;
}

export const workspace = {
    getConfiguration(_section?: string): WorkspaceConfiguration {
        return {
            get: <T>(_key: string, defaultValue?: T) => defaultValue,
            has: (_key: string) => false,
            update: async () => undefined,
        } as WorkspaceConfiguration;
    },
    onDidChangeConfiguration: new EventEmitter<unknown>().event,
    fs: {
        async readFile(_uri: Uri): Promise<Uint8Array> {
            throw new Error('workspace.fs.readFile is not stubbed in this test');
        },
    },
    createFileSystemWatcher(_pattern: unknown) {
        const emitter = new EventEmitter<Uri>();
        return {
            onDidChange: emitter.event,
            onDidCreate: emitter.event,
            onDidDelete: emitter.event,
            dispose: () => emitter.dispose(),
        };
    },
};

export const window = {
    showInformationMessage(...args: unknown[]): Promise<string | undefined> {
        void args;
        return Promise.resolve(undefined);
    },
    showWarningMessage(...args: unknown[]): Promise<string | undefined> {
        void args;
        return Promise.resolve(undefined);
    },
    showErrorMessage(...args: unknown[]): Promise<string | undefined> {
        void args;
        return Promise.resolve(undefined);
    },
    showOpenDialog(_options?: unknown): Promise<Uri[] | undefined> {
        return Promise.resolve(undefined);
    },
    showSaveDialog(_options?: unknown): Promise<Uri | undefined> {
        return Promise.resolve(undefined);
    },
    onDidChangeVisibleTextEditors: new EventEmitter<unknown>().event,
    tabGroups: {
        onDidChangeTabs: new EventEmitter<unknown>().event,
    },
};

export const commands = {
    registerCommand(_command: string, _callback: (...args: unknown[]) => unknown): Disposable {
        return { dispose: () => undefined };
    },
    executeCommand<T = unknown>(_command: string, ..._rest: unknown[]): Promise<T | undefined> {
        return Promise.resolve(undefined);
    },
};

export const languages = {
    registerHoverProvider(_selector: unknown, _provider: unknown): Disposable {
        return { dispose: () => undefined };
    },
    registerCompletionItemProvider(
        _selector: unknown,
        _provider: unknown,
        ..._chars: string[]
    ): Disposable {
        return { dispose: () => undefined };
    },
    createDiagnosticCollection(_name?: string) {
        return {
            set(_uri: Uri, _diagnostics: Diagnostic[]) {
                /* noop */
            },
            delete(_uri: Uri) {
                /* noop */
            },
            clear() {
                /* noop */
            },
            dispose() {
                /* noop */
            },
        };
    },
};

// =============================================================================
// Default export shape — vscode is a namespace, not a default export
// =============================================================================
// (Nothing to do here — every export above is named, which is what
// `import * as vscode from 'vscode'` consumes.)
