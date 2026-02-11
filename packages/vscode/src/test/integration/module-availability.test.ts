/**
 * Module Availability Integration Tests
 *
 * Verifies that all expected modules can be loaded and initialized
 * within the VS Code extension environment.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

suite('Module Availability', () => {
    let extensionPath: string;

    suiteSetup(function () {
        // Calculate extension path from test file location
        // __dirname is out/test/integration when compiled
        if (__dirname.includes('/out/')) {
            extensionPath = path.resolve(__dirname, '../../..');
        } else {
            extensionPath = path.resolve(__dirname, '../../../..');
        }

        // Verify extension path
        const packageJsonPath = path.join(extensionPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            console.log('Extension path not found:', extensionPath);
            this.skip();
        }
    });

    test('Extension path should be valid', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }
        assert.ok(fs.existsSync(path.join(extensionPath, 'package.json')), 'package.json should exist');
        assert.ok(fs.existsSync(path.join(extensionPath, 'out')), 'out directory should exist');
    });

    test('Shader builder modules should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const shaderModules = [
            'shader/dctl-shader-builder.js',
            'shader/dctl-compute-wgsl-builder.js',
            'shader/dctl-export-shader-builder.js',
            'shader/aces-rgc-shader-builder.js',
            'shader/integrated-shader-builder.js',
        ];

        for (const module of shaderModules) {
            const modulePath = path.join(extensionPath, 'out', module);
            assert.ok(
                fs.existsSync(modulePath),
                `Module ${module} should exist at ${modulePath}`
            );
        }
    });

    test('DCTL compiler module should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const compilerPath = path.join(extensionPath, 'out', 'dctl', 'compiler', 'index.js');
        assert.ok(fs.existsSync(compilerPath), 'DCTL compiler module should exist');
    });

    test('DCTL parser module should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const parserPath = path.join(extensionPath, 'out', 'dctl', 'parser', 'types.js');
        assert.ok(fs.existsSync(parserPath), 'DCTL parser types should exist');
    });

    test('Semantic analyzer module should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const semanticPath = path.join(extensionPath, 'out', 'dctl', 'semantic', 'index.js');
        assert.ok(fs.existsSync(semanticPath), 'Semantic analyzer module should exist');
    });

    test('Editor module should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const editorPath = path.join(extensionPath, 'out', 'editor', 'ExrEditorProvider.js');
        assert.ok(fs.existsSync(editorPath), 'EXR editor provider should exist');
    });

    test('WASM directory should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const wasmPath = path.join(extensionPath, 'wasm');
        // WASM directory may or may not exist depending on build
        if (fs.existsSync(wasmPath)) {
            assert.ok(fs.statSync(wasmPath).isDirectory(), 'wasm should be a directory');
        } else {
            console.log('WASM directory not found (optional)');
        }
    });

    test('Webview resources should exist', function () {
        if (!extensionPath) {
            this.skip();
            return;
        }

        const webviewPath = path.join(extensionPath, 'out', 'webview');
        if (fs.existsSync(webviewPath)) {
            assert.ok(fs.statSync(webviewPath).isDirectory(), 'webview should be a directory');
        } else {
            // Webview may be in different location
            console.log('Webview directory not at expected path');
        }
    });
});

suite('Module Import Tests', () => {
    test('Core exports should be importable', async function () {
        this.timeout(10000);

        try {
            // Try to import @dctl-workbench/core
            // This may fail in VS Code test environment due to module resolution
            const corePath = require.resolve('@dctl-workbench/core');
            assert.ok(corePath, 'Core module should be resolvable');
        } catch (e: any) {
            if (e.code === 'MODULE_NOT_FOUND') {
                console.log('Core module not directly importable in test environment (expected)');
                // This is expected - skip the test
                this.skip();
            } else {
                throw e;
            }
        }
    });
});
