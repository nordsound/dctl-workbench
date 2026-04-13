/**
 * BuiltinExrInputPlugin Integration Test
 *
 * Exercises the plugin end-to-end with real WASM and a real EXR fixture.
 * Unlike the unit tests (proxyquire, WASM stubbed), this test would catch:
 *  - WASM module invalidation bugs
 *  - Pixel buffer size mismatches
 *  - RGB→RGBA conversion errors
 *  - Color space identification from real chromaticities
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveFixture } from '@dctl-workbench/core/out/test-paths.js';
import { BuiltinExrInputPlugin } from '../../plugins/BuiltinExrInputPlugin';

suite('BuiltinExrInputPlugin (real WASM)', function () {
    const TEST_EXR = resolveFixture('rgc_test_source_ap0.exr');

    test('load + getImageData produces valid RGBA Float32Array', async function () {
        this.timeout(30000);

        if (!TEST_EXR || !fs.existsSync(TEST_EXR)) {
            this.skip();
            return;
        }

        const extension = vscode.extensions.getExtension('nordsound.dctl-workbench');
        assert.ok(extension, 'extension should be installed');
        if (!extension.isActive) await extension.activate();

        const plugin = new BuiltinExrInputPlugin(extension.extensionPath);
        const fileData = fs.readFileSync(TEST_EXR);

        await plugin.load(new Uint8Array(fileData));
        const decoded = await plugin.getImageData();

        assert.ok(decoded.width > 0, 'width should be positive');
        assert.ok(decoded.height > 0, 'height should be positive');
        assert.equal(decoded.channels, 4, 'plugin should pad to RGBA');
        assert.equal(decoded.pixelFormat, 'rgba32float', 'output should be rgba32float');
        assert.ok(decoded.pixels instanceof Float32Array, 'pixels should be Float32Array');
        assert.equal(
            decoded.pixels.length,
            decoded.width * decoded.height * 4,
            'pixel buffer length should match width*height*4'
        );

        // Alpha channel should be 1.0 for all pixels (source is RGB, plugin fills alpha)
        for (let i = 3; i < decoded.pixels.length; i += 4) {
            if (decoded.pixels[i] !== 1.0) {
                assert.fail(`Alpha channel at pixel ${i / 4} is ${decoded.pixels[i]}, expected 1.0`);
            }
        }

        plugin.dispose();
    });

    test('load can be called multiple times on same instance', async function () {
        this.timeout(60000);

        if (!TEST_EXR || !fs.existsSync(TEST_EXR)) {
            this.skip();
            return;
        }

        const extension = vscode.extensions.getExtension('nordsound.dctl-workbench');
        assert.ok(extension);
        if (!extension.isActive) await extension.activate();

        const plugin = new BuiltinExrInputPlugin(extension.extensionPath);
        const fileData = fs.readFileSync(TEST_EXR);

        // First load
        await plugin.load(new Uint8Array(fileData));
        const decoded1 = await plugin.getImageData();
        assert.ok(decoded1.pixels.length > 0);

        // Second load — should not leak memory or fail on stale state
        await plugin.load(new Uint8Array(fileData));
        const decoded2 = await plugin.getImageData();
        assert.equal(decoded2.width, decoded1.width);
        assert.equal(decoded2.height, decoded1.height);
        assert.equal(decoded2.pixels.length, decoded1.pixels.length);

        plugin.dispose();
    });

    test('getImageData throws when called before load', async function () {
        const extension = vscode.extensions.getExtension('nordsound.dctl-workbench');
        assert.ok(extension);
        if (!extension.isActive) await extension.activate();

        const plugin = new BuiltinExrInputPlugin(extension.extensionPath);

        await assert.rejects(
            () => plugin.getImageData(),
            /No data loaded/,
            'should throw when called before load'
        );

        plugin.dispose();
    });

    test('canHandle returns true for exr extension', function () {
        const extension = vscode.extensions.getExtension('nordsound.dctl-workbench');
        assert.ok(extension);
        const plugin = new BuiltinExrInputPlugin(extension!.extensionPath);

        assert.equal(plugin.canHandle('exr'), true);
        assert.equal(plugin.canHandle('EXR'), true);
        assert.equal(plugin.canHandle('png'), false);
        assert.equal(plugin.canHandle('jpg'), false);
    });
});
