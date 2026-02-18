/**
 * DaVinci Wide Gamut OCIO Config Tests
 *
 * Tests for loading and using a DaVinci Wide Gamut / Intermediate
 * custom OCIO config. Uses OCIO v2 built-in transforms (no LUT files).
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { resolveFixture } from '../../test-paths';
import {
    initOCIO,
    OCIOProcessor,
    isOCIOInitialized,
    validateOcioConfig,
} from '../../ocio/index';
import {
    extractCustomOcioShaders,
    buildCustomOcioComputeShader,
} from '../../shader/custom-ocio-shader-builder';

const WASM_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..');

function ocioWasmAvailable(): boolean {
    const wasmFile = path.join(WASM_DIR, 'wasm', 'ocio.wasm');
    return fs.existsSync(wasmFile);
}

describe('DaVinci Wide Gamut OCIO Config', function () {
    this.timeout(30000);
    const configPath = resolveFixture('dwg-ocio-config', 'config.ocio');

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

    describe('Config Loading', () => {
        let processor: OCIOProcessor;

        beforeEach(() => {
            processor = new OCIOProcessor();
        });

        afterEach(() => {
            processor.dispose();
        });

        it('should load DWG config from file', function () {
            if (!configPath) return this.skip();
            const result = processor.initFromFile(configPath);
            assert.equal(result, true, `Failed to load config: ${processor.getLastError()}`);
        });

        it('should list DWG color spaces', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const spaces = processor.getColorSpaces();
            assert.ok(spaces.includes('DaVinci Intermediate WideGamut'), 'Should include DaVinci Intermediate WideGamut');
            assert.ok(spaces.includes('Linear DaVinci WideGamut'), 'Should include Linear DaVinci WideGamut');
            assert.ok(spaces.includes('reference'), 'Should include reference');
            assert.ok(spaces.includes('raw'), 'Should include raw');
        });

        it('should list sRGB display', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const displays = processor.getDisplays();
            assert.ok(displays.includes('sRGB'), 'Should include sRGB display');
        });

        it('should list views for sRGB display', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            const views = processor.getViews('sRGB');
            assert.ok(views.includes('Raw'), 'Should include Raw view');
            assert.ok(views.includes('DWG Display'), 'Should include DWG Display view');
        });

        it('should identify scene-referred color spaces', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            assert.equal(processor.isSceneReferred('DaVinci Intermediate WideGamut'), true);
            assert.equal(processor.isSceneReferred('Linear DaVinci WideGamut'), true);
            assert.equal(processor.isSceneReferred('reference'), true);
        });

        it('should report correct color space families', function () {
            if (!configPath) return this.skip();
            processor.initFromFile(configPath);
            assert.equal(processor.getColorSpaceFamily('DaVinci Intermediate WideGamut'), 'Scene');
            assert.equal(processor.getColorSpaceFamily('Linear DaVinci WideGamut'), 'Scene');
            assert.equal(processor.getColorSpaceFamily('raw'), 'Utility');
            assert.equal(processor.getColorSpaceFamily('srgb_display'), 'Display');
        });
    });

    describe('Validation', () => {
        it('should validate DWG config successfully', function () {
            if (!configPath) return this.skip();
            const result = validateOcioConfig(configPath);
            assert.equal(result.valid, true, `Expected valid but got errors: ${result.errors.join(', ')}`);
            assert.equal(result.errors.length, 0);
        });

        it('should have no warnings (no LUT files referenced)', function () {
            if (!configPath) return this.skip();
            const result = validateOcioConfig(configPath);
            assert.equal(result.warnings.length, 0, `Unexpected warnings: ${result.warnings.join(', ')}`);
        });

        it('should report scene-referred spaces', function () {
            if (!configPath) return this.skip();
            const result = validateOcioConfig(configPath);
            assert.ok(result.sceneReferredSpaces.length >= 3, 'Should have at least 3 scene-referred spaces');
            assert.ok(result.sceneReferredSpaces.includes('DaVinci Intermediate WideGamut'));
            assert.ok(result.sceneReferredSpaces.includes('Linear DaVinci WideGamut'));
        });
    });

    describe('Transform Creation', () => {
        let processor: OCIOProcessor;

        beforeEach(() => {
            processor = new OCIOProcessor();
            if (configPath) {
                processor.initFromFile(configPath);
            }
        });

        afterEach(() => {
            processor.dispose();
        });

        it('should create DaVinci Intermediate -> reference transform', function () {
            if (!configPath) return this.skip();
            const result = processor.createTransform('DaVinci Intermediate WideGamut', 'reference');
            assert.equal(result, true, `Failed: ${processor.getLastError()}`);
            assert.equal(processor.hasTransform(), true);
        });

        it('should create reference -> Linear DWG transform', function () {
            if (!configPath) return this.skip();
            const result = processor.createTransform('reference', 'Linear DaVinci WideGamut');
            assert.equal(result, true, `Failed: ${processor.getLastError()}`);
            assert.equal(processor.hasTransform(), true);
        });

        it('should create chained display transform', function () {
            if (!configPath) return this.skip();
            const result = processor.createChainedDisplayTransform(
                'DaVinci Intermediate WideGamut', 'reference', 'sRGB', 'DWG Display'
            );
            assert.equal(result, true, `Failed: ${processor.getLastError()}`);
            assert.equal(processor.hasTransform(), true);
        });
    });

    describe('Numerical Validation', () => {
        // Use initFromString to avoid NODEFS mount conflicts between processors
        let configYaml: string;

        before(function () {
            if (!configPath) return this.skip();
            configYaml = fs.readFileSync(configPath, 'utf-8');
        });

        it('should round-trip reference -> DaVinci Intermediate -> reference', function () {
            if (!configPath) return this.skip();
            const input = new Float32Array([0.18, 0.18, 0.18]);

            // Forward: reference -> DaVinci Intermediate WideGamut
            const fwd = new OCIOProcessor();
            fwd.initFromString(configYaml);
            fwd.createTransform('reference', 'DaVinci Intermediate WideGamut');
            fwd.applyRGB(input);
            fwd.dispose();

            // Inverse: DaVinci Intermediate WideGamut -> reference
            const inv = new OCIOProcessor();
            inv.initFromString(configYaml);
            inv.createTransform('DaVinci Intermediate WideGamut', 'reference');
            inv.applyRGB(input);
            inv.dispose();

            // Should be close to original (0.18, 0.18, 0.18)
            const tolerance = 1e-4;
            assert.ok(Math.abs(input[0] - 0.18) < tolerance, `R: expected ~0.18, got ${input[0]}`);
            assert.ok(Math.abs(input[1] - 0.18) < tolerance, `G: expected ~0.18, got ${input[1]}`);
            assert.ok(Math.abs(input[2] - 0.18) < tolerance, `B: expected ~0.18, got ${input[2]}`);
        });

        it('should round-trip reference -> Linear DWG -> reference', function () {
            if (!configPath) return this.skip();
            const input = new Float32Array([0.5, 0.3, 0.1]);

            const fwd = new OCIOProcessor();
            fwd.initFromString(configYaml);
            fwd.createTransform('reference', 'Linear DaVinci WideGamut');
            fwd.applyRGB(input);
            fwd.dispose();

            const inv = new OCIOProcessor();
            inv.initFromString(configYaml);
            inv.createTransform('Linear DaVinci WideGamut', 'reference');
            inv.applyRGB(input);
            inv.dispose();

            const tolerance = 1e-5;
            assert.ok(Math.abs(input[0] - 0.5) < tolerance, `R: expected ~0.5, got ${input[0]}`);
            assert.ok(Math.abs(input[1] - 0.3) < tolerance, `G: expected ~0.3, got ${input[1]}`);
            assert.ok(Math.abs(input[2] - 0.1) < tolerance, `B: expected ~0.1, got ${input[2]}`);
        });
    });

    describe('GPU Shader Extraction', () => {
        it('should extract shaders with DWG working space', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'DaVinci Intermediate WideGamut',
                display: 'sRGB',
                view: 'DWG Display',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(result.sourceToWorking.glsl.length > 0, 'Source→working GLSL should not be empty');
            assert.ok(result.workingToDisplay.glsl.length > 0, 'Working→display GLSL should not be empty');
        });

        it('should produce non-trivial GLSL for DWG transforms', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'DaVinci Intermediate WideGamut',
                display: 'sRGB',
                view: 'DWG Display',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            // LogCameraTransform + MatrixTransform should produce GLSL with math ops
            assert.ok(result.sourceToWorking.glsl.includes('log') || result.sourceToWorking.glsl.includes('mat'),
                'Source→working GLSL should contain log or matrix operations');
            assert.ok(result.workingToDisplay.glsl.includes('log') || result.workingToDisplay.glsl.includes('mat'),
                'Working→display GLSL should contain log or matrix operations');
        });

        it('should prefix functions correctly (sw_/wd_)', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'DaVinci Intermediate WideGamut',
                display: 'sRGB',
                view: 'DWG Display',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(result.sourceToWorking.mainFunction.startsWith('sw_'),
                `Expected sw_ prefix, got: ${result.sourceToWorking.mainFunction}`);
            assert.ok(result.workingToDisplay.mainFunction.startsWith('wd_'),
                `Expected wd_ prefix, got: ${result.workingToDisplay.mainFunction}`);
        });

        it('should build valid compute shader WGSL', async function () {
            if (!configPath) return this.skip();
            const extracted = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'DaVinci Intermediate WideGamut',
                display: 'sRGB',
                view: 'DWG Display',
            });
            assert.ok(extracted.success, `Extraction failed: ${extracted.error}`);

            const result = await buildCustomOcioComputeShader(WASM_DIR, extracted);
            assert.ok(result.success, `Build failed: ${result.error}`);
            assert.ok(result.computeWgsl.includes('@compute'), 'WGSL should have @compute entry point');
        });

        it('should also work with Linear DWG as working space', function () {
            if (!configPath) return this.skip();
            const result = extractCustomOcioShaders(configPath, {
                sourceColorSpace: 'reference',
                workingColorSpace: 'Linear DaVinci WideGamut',
                display: 'sRGB',
                view: 'DWG Display',
            });
            assert.ok(result.success, `Failed: ${result.error}`);
            assert.ok(result.sourceToWorking.glsl.length > 0);
            assert.ok(result.workingToDisplay.glsl.length > 0);
        });
    });
});
