/**
 * EXR File Open Integration Test
 *
 * Verifies that the extension can open EXR files via the custom editor.
 * This tests the full path: activation → WASM loading → EXR parsing.
 *
 * Regression test for: WASM path resolution failure after esbuild bundling
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveFixture } from '@dctl-workbench/core/out/test-paths.js';

console.log('[exr-open.test.ts] Module loading...');
console.log('[exr-open.test.ts] Registering suite...');

suite('EXR File Open', function () {
    console.log('[exr-open.test.ts] Inside suite callback');

    test('should open EXR file in custom editor without errors', async function () {
        this.timeout(30000);

        const testExrPath = resolveFixture('rgc_test_source_ap0.exr');
        console.log('[exr-open.test.ts] resolveFixture result:', testExrPath);
        if (!testExrPath) {
            this.skip();
            return;
        }

        console.log('[exr-open.test.ts] Opening EXR:', testExrPath);
        const uri = vscode.Uri.file(testExrPath);

        // Open the EXR file with our custom editor
        await vscode.commands.executeCommand('vscode.openWith', uri, 'dctlWorkbench.exrEditor');

        // Wait for the extension to activate and process the file
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Verify the custom editor tab is open
        const tabGroups = vscode.window.tabGroups;
        const allTabs = tabGroups.all.flatMap(g => g.tabs);
        const exrTab = allTabs.find(tab => {
            const input = tab.input;
            return input instanceof vscode.TabInputCustom &&
                input.viewType === 'dctlWorkbench.exrEditor';
        });

        assert.ok(exrTab, 'EXR file should be open in the custom editor');

        // Clean up
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    test('should resolve OpenEXR WASM path correctly from bundled extension', async function () {
        this.timeout(15000);

        // Find the extension
        const extension = vscode.extensions.all.find(ext =>
            ext.packageJSON?.name === 'dctl-workbench' ||
            ext.id.includes('dctl-workbench')
        );
        assert.ok(extension, 'DCTL Workbench extension should be found');

        if (!extension.isActive) {
            await extension.activate();
        }

        // Verify WASM files exist at the expected paths
        const extensionPath = extension.extensionPath;
        const wasmDir = path.join(extensionPath, 'out', 'wasm');
        const openexrJs = path.join(wasmDir, 'openexr.js');
        const openexrWasm = path.join(wasmDir, 'openexr.wasm');

        console.log('[exr-open.test.ts] extensionPath:', extensionPath);
        console.log('[exr-open.test.ts] wasmDir:', wasmDir);
        console.log('[exr-open.test.ts] openexr.js exists:', fs.existsSync(openexrJs));
        console.log('[exr-open.test.ts] openexr.wasm exists:', fs.existsSync(openexrWasm));

        assert.ok(
            fs.existsSync(openexrJs),
            `openexr.js should exist at ${openexrJs}`
        );
        assert.ok(
            fs.existsSync(openexrWasm),
            `openexr.wasm should exist at ${openexrWasm}`
        );

        // Verify the extension can actually load the OpenEXR module
        // Use path.resolve(__dirname, ...) to get correct path from compiled test location
        const exrModulePath = path.resolve(__dirname, '../../../exr/module');
        console.log('[exr-open.test.ts] exrModulePath:', exrModulePath);
        const { setOpenEXRWasmDirectory, initOpenEXR, clearOpenEXRCache } = require(exrModulePath);
        clearOpenEXRCache();
        setOpenEXRWasmDirectory(wasmDir);

        let exrModule;
        try {
            exrModule = await initOpenEXR();
        } catch (e) {
            assert.fail(`Failed to initialize OpenEXR WASM: ${(e as Error).message}`);
        }

        assert.ok(exrModule, 'OpenEXR module should be initialized');
        assert.ok(typeof exrModule._exr_wasm_init === 'function', 'OpenEXR module should have _exr_wasm_init');
        assert.ok(typeof exrModule._exr_wasm_create_read_context === 'function', 'OpenEXR module should have _exr_wasm_create_read_context');
        clearOpenEXRCache();
    });
});
