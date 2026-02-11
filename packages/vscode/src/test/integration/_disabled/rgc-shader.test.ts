/**
 * RGC Shader Integration Tests
 *
 * Tests the ACES 2.0 Reference Gamut Compression shader pipeline
 * within the VS Code extension environment.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

// Note: vscode import removed as we're not using vscode APIs in these tests
// The extension path is calculated from __dirname

describe('RGC Shader Integration Tests', () => {
    // Extension path - calculated from __dirname since we're running inside the extension
    let extensionPath: string;

    before(async function() {
        // __dirname is out/src/test/integration when compiled, or src/test/integration when running via ts-node
        // We need to get to packages/vscode (which has package.json)

        // Check if we're running from source (src/) or compiled (out/)
        if (__dirname.includes('/src/test/')) {
            // Running from source via ts-node: src/test/integration → packages/vscode
            // Go up 3 levels: integration → test → src → packages/vscode
            extensionPath = path.resolve(__dirname, '../../..');
        } else {
            // Compiled: out/src/test/integration → packages/vscode
            // Go up 4 levels: integration → test → src → out → packages/vscode
            extensionPath = path.resolve(__dirname, '../../../..');
        }

        console.log('Extension path:', extensionPath);

        // Verify the extension path is correct by checking for package.json
        const packageJsonPath = path.join(extensionPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            console.log('package.json not found at', packageJsonPath);
            console.log('Skipping RGC shader integration tests - extension not built');
            this.skip();
            return;
        }

        // Also check if out/ directory exists (built extension required)
        const outDir = path.join(extensionPath, 'out');
        if (!fs.existsSync(outDir)) {
            console.log('out/ directory not found - extension not built');
            console.log('Run "npm run build" to build the extension first');
            this.skip();
            return;
        }
    });

    it('Extension path should be valid', () => {
        assert.ok(extensionPath, 'Extension path should be set');
        assert.ok(fs.existsSync(path.join(extensionPath, 'package.json')), 'package.json should exist');
        assert.ok(fs.existsSync(path.join(extensionPath, 'out')), 'out directory should exist');
    });

    it('RGC shader builder module should exist', () => {
        const shaderBuilderPath = path.join(extensionPath, 'out', 'shader', 'aces-rgc-shader-builder.js');
        assert.ok(fs.existsSync(shaderBuilderPath), 'aces-rgc-shader-builder.js should exist');
    });

    it('RGC shader builder should be importable', async function() {
        const shaderBuilderPath = path.join(extensionPath, 'out', 'shader', 'aces-rgc-shader-builder.js');

        try {
            // Use dynamic import for ESM compatibility
            const shaderBuilder = await import(shaderBuilderPath);
            assert.ok(shaderBuilder.buildACES2RgcShader, 'buildACES2RgcShader function should exist');
            assert.ok(shaderBuilder.isACES2RgcAvailable, 'isACES2RgcAvailable function should exist');
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available in test environment');
                this.skip();
            }
            throw e;
        }
    });

    it('OCIO module should exist', () => {
        const ocioPath = path.join(extensionPath, 'out', 'ocio', 'index.js');
        assert.ok(fs.existsSync(ocioPath), 'ocio/index.js should exist');
    });

    it('OCIO processor should initialize', async function() {
        const ocioPath = path.join(extensionPath, 'out', 'ocio', 'index.js');

        try {
            const ocio = await import(ocioPath);
            assert.ok(ocio.OCIOProcessor, 'OCIOProcessor class should exist');
            assert.ok(ocio.initOCIO, 'initOCIO function should exist');
            assert.ok(ocio.setWasmDirectory, 'setWasmDirectory function should exist');

            // Initialize OCIO WASM first
            const wasmDir = path.join(extensionPath, 'wasm');
            ocio.setWasmDirectory(wasmDir);
            await ocio.initOCIO();

            const processor = new ocio.OCIOProcessor();
            const initResult = processor.init();
            assert.ok(initResult, 'OCIO processor should initialize');
            processor.dispose();
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available');
                this.skip();
            }
            throw e;
        }
    });

    it('RGC should be available in OCIO', async function() {
        const shaderBuilderPath = path.join(extensionPath, 'out', 'shader', 'aces-rgc-shader-builder.js');

        try {
            const shaderBuilder = await import(shaderBuilderPath);
            const available = shaderBuilder.isACES2RgcAvailable();
            assert.ok(available, 'ACES 2.0 RGC should be available');
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available');
                this.skip();
            }
            throw e;
        }
    });

    it('RGC shader should build successfully at 100 nits', async function () {
        this.timeout(30000); // Allow 30 seconds for shader compilation

        const shaderBuilderPath = path.join(extensionPath, 'out', 'shader', 'aces-rgc-shader-builder.js');

        try {
            const shaderBuilder = await import(shaderBuilderPath);
            const result = await shaderBuilder.buildACES2RgcShader(extensionPath, 100);

            assert.ok(result, 'RGC shader result should exist');
            assert.ok(result.success, `RGC shader should build successfully: ${result.error || 'no error'}`);
            assert.ok(result.wgslCode.length > 0, 'WGSL code should be generated');
            assert.ok(result.glslCode.length > 0, 'GLSL code should be preserved');

            // Check for key RGC functions
            assert.ok(
                result.wgslCode.includes('OCIODisplay') || result.wgslCode.includes('ocio_'),
                'WGSL should contain OCIO functions'
            );

            // Check for hues_array (critical for RGC)
            assert.ok(result.wgslCode.includes('hues_array'), 'WGSL should contain hues_array declaration');

            // Check array type is f32, not i32
            const arrayTypeMatch = result.wgslCode.match(/hues_array\s*:\s*array<([^,>]+)/);
            if (arrayTypeMatch) {
                assert.strictEqual(arrayTypeMatch[1], 'f32', 'hues_array should be array<f32>, not array<i32>');
            }

            console.log(`RGC shader built: WGSL ${result.wgslCode.length} chars, ${result.textures.length} 2D textures`);
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available');
                this.skip();
            }
            throw e;
        }
    });

    it('RGC shader should build successfully at 1000 nits (HDR)', async function () {
        this.timeout(30000); // Allow 30 seconds for shader compilation

        const shaderBuilderPath = path.join(extensionPath, 'out', 'shader', 'aces-rgc-shader-builder.js');

        try {
            const shaderBuilder = await import(shaderBuilderPath);
            const result = await shaderBuilder.buildACES2RgcShader(extensionPath, 1000);

            assert.ok(result, 'RGC shader result should exist');
            assert.ok(result.success, `RGC shader should build successfully at 1000 nits: ${result.error || 'no error'}`);
            assert.ok(result.wgslCode.length > 0, 'WGSL code should be generated');

            console.log(`RGC shader (1000 nits) built: WGSL ${result.wgslCode.length} chars`);
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available');
                this.skip();
            }
            throw e;
        }
    });

    it('Naga processor should initialize', async function() {
        const nagaPath = path.join(extensionPath, 'out', 'naga', 'index.js');
        assert.ok(fs.existsSync(nagaPath), 'naga/index.js should exist');

        try {
            const naga = await import(nagaPath);
            assert.ok(naga.getNagaProcessor, 'getNagaProcessor function should exist');

            const processor = naga.getNagaProcessor();
            await processor.init(extensionPath);
            assert.ok(processor.isInitialized, 'Naga processor should be initialized');
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available');
                this.skip();
            }
            throw e;
        }
    });

    it('DCTL compute shader builder module should exist', async function() {
        const computeBuilderPath = path.join(extensionPath, 'out', 'shader', 'dctl-compute-wgsl-builder.js');
        assert.ok(fs.existsSync(computeBuilderPath), 'dctl-compute-wgsl-builder.js should exist');

        try {
            const computeBuilder = await import(computeBuilderPath);
            assert.ok(computeBuilder.buildDctlComputeShader, 'buildDctlComputeShader should exist');
        } catch (e: any) {
            if (e.message?.includes('vscode') || e.code === 'ERR_MODULE_NOT_FOUND') {
                console.log('Skipping test - module depends on vscode which is not available');
                this.skip();
            }
            throw e;
        }
    });
});
