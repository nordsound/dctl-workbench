/**
 * Custom OCIO Shader Pipeline Tests
 *
 * Tests for extracting GPU shaders from custom OCIO configs and building
 * compute/export shaders in custom OCIO mode.
 *
 * Phase 2 of the user-defined OCIO config support plan.
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { resolveFixture } from '../../test-paths';
import {
    initOCIO,
    isOCIOInitialized,
} from '../../ocio/index';
import {
    extractCustomOcioShaders,
    buildCustomOcioComputeShader,
    extractCustomOcioExportShaders,
} from '../../shader/custom-ocio-shader-builder';

const WASM_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** Check if OCIO WASM files exist */
function ocioWasmAvailable(): boolean {
    const wasmFile = path.join(WASM_DIR, 'wasm', 'ocio.wasm');
    return fs.existsSync(wasmFile);
}

describe('Custom OCIO Shader Pipeline', function () {
    this.timeout(30000);
    const configPath = resolveFixture('test-ocio-config', 'config.ocio');

    before(async function () {
        if (!ocioWasmAvailable()) {
            this.skip();
            return;
        }
        if (!configPath) {
            this.skip();
            return;
        }
        if (!isOCIOInitialized()) {
            await initOCIO(WASM_DIR);
        }
    });

    describe('extractCustomOcioShaders', () => {
        it('should extract source→working GPU shader as GLSL', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(result.sourceToWorking.glsl.length > 0,
                'Source→working GLSL should not be empty');
            assert.ok(result.sourceToWorking.glsl.includes('OCIODisplay'),
                'Source→working GLSL should contain OCIODisplay function');
        });

        it('should extract source→working GPU shader textures', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            // Source→working transform may or may not have LUT textures
            // depending on the config, but the arrays should exist
            assert.ok(Array.isArray(result.sourceToWorking.textures));
            assert.ok(Array.isArray(result.sourceToWorking.textures3D));
        });

        it('should extract chained working→display GPU shader as GLSL', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(result.workingToDisplay.glsl.length > 0,
                'Working→display GLSL should not be empty');
            assert.ok(result.workingToDisplay.glsl.includes('OCIODisplay'),
                'Working→display GLSL should contain OCIODisplay function');
        });

        it('should extract working→display GPU shader textures', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(Array.isArray(result.workingToDisplay.textures));
            assert.ok(Array.isArray(result.workingToDisplay.textures3D));
        });

        it('should prefix source→working GLSL function names with sw_ocio_', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Extraction failed: ${result.error}`);
            // Internal OCIO functions should be prefixed with sw_ocio_
            assert.ok(result.sourceToWorking.glsl.includes('sw_OCIODisplay'),
                'GLSL should contain sw_OCIODisplay function');
            // Should not contain unprefixed ocio_ functions
            assert.ok(!result.sourceToWorking.glsl.match(/(?<!sw_)\bocio_/),
                'GLSL should not contain unprefixed ocio_ functions');
        });

        it('should prefix working→display GLSL function names with wd_ocio_', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Extraction failed: ${result.error}`);
            // Internal OCIO functions should be prefixed with wd_ocio_
            assert.ok(result.workingToDisplay.glsl.includes('wd_OCIODisplay'),
                'GLSL should contain wd_OCIODisplay function');
            // Should not contain unprefixed ocio_ functions
            assert.ok(!result.workingToDisplay.glsl.match(/(?<!wd_)\bocio_/),
                'GLSL should not contain unprefixed ocio_ functions');
        });

        it('should prefix source→working functions with sw_', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            // The main function should be renamed to sw_OCIODisplay
            assert.ok(result.sourceToWorking.mainFunction === 'sw_OCIODisplay' ||
                result.sourceToWorking.mainFunction.startsWith('sw_'),
                `Source→working main function should start with sw_, got: ${result.sourceToWorking.mainFunction}`);
        });

        it('should prefix working→display functions with wd_', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            // The main function should be renamed to wd_OCIODisplay
            assert.ok(result.workingToDisplay.mainFunction === 'wd_OCIODisplay' ||
                result.workingToDisplay.mainFunction.startsWith('wd_'),
                `Working→display main function should start with wd_, got: ${result.workingToDisplay.mainFunction}`);
        });

        it('should fail gracefully with invalid config path', function () {
            const result = extractCustomOcioShaders('/nonexistent/config.ocio', {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.equal(result.success, false);
            assert.ok(result.error && result.error.length > 0);
        });

        it('should fail gracefully with invalid color space names', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'nonexistent_space',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.equal(result.success, false);
        });
    });

    describe('buildCustomOcioComputeShader', () => {
        it('should build a complete compute shader WGSL without DCTL', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success, `Extraction failed: ${extracted.error}`);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            assert.ok(result.computeWgsl.length > 0, 'Compute WGSL should not be empty');
        });

        it('should contain source_texture binding in WGSL', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            assert.ok(result.computeWgsl.includes('source_texture'),
                'WGSL should reference source_texture');
            assert.ok(result.computeWgsl.includes('output_texture'),
                'WGSL should reference output_texture');
        });

        it('should contain sw_ prefixed functions for source→working', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            // Should call the sw_ prefixed main function somewhere in the shader
            assert.ok(result.computeWgsl.includes('sw_'),
                'WGSL should contain sw_ prefixed functions');
        });

        it('should contain wd_ prefixed functions for working→display', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            assert.ok(result.computeWgsl.includes('wd_'),
                'WGSL should contain wd_ prefixed functions');
        });

        it('should contain @compute entry point', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            assert.ok(result.computeWgsl.includes('@compute'),
                'WGSL should contain @compute entry point');
        });

        it('should NOT contain hardcoded ACES matrices', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            // Should NOT contain AP0→AP1 matrix values
            assert.ok(!result.computeWgsl.includes('1.4514393161'),
                'WGSL should NOT contain hardcoded AP0→AP1 matrix');
            assert.ok(!result.computeWgsl.includes('0.6954522414'),
                'WGSL should NOT contain hardcoded AP1→AP0 matrix');
        });

        it('should return combined LUT textures from both shaders', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
                display: 'sRGB',
                view: 'Film',
            });
            assert.ok(extracted.success);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            // Textures should be the combination of sw_ and wd_ textures
            assert.ok(Array.isArray(result.textures));
            assert.ok(Array.isArray(result.textures3D));
        });
    });

    describe('extractCustomOcioExportShaders', () => {
        it('should extract source→working and working→source shaders', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioExportShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(result.sourceToWorking.glsl.length > 0,
                'Source→working GLSL should not be empty');
            assert.ok(result.workingToSource.glsl.length > 0,
                'Working→source GLSL should not be empty');
        });

        it('should prefix source→working functions with sw_', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioExportShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.equal(result.sourceToWorking.mainFunction, 'sw_OCIODisplay');
        });

        it('should prefix working→source functions with ws_', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioExportShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'linear_working',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.equal(result.workingToSource.mainFunction, 'ws_OCIODisplay');
        });

        it('should fail gracefully with invalid color space', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioExportShaders(configPath, {
                sourceColorSpace: 'nonexistent',
                workingColorSpace: 'linear_working',
            });
            assert.equal(result.success, false);
        });
    });
});
