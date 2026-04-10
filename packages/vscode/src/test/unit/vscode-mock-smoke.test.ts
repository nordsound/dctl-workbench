/**
 * Smoke test for the test-only `vscode` mock module.
 *
 * This file exists purely to verify that the mocking infrastructure
 * (tsconfig.test.json paths + tsconfig-paths/register) wires up the
 * `import * as vscode from 'vscode'` statement to
 * src/test/mocks/vscode.ts at both type-check time and runtime under
 * mocha + ts-node.
 *
 * If this test fails to even load, the mock infrastructure is broken
 * and every other vscode-dependent unit test (planned for A0.1) will
 * also fail.
 */

import { strict as assert } from 'assert';
import * as vscode from 'vscode';

describe('vscode mock infrastructure (Option C smoke test)', () => {
    it('resolves the vscode module to the manual mock', () => {
        assert.ok(vscode, 'vscode namespace should be importable');
    });

    it('exposes a Uri factory that produces file URIs', () => {
        const uri = vscode.Uri.file('/tmp/foo.exr');
        assert.equal(uri.scheme, 'file');
        assert.equal(uri.fsPath, '/tmp/foo.exr');
        assert.equal(uri.toString(), 'file:///tmp/foo.exr');
    });

    it('Uri.joinPath concatenates segments', () => {
        const base = vscode.Uri.file('/a/b');
        const joined = vscode.Uri.joinPath(base, 'c', 'd');
        assert.equal(joined.path.endsWith('/a/b/c/d'), true, joined.path);
    });

    it('EventEmitter delivers events to subscribed listeners', () => {
        const emitter = new vscode.EventEmitter<string>();
        const received: string[] = [];
        const sub = emitter.event((value) => {
            received.push(value);
        });
        emitter.fire('hello');
        emitter.fire('world');
        assert.deepEqual(received, ['hello', 'world']);
        sub.dispose();
        emitter.fire('after-dispose');
        assert.deepEqual(received, ['hello', 'world']);
    });

    it('CancellationTokenSource fires onCancellationRequested', () => {
        const source = new vscode.CancellationTokenSource();
        let cancelled = false;
        source.token.onCancellationRequested(() => {
            cancelled = true;
        });
        assert.equal(source.token.isCancellationRequested, false);
        source.cancel();
        assert.equal(source.token.isCancellationRequested, true);
        assert.equal(cancelled, true);
    });

    it('Disposable.from chains multiple disposables', () => {
        let aDisposed = false;
        let bDisposed = false;
        const composite = vscode.Disposable.from(
            { dispose: () => { aDisposed = true; } },
            { dispose: () => { bDisposed = true; } }
        );
        composite.dispose();
        assert.equal(aDisposed, true);
        assert.equal(bDisposed, true);
    });

    it('window.showInformationMessage returns a resolved promise', async () => {
        const result = await vscode.window.showInformationMessage('hi');
        assert.equal(result, undefined);
    });

    it('workspace.getConfiguration returns a stub configuration object', () => {
        const config = vscode.workspace.getConfiguration('dctlWorkbench');
        assert.equal(config.get('missing.key', 'fallback'), 'fallback');
        assert.equal(config.has('any'), false);
    });

    it('languages.createDiagnosticCollection returns a no-op collection', () => {
        const collection = vscode.languages.createDiagnosticCollection('test');
        // None of these should throw
        collection.set(vscode.Uri.file('/x'), []);
        collection.delete(vscode.Uri.file('/x'));
        collection.clear();
        collection.dispose();
    });

    it('Diagnostic and Range can be constructed', () => {
        const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 5));
        const diag = new vscode.Diagnostic(range, 'oops', vscode.DiagnosticSeverity.Warning);
        assert.equal(diag.message, 'oops');
        assert.equal(diag.severity, vscode.DiagnosticSeverity.Warning);
    });
});
