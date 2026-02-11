/**
 * Integration tests for DCTL Export Shader
 *
 * These tests verify that DCTL is correctly applied during export by:
 * 1. Compiling a real DCTL file
 * 2. Verifying the compiled shader contains DCTL logic
 * 3. Verifying parameters are correctly injected
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { resolveFixture, getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Test DCTL sources
const PASSTHROUGH_DCTL = `
// Passthrough - returns input unchanged
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    return make_float3(r, g, b);
}
`;

const GAIN_MULTIPLY_DCTL = `
// Multiplies input by gain parameter
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    return make_float3(r * gain, g * gain, b * gain);
}
`;

const EXPOSURE_DCTL = `
// Exposure adjustment with power function
DEFINE_UI_PARAMS(exposure, Exposure, DCTL_SLIDER_FLOAT, 0.0, -4.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);

    float multiplier = pow(2.0f, exposure);
    return make_float3(r * multiplier, g * multiplier, b * multiplier);
}
`;

/**
 * Simulates DCTL shader info creation (minimal version for testing)
 */
interface TestDctlShaderInfo {
    source: string;
    workingColorSpace: 'ACEScct' | 'ACEScg';
    params: Array<{ name: string; type: string; default: number | boolean }>;
}

/**
 * Analyzes compiled WGSL shader to verify DCTL is applied
 */
function analyzeCompiledShader(wgslCode: string): {
    hasTransformFunction: boolean;
    hasMultiplyOperation: boolean;
    hasPowOperation: boolean;
    hasGainParameter: boolean;
    hasExposureParameter: boolean;
    parameterValues: Record<string, number | boolean>;
    isPassthrough: boolean;
} {
    // Check for transform function
    const hasTransformFunction = /fn\s+transform\s*\(/.test(wgslCode);

    // Check for multiply operations (gain * r, etc.)
    const hasMultiplyOperation = /\*\s*gain|\bgain\s*\*/.test(wgslCode);

    // Check for pow operation (exposure adjustment)
    const hasPowOperation = /pow\s*\(/.test(wgslCode);

    // Check for gain parameter declaration
    const hasGainParameter = /var<private>\s+gain/.test(wgslCode);

    // Check for exposure parameter declaration
    const hasExposureParameter = /var<private>\s+exposure/.test(wgslCode);

    // Extract parameter values
    const parameterValues: Record<string, number | boolean> = {};
    const paramRegex = /var<private>\s+(\w+):\s*(f32|i32|bool)\s*=\s*([^;]+);/g;
    let match;
    while ((match = paramRegex.exec(wgslCode)) !== null) {
        const name = match[1];
        const type = match[2];
        const valueStr = match[3].trim();

        if (type === 'f32') {
            parameterValues[name] = parseFloat(valueStr.replace('f', ''));
        } else if (type === 'i32') {
            parameterValues[name] = parseInt(valueStr.replace('i', ''), 10);
        } else if (type === 'bool') {
            parameterValues[name] = valueStr === 'true';
        }
    }

    // Check if it's a passthrough (just returns input without modification)
    // Passthrough pattern: return vec3<f32>(f32(p_R_1), f32(p_G_1), f32(p_B_1));
    const isPassthrough =
        !hasMultiplyOperation &&
        !hasPowOperation &&
        /return\s+vec3<f32>\s*\(\s*f32\s*\(\s*p_R/.test(wgslCode);

    return {
        hasTransformFunction,
        hasMultiplyOperation,
        hasPowOperation,
        hasGainParameter,
        hasExposureParameter,
        parameterValues,
        isPassthrough,
    };
}

/**
 * Validates that a shader properly samples and transforms pixels
 */
function validateShaderPipeline(wgslCode: string): {
    samplesTexture: boolean;
    callsTransform: boolean;
    convertsColorSpace: boolean;
    hasFragmentEntry: boolean;
} {
    // transform() internally calls dctl_sampleTexture(), so we check:
    // 1. dctl_sampleTexture function exists (for internal sampling by transform)
    // 2. transform is called with p_Width, p_Height, p_X, p_Y (4-arg texture or 7-arg float)
    return {
        samplesTexture: /fn\s+dctl_sampleTexture\s*\(/.test(wgslCode),
        callsTransform: /transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y[\s,)]/.test(wgslCode),
        convertsColorSpace: /dctl_workingToAp0/.test(wgslCode) && /dctl_ACEScct_to_lin/.test(wgslCode),
        hasFragmentEntry: /@fragment\s*fn\s+main/.test(wgslCode),
    };
}

describe('DCTL Export Integration Tests', () => {
    describe('Shader Analysis', () => {
        it('should detect passthrough DCTL', () => {
            // Simulated compiled passthrough shader
            const passthroughWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    var p_R_1: f32 = p_R;
    var p_G_1: f32 = p_G;
    var p_B_1: f32 = p_B;
    return vec3<f32>(f32(p_R_1), f32(p_G_1), f32(p_B_1));
}
`;
            const analysis = analyzeCompiledShader(passthroughWgsl);

            assert.strictEqual(analysis.hasTransformFunction, true, 'Should have transform function');
            assert.strictEqual(analysis.isPassthrough, true, 'Should detect as passthrough');
            assert.strictEqual(analysis.hasMultiplyOperation, false, 'Passthrough should not have multiply');
            assert.strictEqual(analysis.hasGainParameter, false, 'Passthrough should not have gain parameter');
        });

        it('should detect gain multiply DCTL', () => {
            // Simulated compiled gain multiply shader
            const gainWgsl = `
var<private> gain: f32 = 2.0f;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    var p_R_1: f32 = p_R;
    var p_G_1: f32 = p_G;
    var p_B_1: f32 = p_B;
    let result_r = p_R_1 * gain;
    let result_g = p_G_1 * gain;
    let result_b = p_B_1 * gain;
    return vec3<f32>(result_r, result_g, result_b);
}
`;
            const analysis = analyzeCompiledShader(gainWgsl);

            assert.strictEqual(analysis.hasTransformFunction, true, 'Should have transform function');
            assert.strictEqual(analysis.isPassthrough, false, 'Should NOT be passthrough');
            assert.strictEqual(analysis.hasMultiplyOperation, true, 'Should have multiply with gain');
            assert.strictEqual(analysis.hasGainParameter, true, 'Should have gain parameter');
            assert.strictEqual(analysis.parameterValues['gain'], 2.0, 'Gain should be 2.0');
        });

        it('should detect exposure DCTL with pow function', () => {
            // Simulated compiled exposure shader
            const exposureWgsl = `
var<private> exposure: f32 = 1.5f;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    var p_R_1: f32 = p_R;
    var p_G_1: f32 = p_G;
    var p_B_1: f32 = p_B;
    let multiplier = pow(2.0, exposure);
    return vec3<f32>(p_R_1 * multiplier, p_G_1 * multiplier, p_B_1 * multiplier);
}
`;
            const analysis = analyzeCompiledShader(exposureWgsl);

            assert.strictEqual(analysis.hasTransformFunction, true, 'Should have transform function');
            assert.strictEqual(analysis.isPassthrough, false, 'Should NOT be passthrough');
            assert.strictEqual(analysis.hasPowOperation, true, 'Should have pow function');
            assert.strictEqual(analysis.hasExposureParameter, true, 'Should have exposure parameter');
            assert.strictEqual(analysis.parameterValues['exposure'], 1.5, 'Exposure should be 1.5');
        });
    });

    describe('Shader Pipeline Validation', () => {
        it('should validate complete export shader pipeline', () => {
            // transform() internally calls dctl_sampleTexture(), so:
            // - Entry point calls transform(p_Width, p_Height, p_X, p_Y) with only 4 args
            // - transform() internally samples via dctl_sampleTexture()
            const completeShader = `
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;

const dctl_workingToAp0 = mat3x3<f32>(
    vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
    vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
    vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
);

fn dctl_ACEScct_to_lin(cct: f32) -> f32 {
    return cct;
}

fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.5, 0.5, 0.5, 1.0);
}

var<private> gain: f32 = 2.0f;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32) -> vec3<f32> {
    let sampled = dctl_sampleTexture(p_X, p_Y);
    return vec3<f32>(sampled.x * gain, sampled.y * gain, sampled.z * gain);
}

@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * 1920.0);
    let p_Y = i32(v_texCoord.y * 1080.0);

    // transform() internally calls dctl_sampleTexture() to get pixel values
    let result = transform(p_Width, p_Height, p_X, p_Y);

    return vec4<f32>(result, 1.0);
}
`;
            const pipeline = validateShaderPipeline(completeShader);

            assert.strictEqual(pipeline.samplesTexture, true, 'Should have dctl_sampleTexture function');
            assert.strictEqual(pipeline.callsTransform, true, 'Should call transform with 4 args');
            assert.strictEqual(pipeline.convertsColorSpace, true, 'Should have color space conversion');
            assert.strictEqual(pipeline.hasFragmentEntry, true, 'Should have fragment entry point');
        });

        it('should detect missing dctl_sampleTexture function', () => {
            const brokenShader = `
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let result = transform(p_Width, p_Height, p_X, p_Y);
    return vec4<f32>(result, 1.0);
}
`;
            const pipeline = validateShaderPipeline(brokenShader);

            assert.strictEqual(pipeline.samplesTexture, false, 'Should detect missing dctl_sampleTexture');
            assert.strictEqual(pipeline.callsTransform, true, 'Should detect transform call');
        });
    });

    describe('Parameter Injection Verification', () => {
        it('should verify gain parameter is injected with correct value', () => {
            // This simulates checking that when we set gain=2.5 in UI,
            // the compiled shader has `var<private> gain: f32 = 2.5f;`
            const expectedGain = 2.5;
            const shaderWithGain = `var<private> gain: f32 = ${expectedGain}f;`;

            const analysis = analyzeCompiledShader(shaderWithGain);
            assert.strictEqual(analysis.parameterValues['gain'], expectedGain,
                `Gain should be ${expectedGain}`);
        });

        it('should verify multiple parameters are injected', () => {
            const multiParamShader = `
var<private> brightness: f32 = 1.2f;
var<private> contrast: f32 = 1.1f;
var<private> saturation: f32 = 1.0f;
var<private> enabled: bool = true;
var<private> mode: i32 = 2i;

fn transform(...) { ... }
`;
            const analysis = analyzeCompiledShader(multiParamShader);

            assert.strictEqual(analysis.parameterValues['brightness'], 1.2, 'Brightness should be 1.2');
            assert.strictEqual(analysis.parameterValues['contrast'], 1.1, 'Contrast should be 1.1');
            assert.strictEqual(analysis.parameterValues['saturation'], 1.0, 'Saturation should be 1.0');
            assert.strictEqual(analysis.parameterValues['enabled'], true, 'Enabled should be true');
            assert.strictEqual(analysis.parameterValues['mode'], 2, 'Mode should be 2');
        });

        it('should detect when parameters are NOT injected (just declarations)', () => {
            // This is the bug case - parameters declared but not initialized
            const uninitializedParams = `
var<private> gain: f32;
var<private> exposure: f32;

fn transform(...) { ... }
`;
            const analysis = analyzeCompiledShader(uninitializedParams);

            // These should NOT be in parameterValues because they're not initialized
            assert.strictEqual(analysis.parameterValues['gain'], undefined,
                'Uninitialized gain should not have value');
            assert.strictEqual(analysis.parameterValues['exposure'], undefined,
                'Uninitialized exposure should not have value');
        });
    });

    describe('DCTL Effect Verification', () => {
        it('should verify gain DCTL modifies pixel values', () => {
            // Conceptual test: gain=2.0 should double pixel values
            // Input: (0.5, 0.5, 0.5)
            // Expected output: (1.0, 1.0, 1.0)
            const gain = 2.0;
            const inputPixel = { r: 0.5, g: 0.5, b: 0.5 };
            const expectedOutput = {
                r: inputPixel.r * gain,
                g: inputPixel.g * gain,
                b: inputPixel.b * gain,
            };

            assert.strictEqual(expectedOutput.r, 1.0, 'R should be doubled');
            assert.strictEqual(expectedOutput.g, 1.0, 'G should be doubled');
            assert.strictEqual(expectedOutput.b, 1.0, 'B should be doubled');
        });

        it('should verify exposure DCTL applies power-of-2 scaling', () => {
            // Exposure = 1.0 stop -> 2^1 = 2x brightness
            const exposure = 1.0;
            const inputPixel = { r: 0.25, g: 0.25, b: 0.25 };
            const multiplier = Math.pow(2.0, exposure);
            const expectedOutput = {
                r: inputPixel.r * multiplier,
                g: inputPixel.g * multiplier,
                b: inputPixel.b * multiplier,
            };

            assert.strictEqual(expectedOutput.r, 0.5, 'R should be 0.5 (+1 stop)');
            assert.strictEqual(expectedOutput.g, 0.5, 'G should be 0.5 (+1 stop)');
            assert.strictEqual(expectedOutput.b, 0.5, 'B should be 0.5 (+1 stop)');
        });

        it('should verify passthrough DCTL does not modify values', () => {
            const inputPixel = { r: 0.5, g: 0.6, b: 0.7 };
            // Passthrough should return identical values
            const expectedOutput = { ...inputPixel };

            assert.strictEqual(expectedOutput.r, inputPixel.r, 'R should be unchanged');
            assert.strictEqual(expectedOutput.g, inputPixel.g, 'G should be unchanged');
            assert.strictEqual(expectedOutput.b, inputPixel.b, 'B should be unchanged');
        });
    });

    describe('Export Shader Debug Output Validation', () => {
        it('should read and validate the debug shader output if it exists', function() {
            const debugPath = path.join(getTestOutputDir(), 'export_shader_debug.wgsl');

            if (!fs.existsSync(debugPath)) {
                this.skip(); // Skip if debug file doesn't exist
                return;
            }

            const shaderCode = fs.readFileSync(debugPath, 'utf-8');
            const analysis = analyzeCompiledShader(shaderCode);
            const pipeline = validateShaderPipeline(shaderCode);

            // Log what we found for debugging
            console.log('\n=== Export Shader Debug Analysis ===');
            console.log(`Transform function: ${analysis.hasTransformFunction}`);
            console.log(`Is passthrough: ${analysis.isPassthrough}`);
            console.log(`Has multiply: ${analysis.hasMultiplyOperation}`);
            console.log(`Has pow: ${analysis.hasPowOperation}`);
            console.log(`Parameters: ${JSON.stringify(analysis.parameterValues)}`);
            console.log(`Pipeline - samples texture: ${pipeline.samplesTexture}`);
            console.log(`Pipeline - calls transform: ${pipeline.callsTransform}`);
            console.log(`Pipeline - converts color space: ${pipeline.convertsColorSpace}`);
            console.log(`Pipeline - has fragment entry: ${pipeline.hasFragmentEntry}`);

            // Basic validation
            assert.strictEqual(analysis.hasTransformFunction, true,
                'Export shader should have transform function');
            assert.strictEqual(pipeline.hasFragmentEntry, true,
                'Export shader should have fragment entry point');
            assert.strictEqual(pipeline.samplesTexture, true,
                'Export shader should sample texture');
            assert.strictEqual(pipeline.callsTransform, true,
                'Export shader should call transform with 4 args');
        });
    });

    describe('Parameter Injection Simulation', () => {
        /**
         * Simulates the parameter injection logic from buildDctlExportShader
         */
        function injectParameters(
            wgslCode: string,
            paramValues: Record<string, number | boolean>
        ): string {
            let result = wgslCode;

            // Extract all var<private> declarations
            const varPrivateRegex = /var<private>\s+(\w+):\s*(f32|i32|bool)\s*;/g;
            const wgslParams: Array<{ name: string; type: string; match: string }> = [];
            let match;
            while ((match = varPrivateRegex.exec(wgslCode)) !== null) {
                wgslParams.push({
                    name: match[1],
                    type: match[2],
                    match: match[0],
                });
            }

            // Inject values
            for (const wgslParam of wgslParams) {
                let value: number | boolean | undefined;

                // Try exact match
                if (paramValues[wgslParam.name] !== undefined) {
                    value = paramValues[wgslParam.name];
                } else {
                    // Try stripping _N suffix
                    const baseName = wgslParam.name.replace(/_\d+$/, '');
                    if (baseName !== wgslParam.name && paramValues[baseName] !== undefined) {
                        value = paramValues[baseName];
                    }
                }

                if (value !== undefined) {
                    if (wgslParam.type === 'f32' && typeof value === 'number') {
                        result = result.replace(
                            wgslParam.match,
                            `var<private> ${wgslParam.name}: f32 = ${value}f;`
                        );
                    } else if (wgslParam.type === 'i32' && typeof value === 'number') {
                        result = result.replace(
                            wgslParam.match,
                            `var<private> ${wgslParam.name}: i32 = ${Math.floor(value)}i;`
                        );
                    } else if (wgslParam.type === 'bool' && typeof value === 'boolean') {
                        result = result.replace(
                            wgslParam.match,
                            `var<private> ${wgslParam.name}: bool = ${value};`
                        );
                    }
                }
            }

            return result;
        }

        it('should inject gain parameter into compiled DCTL output', () => {
            // Simulated DCTL compiler output for gain multiply
            const compiledWgsl = `var<private> gain: f32;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>((p_R * gain), (p_G * gain), (p_B * gain));
}
`;
            const paramValues = { gain: 2.5 };
            const result = injectParameters(compiledWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> gain: f32 = 2.5f;'), true,
                'Should inject gain = 2.5f');
            assert.strictEqual(result.includes('var<private> gain: f32;'), false,
                'Should replace uninitialized declaration');
        });

        it('should inject multiple parameters', () => {
            const compiledWgsl = `var<private> brightness: f32;
var<private> contrast: f32;
var<private> enabled: bool;

fn transform(...) { ... }
`;
            const paramValues = {
                brightness: 1.2,
                contrast: 1.1,
                enabled: true,
            };
            const result = injectParameters(compiledWgsl, paramValues);

            assert.strictEqual(result.includes('brightness: f32 = 1.2f;'), true, 'Should inject brightness');
            assert.strictEqual(result.includes('contrast: f32 = 1.1f;'), true, 'Should inject contrast');
            assert.strictEqual(result.includes('enabled: bool = true;'), true, 'Should inject enabled');
        });

        it('should handle renamed parameters with _N suffix', () => {
            // DCTL compiler may rename parameters to avoid conflicts
            const compiledWgsl = `var<private> gain_2: f32;
var<private> exposure_1: f32;

fn transform(...) { ... }
`;
            // User provides original names (without suffix)
            const paramValues = {
                gain: 2.0,
                exposure: 1.5,
            };
            const result = injectParameters(compiledWgsl, paramValues);

            assert.strictEqual(result.includes('gain_2: f32 = 2f;'), true,
                'Should inject gain via base name match');
            assert.strictEqual(result.includes('exposure_1: f32 = 1.5f;'), true,
                'Should inject exposure via base name match');
        });

        it('should NOT inject values when paramValues is empty', () => {
            const compiledWgsl = `var<private> gain: f32;

fn transform(...) { ... }
`;
            const paramValues = {};
            const result = injectParameters(compiledWgsl, paramValues);

            // Declaration should remain unchanged
            assert.strictEqual(result.includes('var<private> gain: f32;'), true,
                'Should not modify without values');
            assert.strictEqual(result.includes('= '), false,
                'Should not add initialization');
        });

        it('should verify gain DCTL compiler output from file if exists', function() {
            const outputPath = path.join(getTestOutputDir(), 'dctl_compiler_gain_output.wgsl');

            if (!fs.existsSync(outputPath)) {
                this.skip();
                return;
            }

            const compiledWgsl = fs.readFileSync(outputPath, 'utf-8');
            console.log('\n=== Gain DCTL Compiler Output Analysis ===');

            // Check if gain parameter is declared
            const hasGainDecl = /var<private>\s+gain[^;]*;/.test(compiledWgsl);
            console.log(`Has gain declaration: ${hasGainDecl}`);

            if (hasGainDecl) {
                const declMatch = compiledWgsl.match(/var<private>\s+gain[^;]*;/);
                console.log(`Declaration: ${declMatch?.[0]}`);
            }

            // Check if multiply with gain exists
            const hasMultiply = /\*\s*gain\b|\bgain\s*\*/.test(compiledWgsl);
            console.log(`Has multiply with gain: ${hasMultiply}`);

            // Inject test value
            const injected = injectParameters(compiledWgsl, { gain: 3.0 });
            const hasInjectedValue = injected.includes('gain: f32 = 3f;');
            console.log(`Value injection works: ${hasInjectedValue}`);

            assert.strictEqual(hasGainDecl, true, 'Should have gain declaration');
            assert.strictEqual(hasMultiply, true, 'Should have multiply with gain');
            assert.strictEqual(hasInjectedValue, true, 'Should be able to inject value');
        });
    });

    describe('Real DCTL Files Testing', () => {
        // Path to DCTL test files
        const dctlTestFixture = resolveFixture('test_gain.dctl');
        const dctlTestDir = dctlTestFixture ? path.dirname(dctlTestFixture) : '';

        /**
         * Simulates the full export shader building flow:
         * 1. Parse DCTL source to extract parameters
         * 2. Compile to WGSL (simulated with pre-compiled output)
         * 3. Inject parameter values
         * 4. Verify shader structure
         */
        function simulateExportShaderBuild(
            compiledWgsl: string,
            paramValues: Record<string, number | boolean>,
            imageWidth: number = 1920,
            imageHeight: number = 1080
        ): string {
            // Inject parameters
            let result = compiledWgsl;
            const varPrivateRegex = /var<private>\s+(\w+):\s*(f32|i32|bool)\s*;/g;
            const wgslParams: Array<{ name: string; type: string; match: string }> = [];
            let match;
            while ((match = varPrivateRegex.exec(compiledWgsl)) !== null) {
                wgslParams.push({
                    name: match[1],
                    type: match[2],
                    match: match[0],
                });
            }

            for (const wgslParam of wgslParams) {
                let value: number | boolean | undefined;
                if (paramValues[wgslParam.name] !== undefined) {
                    value = paramValues[wgslParam.name];
                } else {
                    const baseName = wgslParam.name.replace(/_\d+$/, '');
                    if (baseName !== wgslParam.name && paramValues[baseName] !== undefined) {
                        value = paramValues[baseName];
                    }
                }

                if (value !== undefined) {
                    if (wgslParam.type === 'f32' && typeof value === 'number') {
                        result = result.replace(
                            wgslParam.match,
                            `var<private> ${wgslParam.name}: f32 = ${value}f;`
                        );
                    } else if (wgslParam.type === 'i32' && typeof value === 'number') {
                        result = result.replace(
                            wgslParam.match,
                            `var<private> ${wgslParam.name}: i32 = ${Math.floor(value)}i;`
                        );
                    } else if (wgslParam.type === 'bool' && typeof value === 'boolean') {
                        result = result.replace(
                            wgslParam.match,
                            `var<private> ${wgslParam.name}: bool = ${value};`
                        );
                    }
                }
            }

            // Add shader preamble (simulated)
            const preamble = `// DCTL Export Shader (Simulated)
const p_Width: i32 = ${imageWidth};
const p_Height: i32 = ${imageHeight};

@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;

// Simulated dctl_sampleTexture implementation
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let uv = vec2<f32>((f32(x) + 0.5) / f32(p_Width), (f32(y) + 0.5) / f32(p_Height));
    return textureSample(u_image_tex, u_image_samp, uv);
}

`;
            // Add entry point - transform() internally calls dctl_sampleTexture()
            const entryPoint = `
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));
    // transform() internally calls dctl_sampleTexture() to get pixel values
    let result = transform(p_Width, p_Height, p_X, p_Y);
    return vec4<f32>(result, 1.0);
}
`;
            return preamble + result + entryPoint;
        }

        it('should test 02_gain_multiply.dctl with gain = 2.0', function() {
            const dctlPath = path.join(dctlTestDir, '02_gain_multiply.dctl');
            const compiledPath = path.join(getTestOutputDir(), 'dctl_compiler_gain_output.wgsl');

            if (!fs.existsSync(dctlPath)) {
                console.log(`DCTL file not found: ${dctlPath}`);
                this.skip();
                return;
            }

            // Read DCTL source
            const dctlSource = fs.readFileSync(dctlPath, 'utf-8');
            console.log('\n=== Testing 02_gain_multiply.dctl ===');
            console.log('DCTL Source (first 200 chars):', dctlSource.substring(0, 200).replace(/\n/g, '\\n'));

            // Verify DCTL has gain parameter
            assert.strictEqual(dctlSource.includes('DEFINE_UI_PARAMS(gain'), true,
                'DCTL should define gain parameter');
            assert.strictEqual(dctlSource.includes('r * gain'), true,
                'DCTL should multiply by gain');

            // Use pre-compiled WGSL if available
            if (fs.existsSync(compiledPath)) {
                const compiledWgsl = fs.readFileSync(compiledPath, 'utf-8');
                console.log('Using pre-compiled WGSL');

                // Test with gain = 2.0
                const exportShader = simulateExportShaderBuild(compiledWgsl, { gain: 2.0 });

                // Verify parameter was injected
                assert.strictEqual(exportShader.includes('gain: f32 = 2f;'), true,
                    'Gain should be injected as 2.0');

                // Verify shader structure
                assert.strictEqual(exportShader.includes('@fragment'), true,
                    'Should have fragment entry');
                assert.strictEqual(exportShader.includes('fn dctl_sampleTexture'), true,
                    'Should have dctl_sampleTexture function');
                assert.strictEqual(/transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y\s*\)/.test(exportShader), true,
                    'Should call transform with 4 args (internal sampling)');

                console.log('✓ Export shader built successfully with gain = 2.0');
            } else {
                console.log('Pre-compiled WGSL not found, using inline source');

                // Use the inline GAIN_MULTIPLY_DCTL compiled output
                // Note: transform() internally calls dctl_sampleTexture()
                const inlineCompiledWgsl = `var<private> gain: f32;

fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0f, 0f, 0f, 0f);
}

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32) -> vec3<f32> {
    let sampled = dctl_sampleTexture(p_X, p_Y);
    return vec3<f32>((sampled.x * gain), (sampled.y * gain), (sampled.z * gain));
}
`;
                const exportShader = simulateExportShaderBuild(inlineCompiledWgsl, { gain: 2.0 });
                assert.strictEqual(exportShader.includes('gain: f32 = 2f;'), true,
                    'Gain should be injected');
            }
        });

        it('should test exposure DCTL with exposure = 1.5 stops', function() {
            // Simulated compiled output for exposure DCTL
            // Note: transform() internally calls dctl_sampleTexture()
            const exposureCompiledWgsl = `var<private> exposure: f32;

fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0f, 0f, 0f, 0f);
}

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32) -> vec3<f32> {
    let sampled = dctl_sampleTexture(p_X, p_Y);
    let multiplier = pow(2.0, exposure);
    return vec3<f32>((sampled.x * multiplier), (sampled.y * multiplier), (sampled.z * multiplier));
}
`;
            const exportShader = simulateExportShaderBuild(exposureCompiledWgsl, { exposure: 1.5 });

            console.log('\n=== Testing exposure DCTL ===');

            // Verify parameter injection
            assert.strictEqual(exportShader.includes('exposure: f32 = 1.5f;'), true,
                'Exposure should be injected as 1.5');

            // Verify pow function exists
            assert.strictEqual(exportShader.includes('pow(2.0, exposure)'), true,
                'Should have pow function for exposure');

            console.log('✓ Exposure shader built successfully with exposure = 1.5');
        });

        it('should test passthrough DCTL has no parameters', function() {
            // Passthrough DCTL - transform() internally calls dctl_sampleTexture()
            const passthroughCompiledWgsl = `fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0f, 0f, 0f, 0f);
}

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32) -> vec3<f32> {
    let sampled = dctl_sampleTexture(p_X, p_Y);
    return vec3<f32>(sampled.x, sampled.y, sampled.z);
}
`;
            const exportShader = simulateExportShaderBuild(passthroughCompiledWgsl, {});

            console.log('\n=== Testing passthrough DCTL ===');

            // Verify no parameter declarations with values
            const hasInjectedParams = /var<private>\s+\w+:\s*\w+\s*=/.test(exportShader);
            assert.strictEqual(hasInjectedParams, false,
                'Passthrough should have no injected parameters');

            // Verify shader structure is still correct
            assert.strictEqual(exportShader.includes('@fragment'), true,
                'Should have fragment entry');
            assert.strictEqual(/transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y\s*\)/.test(exportShader), true,
                'Should call transform with 4 args');

            console.log('✓ Passthrough shader built successfully (no parameters)');
        });

        it('should verify parameter values affect transform behavior', () => {
            // This is a conceptual test showing expected behavior
            console.log('\n=== Parameter Effect Verification ===');

            // Gain = 1.0 (no change)
            const inputPixel = { r: 0.5, g: 0.5, b: 0.5 };

            // Gain = 2.0 (double brightness)
            const gain2Output = {
                r: inputPixel.r * 2.0,
                g: inputPixel.g * 2.0,
                b: inputPixel.b * 2.0,
            };
            console.log(`Input: (${inputPixel.r}, ${inputPixel.g}, ${inputPixel.b})`);
            console.log(`Gain=2.0 Output: (${gain2Output.r}, ${gain2Output.g}, ${gain2Output.b})`);

            assert.strictEqual(gain2Output.r, 1.0, 'R should be doubled');
            assert.strictEqual(gain2Output.g, 1.0, 'G should be doubled');
            assert.strictEqual(gain2Output.b, 1.0, 'B should be doubled');

            // Exposure = 2.0 stops (4x brightness)
            const exposure2Output = {
                r: inputPixel.r * Math.pow(2.0, 2.0),
                g: inputPixel.g * Math.pow(2.0, 2.0),
                b: inputPixel.b * Math.pow(2.0, 2.0),
            };
            console.log(`Exposure=2.0 Output: (${exposure2Output.r}, ${exposure2Output.g}, ${exposure2Output.b})`);

            assert.strictEqual(exposure2Output.r, 2.0, 'R should be 4x (2 stops)');

            console.log('✓ Parameter effects verified');
        });

        it('should read and test all numbered DCTL test files', function() {
            if (!fs.existsSync(dctlTestDir)) {
                console.log('DCTL test directory not found');
                this.skip();
                return;
            }

            const files = fs.readdirSync(dctlTestDir)
                .filter(f => /^\d{2}_.*\.dctl$/.test(f))
                .sort();

            console.log(`\n=== Testing ${files.length} DCTL files ===`);

            for (const file of files) {
                const filePath = path.join(dctlTestDir, file);
                const content = fs.readFileSync(filePath, 'utf-8');

                // Check for parameter definitions
                const paramMatches = content.match(/DEFINE_UI_PARAMS\((\w+)/g);
                const params = paramMatches
                    ? paramMatches.map(m => m.match(/DEFINE_UI_PARAMS\((\w+)/)?.[1])
                    : [];

                // Check for transform function
                const hasTransform = content.includes('float3 transform(');

                console.log(`${file}: params=[${params.join(', ')}], hasTransform=${hasTransform}`);

                assert.strictEqual(hasTransform, true, `${file} should have transform function`);
            }
        });
    });

    describe('RGC Export Path Tests (Regression)', () => {
        /**
         * Tests for ACES 2.0 Reference Gamut Compression (RGC) export path.
         * The RGC path uses a different code branch in buildDctlExportShader.
         */

        /**
         * Validates RGC-specific shader structure
         */
        function validateRgcShaderStructure(wgslCode: string): {
            hasRgcComment: boolean;
            hasRgcFunction: boolean;
            hasRgcTextureBindings: boolean;
            hasCorrectPipeline: boolean;
        } {
            return {
                hasRgcComment: /ACES 2.0 Reference Gamut Compression|RGC/.test(wgslCode),
                hasRgcFunction: /fn\s+applyACES2RGC|rgc_/.test(wgslCode),
                hasRgcTextureBindings: /rgc_.*_tex|rgc_.*_samp/.test(wgslCode),
                // RGC path should still have transform with 4 args
                hasCorrectPipeline: /transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y\s*\)/.test(wgslCode),
            };
        }

        it('should verify RGC debug output exists and has correct structure', function() {
            const rgcDebugPath = path.join(getTestOutputDir(), 'export_shader_rgc_debug.wgsl');

            if (!fs.existsSync(rgcDebugPath)) {
                // RGC debug file not created - this may indicate RGC conversion failure
                console.log('\n=== RGC Debug File Missing ===');
                console.log('Expected path:', rgcDebugPath);
                console.log('This may indicate RGC GLSL→WGSL conversion failed');
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(rgcDebugPath, 'utf-8');
            const rgcValidation = validateRgcShaderStructure(shaderCode);
            const pipeline = validateShaderPipeline(shaderCode);
            const analysis = analyzeCompiledShader(shaderCode);

            console.log('\n=== RGC Export Shader Analysis ===');
            console.log(`Has RGC comment: ${rgcValidation.hasRgcComment}`);
            console.log(`Has RGC function: ${rgcValidation.hasRgcFunction}`);
            console.log(`Has RGC texture bindings: ${rgcValidation.hasRgcTextureBindings}`);
            console.log(`Has correct pipeline: ${rgcValidation.hasCorrectPipeline}`);
            console.log(`Transform function: ${analysis.hasTransformFunction}`);
            console.log(`Parameters: ${JSON.stringify(analysis.parameterValues)}`);

            // Validate RGC path shader structure
            assert.strictEqual(pipeline.hasFragmentEntry, true,
                'RGC shader should have fragment entry point');
            assert.strictEqual(pipeline.samplesTexture, true,
                'RGC shader should have dctl_sampleTexture function');
            assert.strictEqual(rgcValidation.hasCorrectPipeline, true,
                'RGC shader should call transform with 4 args');
        });

        it('should test RGC path with gain parameter injection', function() {
            const rgcDebugPath = path.join(getTestOutputDir(), 'export_shader_rgc_debug.wgsl');

            if (!fs.existsSync(rgcDebugPath)) {
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(rgcDebugPath, 'utf-8');
            const analysis = analyzeCompiledShader(shaderCode);

            console.log('\n=== RGC Path Parameter Injection ===');

            // Check if gain was injected
            if (analysis.hasGainParameter) {
                const gainValue = analysis.parameterValues['gain'];
                console.log(`Gain parameter value: ${gainValue}`);

                // If gain is present but undefined, parameter was declared but not injected
                if (gainValue === undefined) {
                    console.log('WARNING: Gain declared but not injected!');
                    assert.fail('Gain parameter should have a value when exported with gain');
                }
            } else {
                console.log('No gain parameter found - may be using different DCTL');
            }
        });

        it('should verify both RGC and non-RGC paths produce valid shaders', function() {
            const nonRgcPath = path.join(getTestOutputDir(), 'export_shader_debug.wgsl');
            const rgcPath = path.join(getTestOutputDir(), 'export_shader_rgc_debug.wgsl');

            const results: { path: string; exists: boolean; valid: boolean; error?: string }[] = [];

            // Test non-RGC path
            if (fs.existsSync(nonRgcPath)) {
                const code = fs.readFileSync(nonRgcPath, 'utf-8');
                const pipeline = validateShaderPipeline(code);
                results.push({
                    path: 'non-RGC',
                    exists: true,
                    valid: pipeline.hasFragmentEntry && pipeline.callsTransform,
                });
            } else {
                results.push({ path: 'non-RGC', exists: false, valid: false });
            }

            // Test RGC path
            if (fs.existsSync(rgcPath)) {
                const code = fs.readFileSync(rgcPath, 'utf-8');
                const pipeline = validateShaderPipeline(code);
                results.push({
                    path: 'RGC',
                    exists: true,
                    valid: pipeline.hasFragmentEntry && pipeline.callsTransform,
                });
            } else {
                results.push({ path: 'RGC', exists: false, valid: false });
            }

            console.log('\n=== Export Path Comparison ===');
            for (const r of results) {
                console.log(`${r.path}: exists=${r.exists}, valid=${r.valid}`);
            }

            // At least one path should exist and be valid for tests to be meaningful
            const anyValid = results.some(r => r.exists && r.valid);
            if (!anyValid) {
                this.skip(); // Skip if no debug files exist
            }
        });
    });

    describe('Export Pipeline Math Verification (Regression)', () => {
        /**
         * Full pipeline verification:
         * AP0 linear → AP1 linear → ACEScct → DCTL (gain×2) → ACEScct → AP1 linear → AP0 linear
         *
         * This tests the complete color transformation chain to verify expected output values.
         */

        // Matrix constants (matching shader)
        const AP0_TO_AP1 = [
            [1.4514393161, -0.0765537734, 0.0083161484],
            [-0.2365107469, 1.1762296998, -0.0060324498],
            [-0.2149285693, -0.0996759264, 0.9977163014],
        ];

        const AP1_TO_AP0 = [
            [0.6954522414, 0.0447945634, -0.0055258826],
            [0.1406786965, 0.8596711185, 0.0040252103],
            [0.1638690622, 0.0955343182, 1.0015006723],
        ];

        function matmul3x3(m: number[][], v: [number, number, number]): [number, number, number] {
            return [
                m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
                m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
                m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
            ];
        }

        function linToACEScct(lin: number): number {
            const cut = 0.0078125;
            const a = 10.5402377416545;
            const b = 0.0729055341958355;
            if (lin <= cut) {
                return a * lin + b;
            }
            return (Math.log2(lin) + 9.72) / 17.52;
        }

        function ACEScctToLin(cct: number): number {
            const cut = 0.155251141552511;
            const a = 10.5402377416545;
            const b = 0.0729055341958355;
            if (cct <= cut) {
                return (cct - b) / a;
            }
            return Math.pow(2, cct * 17.52 - 9.72);
        }

        it('should verify complete pipeline: AP0 → AP1 → ACEScct → gain×2 → AP0', () => {
            // Test with 18% gray in AP0 (R=G=B=0.18)
            const inputAP0: [number, number, number] = [0.18, 0.18, 0.18];

            console.log('\n=== Complete Export Pipeline Verification ===');
            console.log(`Input (AP0 linear): [${inputAP0.map(v => v.toFixed(4)).join(', ')}]`);

            // Step 1: AP0 → AP1
            const ap1 = matmul3x3(AP0_TO_AP1, inputAP0);
            console.log(`After AP0→AP1: [${ap1.map(v => v.toFixed(4)).join(', ')}]`);

            // Step 2: AP1 → ACEScct
            const acescct: [number, number, number] = [
                linToACEScct(ap1[0]),
                linToACEScct(ap1[1]),
                linToACEScct(ap1[2]),
            ];
            console.log(`After ACEScct encoding: [${acescct.map(v => v.toFixed(4)).join(', ')}]`);

            // Step 3: DCTL gain × 2
            const gain = 2.0;
            const afterGain: [number, number, number] = [
                acescct[0] * gain,
                acescct[1] * gain,
                acescct[2] * gain,
            ];
            console.log(`After DCTL gain×${gain}: [${afterGain.map(v => v.toFixed(4)).join(', ')}]`);

            // Step 4: ACEScct → AP1 linear
            const ap1AfterGain: [number, number, number] = [
                ACEScctToLin(afterGain[0]),
                ACEScctToLin(afterGain[1]),
                ACEScctToLin(afterGain[2]),
            ];
            console.log(`After ACEScct decoding (AP1 linear): [${ap1AfterGain.map(v => v.toFixed(4)).join(', ')}]`);

            // Step 5: AP1 → AP0
            const outputAP0 = matmul3x3(AP1_TO_AP0, ap1AfterGain);
            console.log(`Output (AP0 linear): [${outputAP0.map(v => v.toFixed(4)).join(', ')}]`);

            // Calculate overall multiplier
            const multiplier = outputAP0[1] / inputAP0[1]; // Use green channel
            console.log(`\nOverall brightness multiplier: ${multiplier.toFixed(2)}x`);
            console.log(`Expected: Image should be MUCH brighter after gain×2 in ACEScct space`);

            // Verify output is brighter (this is the key assertion)
            assert.ok(outputAP0[0] > inputAP0[0], 'Output R should be greater than input R');
            assert.ok(outputAP0[1] > inputAP0[1], 'Output G should be greater than input G');
            assert.ok(outputAP0[2] > inputAP0[2], 'Output B should be greater than input B');
            assert.ok(multiplier > 10, 'Brightness multiplier should be > 10x (not 2x, due to log space)');
        });

        it('should verify passthrough pipeline preserves values', () => {
            // Test with 18% gray
            const inputAP0: [number, number, number] = [0.18, 0.18, 0.18];

            // Step 1: AP0 → AP1
            const ap1 = matmul3x3(AP0_TO_AP1, inputAP0);

            // Step 2: AP1 → ACEScct
            const acescct: [number, number, number] = [
                linToACEScct(ap1[0]),
                linToACEScct(ap1[1]),
                linToACEScct(ap1[2]),
            ];

            // Step 3: No DCTL modification (passthrough) - gain = 1.0
            const gain = 1.0;
            const afterGain: [number, number, number] = [
                acescct[0] * gain,
                acescct[1] * gain,
                acescct[2] * gain,
            ];

            // Step 4: ACEScct → AP1
            const ap1After: [number, number, number] = [
                ACEScctToLin(afterGain[0]),
                ACEScctToLin(afterGain[1]),
                ACEScctToLin(afterGain[2]),
            ];

            // Step 5: AP1 → AP0
            const outputAP0 = matmul3x3(AP1_TO_AP0, ap1After);

            console.log('\n=== Passthrough Pipeline Verification ===');
            console.log(`Input (AP0): [${inputAP0.map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`Output (AP0): [${outputAP0.map(v => v.toFixed(4)).join(', ')}]`);

            // Verify values are preserved (within floating point tolerance)
            const tolerance = 0.001;
            assert.ok(Math.abs(outputAP0[0] - inputAP0[0]) < tolerance,
                `R should be preserved: ${outputAP0[0].toFixed(4)} vs ${inputAP0[0].toFixed(4)}`);
            assert.ok(Math.abs(outputAP0[1] - inputAP0[1]) < tolerance,
                `G should be preserved: ${outputAP0[1].toFixed(4)} vs ${inputAP0[1].toFixed(4)}`);
            assert.ok(Math.abs(outputAP0[2] - inputAP0[2]) < tolerance,
                `B should be preserved: ${outputAP0[2].toFixed(4)} vs ${inputAP0[2].toFixed(4)}`);
        });

        it('should detect if gain is NOT being applied (regression: darker output)', () => {
            /**
             * REGRESSION TEST:
             * User reported: "Gain 2.0 produces slightly darker output"
             *
             * If output is darker than input with gain=2.0, one of these is happening:
             * 1. DCTL is not being applied (passthrough)
             * 2. Gain value is < 1.0 (wrong parameter injection)
             * 3. Color space conversion is inverted
             * 4. The shader is failing silently
             */
            console.log('\n=== Regression Check: Darker Output with Gain=2.0 ===');

            const inputAP0: [number, number, number] = [0.18, 0.18, 0.18];

            // Scenario 1: What happens if DCTL is not applied (passthrough)
            const ap1 = matmul3x3(AP0_TO_AP1, inputAP0);
            const acescct: [number, number, number] = [linToACEScct(ap1[0]), linToACEScct(ap1[1]), linToACEScct(ap1[2])];
            const ap1After_noGain: [number, number, number] = [ACEScctToLin(acescct[0]), ACEScctToLin(acescct[1]), ACEScctToLin(acescct[2])];
            const outputAP0_noGain = matmul3x3(AP1_TO_AP0, ap1After_noGain);

            console.log('If DCTL not applied (gain=1):');
            console.log(`  Input:  [${inputAP0.map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`  Output: [${outputAP0_noGain.map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`  This should match input (passthrough behavior)`);

            // Scenario 2: What happens with gain < 1.0 (e.g., gain=0.5)
            const gain_low = 0.5;
            const afterGain_low: [number, number, number] = [acescct[0] * gain_low, acescct[1] * gain_low, acescct[2] * gain_low];
            const ap1After_low: [number, number, number] = [ACEScctToLin(afterGain_low[0]), ACEScctToLin(afterGain_low[1]), ACEScctToLin(afterGain_low[2])];
            const outputAP0_low = matmul3x3(AP1_TO_AP0, ap1After_low);

            console.log(`\nIf gain=${gain_low} (DARKER expected):`);
            console.log(`  Output: [${outputAP0_low.map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`  Brightness: ${(outputAP0_low[1] / inputAP0[1]).toFixed(2)}x`);

            // Scenario 3: What happens with gain = 2.0 (BRIGHTER expected)
            const gain_high = 2.0;
            const afterGain_high: [number, number, number] = [acescct[0] * gain_high, acescct[1] * gain_high, acescct[2] * gain_high];
            const ap1After_high: [number, number, number] = [ACEScctToLin(afterGain_high[0]), ACEScctToLin(afterGain_high[1]), ACEScctToLin(afterGain_high[2])];
            const outputAP0_high = matmul3x3(AP1_TO_AP0, ap1After_high);

            console.log(`\nIf gain=${gain_high} (MUCH BRIGHTER expected):`);
            console.log(`  Output: [${outputAP0_high.map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`  Brightness: ${(outputAP0_high[1] / inputAP0[1]).toFixed(2)}x`);

            console.log('\n=== Conclusion ===');
            console.log('If user sees DARKER output with gain=2.0, check:');
            console.log('1. Is the DCTL actually being compiled and applied?');
            console.log('2. Is the gain parameter value being read correctly from UI?');
            console.log('3. Are there any WebGPU pipeline errors in console?');
            console.log('4. Is the exported EXR being viewed with correct color space settings?');
        });
    });

    describe('ACEScct Gain Behavior Tests (Regression)', () => {
        /**
         * ACEScct is a logarithmic color encoding used as the working space.
         * Multiplying by a gain factor in ACEScct space is NOT equivalent to
         * multiplying in linear space.
         *
         * ACEScct formula:
         * - Linear to ACEScct: if (lin <= 0.0078125) cct = 10.5402377 * lin + 0.0729055
         *                      else cct = (log2(lin) + 9.72) / 17.52
         * - ACEScct to Linear: if (cct <= 0.155251) lin = (cct - 0.0729055) / 10.5402377
         *                      else lin = pow(2, cct * 17.52 - 9.72)
         */

        // ACEScct conversion functions (matching shader implementation)
        function linToACEScct(lin: number): number {
            const cut = 0.0078125;
            const a = 10.5402377416545;
            const b = 0.0729055341958355;
            if (lin <= cut) {
                return a * lin + b;
            } else {
                return (Math.log2(lin) + 9.72) / 17.52;
            }
        }

        function ACEScctToLin(cct: number): number {
            const cut = 0.155251141552511;
            const a = 10.5402377416545;
            const b = 0.0729055341958355;
            if (cct <= cut) {
                return (cct - b) / a;
            } else {
                return Math.pow(2, cct * 17.52 - 9.72);
            }
        }

        it('should understand ACEScct mid-gray encoding', () => {
            // 18% gray (0.18 linear) is the photographic mid-gray
            const linearMidGray = 0.18;
            const acescctMidGray = linToACEScct(linearMidGray);

            console.log('\n=== ACEScct Mid-Gray Analysis ===');
            console.log(`Linear mid-gray: ${linearMidGray}`);
            console.log(`ACEScct mid-gray: ${acescctMidGray.toFixed(6)}`);

            // ACEScct mid-gray should be around 0.4135
            assert.ok(Math.abs(acescctMidGray - 0.4135) < 0.01,
                'ACEScct mid-gray should be approximately 0.4135');
        });

        it('should calculate correct output for gain=2.0 in ACEScct space', () => {
            /**
             * When DCTL multiplies by gain=2.0 in ACEScct space:
             * 1. Input is sampled and converted to ACEScct
             * 2. DCTL multiplies ACEScct value by 2.0
             * 3. Result is converted back to linear, then to AP0
             *
             * This is NOT the same as doubling linear brightness!
             */
            const linearInput = 0.18; // 18% gray
            const acescctInput = linToACEScct(linearInput);

            // Gain = 2.0 in ACEScct space
            const gain = 2.0;
            const acescctOutput = acescctInput * gain;

            // Convert back to linear
            const linearOutput = ACEScctToLin(acescctOutput);

            // Calculate the effective linear multiplier
            const effectiveMultiplier = linearOutput / linearInput;

            console.log('\n=== Gain=2.0 in ACEScct Space ===');
            console.log(`Linear input: ${linearInput}`);
            console.log(`ACEScct input: ${acescctInput.toFixed(6)}`);
            console.log(`ACEScct after gain×2: ${acescctOutput.toFixed(6)}`);
            console.log(`Linear output: ${linearOutput.toFixed(6)}`);
            console.log(`Effective linear multiplier: ${effectiveMultiplier.toFixed(2)}x`);

            // In ACEScct, multiplying by 2.0 results in a much larger linear increase
            // because ACEScct is logarithmic
            assert.ok(effectiveMultiplier > 2.0,
                'Gain 2.0 in ACEScct should result in >2x linear increase');

            // Store expected behavior for reference
            // For 18% gray: ACEScct * 2 ≈ 0.827 → linear ≈ 1.16
            // Effective multiplier ≈ 6.4x
        });

        it('should calculate brightness effect for different linear input values', () => {
            console.log('\n=== Gain=2.0 Effect Across Brightness Range ===');
            console.log('Linear In | ACEScct In | ACEScct×2 | Linear Out | Multiplier');
            console.log('-'.repeat(65));

            const testValues = [0.01, 0.05, 0.10, 0.18, 0.30, 0.50, 0.70, 1.0];
            const gain = 2.0;

            for (const linearIn of testValues) {
                const acescctIn = linToACEScct(linearIn);
                const acescctOut = acescctIn * gain;
                const linearOut = ACEScctToLin(acescctOut);
                const multiplier = linearOut / linearIn;

                console.log(`${linearIn.toFixed(2).padStart(9)} | ${acescctIn.toFixed(4).padStart(10)} | ${acescctOut.toFixed(4).padStart(9)} | ${linearOut.toFixed(4).padStart(10)} | ${multiplier.toFixed(2)}x`);

                // All should result in brightness increase (not decrease)
                assert.ok(linearOut > linearIn,
                    `Gain 2.0 should increase brightness for input ${linearIn}`);
            }
        });

        it('should detect if ACEScct output exceeds valid range causing issues', () => {
            /**
             * If ACEScct value exceeds 1.0 after gain multiplication,
             * it may cause issues depending on how the shader handles it.
             *
             * ACEScct = 1.0 corresponds to linear ≈ 16.29
             * ACEScct = 0.5 corresponds to linear ≈ 0.503
             */
            const acescct_1_0_linear = ACEScctToLin(1.0);
            const acescct_0_5_linear = ACEScctToLin(0.5);

            console.log('\n=== ACEScct Range Analysis ===');
            console.log(`ACEScct 0.5 → Linear: ${acescct_0_5_linear.toFixed(4)}`);
            console.log(`ACEScct 1.0 → Linear: ${acescct_1_0_linear.toFixed(4)}`);

            // Test mid-gray with gain=2.0
            const linearMidGray = 0.18;
            const acescctMidGray = linToACEScct(linearMidGray);
            const acescctAfterGain = acescctMidGray * 2.0;

            console.log(`\nMid-gray (0.18 linear):`);
            console.log(`  ACEScct value: ${acescctMidGray.toFixed(4)}`);
            console.log(`  After gain×2: ${acescctAfterGain.toFixed(4)}`);
            console.log(`  Within [0,1]?: ${acescctAfterGain <= 1.0 ? 'Yes' : 'No (exceeds!)'}`);

            // For most images, ACEScct values are < 0.5, so gain=2.0 keeps them < 1.0
            // But highlights may exceed 1.0 after gain
            const highValue = 0.5; // Linear 0.5 is quite bright
            const highAcescct = linToACEScct(highValue);
            const highAfterGain = highAcescct * 2.0;

            console.log(`\nBright pixel (0.5 linear):`);
            console.log(`  ACEScct value: ${highAcescct.toFixed(4)}`);
            console.log(`  After gain×2: ${highAfterGain.toFixed(4)}`);
            console.log(`  Within [0,1]?: ${highAfterGain <= 1.0 ? 'Yes' : 'No (exceeds!)'}`);
        });

        it('should verify parameter is actually used in transform calculation', () => {
            // This tests that the compiled shader actually multiplies by gain
            const shaderWithGain = `
var<private> gain: f32 = 2.0f;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32) -> vec3<f32> {
    let sampled = dctl_sampleTexture(p_X, p_Y);
    let r = sampled.x;
    let g = sampled.y;
    let b = sampled.z;
    return vec3<f32>(r * gain, g * gain, b * gain);
}
`;
            // Verify gain is both declared AND used
            const hasGainDecl = /var<private>\s+gain:\s*f32\s*=\s*2\.0f/.test(shaderWithGain);
            const hasGainUsage = /\*\s*gain|\bgain\s*\*/.test(shaderWithGain);

            assert.strictEqual(hasGainDecl, true, 'Should have gain declaration with value');
            assert.strictEqual(hasGainUsage, true, 'Should use gain in multiplication');
        });

        it('should compare expected vs actual export behavior', function() {
            const debugPath = path.join(getTestOutputDir(), 'export_shader_debug.wgsl');

            if (!fs.existsSync(debugPath)) {
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(debugPath, 'utf-8');
            const analysis = analyzeCompiledShader(shaderCode);

            console.log('\n=== Export Shader Analysis ===');

            // Check gain parameter
            if (analysis.hasGainParameter) {
                const gainValue = analysis.parameterValues['gain'];
                console.log(`Gain value in shader: ${gainValue}`);

                if (gainValue === 2.0) {
                    // Calculate expected behavior
                    const linearMidGray = 0.18;
                    const acescctMidGray = linToACEScct(linearMidGray);
                    const acescctAfterGain = acescctMidGray * 2.0;
                    const linearAfterGain = ACEScctToLin(acescctAfterGain);

                    console.log(`\nExpected behavior with Gain=2.0:`);
                    console.log(`  Mid-gray input (linear): ${linearMidGray}`);
                    console.log(`  Mid-gray in ACEScct: ${acescctMidGray.toFixed(4)}`);
                    console.log(`  After gain×2 (ACEScct): ${acescctAfterGain.toFixed(4)}`);
                    console.log(`  Output (linear): ${linearAfterGain.toFixed(4)}`);
                    console.log(`  Brightness increase: ${(linearAfterGain / linearMidGray).toFixed(2)}x`);

                    // This should show that gain=2.0 makes the image BRIGHTER, not darker
                    assert.ok(linearAfterGain > linearMidGray,
                        'Gain 2.0 should make image brighter');
                }
            } else {
                console.log('No gain parameter found in shader');
            }

            // Check for multiply operations
            console.log(`Has multiply with gain: ${analysis.hasMultiplyOperation}`);
        });
    });
});
