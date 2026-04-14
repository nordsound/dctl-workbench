/**
 * Plugin API integration test.
 *
 * Verifies the public DctlWorkbenchApi surface end-to-end in a real
 * extension host: register / find / unregister, lifecycle calls, and
 * the rgba16unorm vs rgba32float output-format hint.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { MockInputPlugin } from '../fixtures/MockInputPlugin';

interface DctlWorkbenchApi {
    registerInputPlugin(plugin: unknown): boolean;
    unregisterInputPlugin(id: string): boolean;
    apiVersion: string;
}

async function getApi(): Promise<DctlWorkbenchApi> {
    const ext = vscode.extensions.getExtension('nordsound.dctl-workbench');
    assert.ok(ext, 'extension should be installed');
    if (!ext.isActive) await ext.activate();
    return ext.exports as DctlWorkbenchApi;
}

suite('Plugin API (DctlWorkbenchApi)', function () {
    this.timeout(30000);

    test('registerInputPlugin + unregisterInputPlugin round-trip', async () => {
        const api = await getApi();
        const plugin = new MockInputPlugin();

        const added = api.registerInputPlugin(plugin);
        assert.equal(added, true, 'first register should succeed');

        const addedAgain = api.registerInputPlugin(plugin);
        assert.equal(addedAgain, false, 'duplicate register should be rejected');

        const removed = api.unregisterInputPlugin(plugin.id);
        assert.equal(removed, true, 'unregister should succeed');
        assert.equal(plugin.disposeCalls, 1, 'dispose should have been called exactly once');

        const removedAgain = api.unregisterInputPlugin(plugin.id);
        assert.equal(removedAgain, false, 'unregister after removal should be a no-op');
    });

    test('plugin lifecycle: init → load → getImageData → getMetadata → dispose', async () => {
        const api = await getApi();
        const plugin = new MockInputPlugin();
        api.registerInputPlugin(plugin);

        try {
            await plugin.init();
            await plugin.load(new Uint8Array([1, 2, 3, 4, 5]));

            const decoded = await plugin.getImageData({ outputFormat: 'rgba32float' });
            assert.equal(decoded.pixelFormat, 'rgba32float');
            assert.equal(decoded.channels, 4);
            assert.ok(decoded.pixels instanceof Float32Array);

            const u16Decoded = await plugin.getImageData({ outputFormat: 'rgba16unorm' });
            assert.equal(u16Decoded.pixelFormat, 'rgba16unorm');
            assert.ok(u16Decoded.pixels instanceof Uint16Array);

            const meta = plugin.getMetadata();
            assert.equal(meta.make, 'test');

            assert.equal(plugin.initCalls, 1);
            assert.equal(plugin.loadCalls, 1);
            assert.equal(plugin.getImageDataCalls, 2);
            assert.equal(plugin.getMetadataCalls, 1);
            assert.equal(plugin.lastLoadedBytesForTest, 5);
        } finally {
            api.unregisterInputPlugin(plugin.id);
        }
    });

    test('apiVersion is a semver string', async () => {
        const api = await getApi();
        assert.match(api.apiVersion, /^\d+\.\d+\.\d+$/);
    });
});
