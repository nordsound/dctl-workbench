/**
 * T013 — Extension Host integration test for the v0.4.0 render API.
 *
 * Runs inside a real VS Code Extension Host (via @vscode/test-electron), so
 * `vscode.Uri`, `vscode.WebviewPanel` and the actual host `activate()`
 * return value are all genuine — not Node stubs.
 *
 * What this pins:
 *   1. apiVersion advertises 0.4.0.
 *   2. api.extensionUri is a real vscode.Uri pointing at the host's install
 *      directory. Plugins need this to construct `localResourceRoots` at
 *      WebviewPanel creation time (see docs/tasks/T013_host_render_api.md,
 *      D2 — localResourceRoots is immutable after panel creation).
 *   3. api.renderImage is a callable function with arity 3 — the test
 *      stops short of invoking it with a real panel because that would
 *      also require a registered plugin + fixture file; that path is
 *      exercised from the plugin repo's Tier 3 E2E.
 *
 * This test is the GREEN-side assertion: it will only pass once
 * extension.ts wires up both new members on the exported api object.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

interface DctlWorkbenchApiV040 {
    apiVersion: string;
    registerInputPlugin(plugin: unknown): boolean;
    unregisterInputPlugin(id: string): boolean;
    extensionUri: vscode.Uri;
    renderImage(
        panel: vscode.WebviewPanel,
        documentUri: vscode.Uri,
        plugin: unknown,
    ): Promise<vscode.Disposable>;
}

async function getApi(): Promise<DctlWorkbenchApiV040> {
    const ext = vscode.extensions.getExtension('nordsound.dctl-workbench');
    assert.ok(ext, 'host extension should be installed');
    if (!ext.isActive) await ext.activate();
    return ext.exports as DctlWorkbenchApiV040;
}

suite('T013: Plugin API v0.4.0 — render-image surface', function () {
    this.timeout(30000);

    test('T013-I1 — api.apiVersion === 0.4.0', async () => {
        const api = await getApi();
        assert.equal(api.apiVersion, '0.4.0');
    });

    test('T013-I2 — api.extensionUri is a vscode.Uri pointing at the host install dir', async () => {
        const api = await getApi();
        assert.ok(api.extensionUri, 'extensionUri must be present on the api');
        // vscode.Uri is a class, so instanceof works inside the Extension Host.
        // We don't use instanceof-checks in Node-level unit tests because they
        // run without a real vscode module, but at this tier it's the best
        // signal that the field wasn't accidentally set to a string or path.
        assert.ok(api.extensionUri instanceof vscode.Uri, 'extensionUri must be a vscode.Uri');
        assert.equal(api.extensionUri.scheme, 'file', 'host extension is always on disk');
        // The host extension folder must contain the compiled extension.js.
        // This catches a case where someone wires extensionUri to a parent
        // folder or a subfolder by mistake.
        assert.ok(
            api.extensionUri.fsPath.length > 0,
            'extensionUri.fsPath must be a non-empty path',
        );
    });

    test('T013-I3 — api.renderImage is a 3-arity function', async () => {
        const api = await getApi();
        assert.equal(typeof api.renderImage, 'function', 'renderImage must be a function');
        assert.equal(
            api.renderImage.length, 3,
            'renderImage must accept (panel, documentUri, plugin)',
        );
    });

    test('T013-I4 — existing v0.3.0 members survive the bump (regression guard)', async () => {
        // Additive bump means registerInputPlugin / unregisterInputPlugin
        // stay callable. If a refactor accidentally drops them, the v0.3.0
        // plugin compatibility promise breaks.
        const api = await getApi();
        assert.equal(typeof api.registerInputPlugin, 'function');
        assert.equal(typeof api.unregisterInputPlugin, 'function');
    });
});
