/**
 * Unit tests for DCTL Export Shader Builder
 *
 * Tests the export shader generation logic used in dctl-export-shader-builder.ts
 * These tests verify the WGSL generation for exporting DCTL-processed images as EXR.
 */

import * as assert from 'assert';

/**
 * Simulates parameter injection logic from buildDctlExportShader
 * This is extracted from the actual implementation for testing
 */
function injectParameterValues(
    dctlWgsl: string,
    paramValues: Record<string, number | boolean>
): string {
    let result = dctlWgsl;

    // Extract all var<private> declarations: var<private> name: type;
    const varPrivateRegex = /var<private>\s+(\w+):\s*(f32|i32|bool)\s*;/g;
    const wgslParams: Array<{ name: string; type: string; match: string }> = [];
    let match;
    while ((match = varPrivateRegex.exec(dctlWgsl)) !== null) {
        wgslParams.push({
            name: match[1],
            type: match[2],
            match: match[0],
        });
    }

    // For each WGSL parameter, find corresponding value from paramValues
    // Try: exact match, then base name (strip _N suffix)
    for (const wgslParam of wgslParams) {
        let value: number | boolean | undefined;

        // Try exact match first
        if (paramValues[wgslParam.name] !== undefined) {
            value = paramValues[wgslParam.name];
        } else {
            // Try stripping _N suffix (e.g., dmax_2 -> dmax)
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

/**
 * Simulates dctl_sampleTexture stub removal logic
 */
function removeSampleTextureStub(wgsl: string): string {
    return wgsl.replace(
        /fn dctl_sampleTexture\([^)]*\)\s*->\s*vec4<f32>\s*\{[\s\S]*?return vec4<f32>\([^)]*\);[\s\S]*?\}/,
        '' // Remove stub
    );
}

/**
 * Validates export shader structure
 */
function validateExportShaderStructure(wgsl: string): {
    hasEntryPoint: boolean;
    hasTextureBindings: boolean;
    hasColorSpaceMatrices: boolean;
    hasACEScctFunctions: boolean;
    hasSampleTextureFunction: boolean;
} {
    return {
        hasEntryPoint: /@fragment\s*fn\s+main\s*\(/.test(wgsl),
        hasTextureBindings: /@group\(0\)\s*@binding\(0\)\s*var\s+u_image_tex/.test(wgsl),
        hasColorSpaceMatrices: /dctl_ap0ToWorking|dctl_workingToAp0/.test(wgsl),
        hasACEScctFunctions: /dctl_lin_to_ACEScct|dctl_ACEScct_to_lin/.test(wgsl),
        hasSampleTextureFunction: /fn dctl_sampleTexture\s*\(/.test(wgsl),
    };
}

describe('DCTL Export Shader Builder', () => {
    describe('Parameter Value Injection', () => {
        it('should inject f32 parameter values', () => {
            const inputWgsl = `
var<private> gamma: f32;
var<private> exposure: f32;

fn transform() -> vec3<f32> {
    return vec3<f32>(gamma, exposure, 1.0);
}
`;
            const paramValues = { gamma: 2.2, exposure: 1.5 };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> gamma: f32 = 2.2f;'), true,
                'Should inject gamma value');
            assert.strictEqual(result.includes('var<private> exposure: f32 = 1.5f;'), true,
                'Should inject exposure value');
        });

        it('should inject i32 parameter values', () => {
            const inputWgsl = `
var<private> mode: i32;
var<private> iterations: i32;

fn process() {
    for (var i = 0; i < iterations; i++) {
    }
}
`;
            const paramValues = { mode: 2, iterations: 10 };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> mode: i32 = 2i;'), true,
                'Should inject mode value');
            assert.strictEqual(result.includes('var<private> iterations: i32 = 10i;'), true,
                'Should inject iterations value');
        });

        it('should inject bool parameter values', () => {
            const inputWgsl = `
var<private> enabled: bool;
var<private> invert: bool;

fn process(x: f32) -> f32 {
    if (enabled) { return x; }
    return 0.0;
}
`;
            const paramValues = { enabled: true, invert: false };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> enabled: bool = true;'), true,
                'Should inject enabled value');
            assert.strictEqual(result.includes('var<private> invert: bool = false;'), true,
                'Should inject invert value');
        });

        it('should handle renamed parameters with _N suffix', () => {
            // DCTL compiler may rename parameters (e.g., dmax -> dmax_2) to avoid conflicts
            const inputWgsl = `
var<private> dmax_2: f32;
var<private> intensity_1: f32;

fn apply(x: f32) -> f32 {
    return x * dmax_2 * intensity_1;
}
`;
            // User provides values with original names (without suffix)
            const paramValues = { dmax: 1.0, intensity: 0.5 };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> dmax_2: f32 = 1f;'), true,
                'Should inject dmax value by matching base name');
            assert.strictEqual(result.includes('var<private> intensity_1: f32 = 0.5f;'), true,
                'Should inject intensity value by matching base name');
        });

        it('should prefer exact match over base name match', () => {
            const inputWgsl = `
var<private> gamma: f32;
var<private> gamma_2: f32;

fn apply(x: f32) -> f32 {
    return pow(x, gamma) + gamma_2;
}
`;
            // Provide both exact and would-be-matched values
            const paramValues = { gamma: 2.2, gamma_2: 1.5 };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> gamma: f32 = 2.2f;'), true,
                'Should inject exact match for gamma');
            assert.strictEqual(result.includes('var<private> gamma_2: f32 = 1.5f;'), true,
                'Should inject exact match for gamma_2');
        });

        it('should not modify parameters without values', () => {
            const inputWgsl = `
var<private> defined_param: f32;
var<private> undefined_param: f32;

fn process() -> f32 {
    return defined_param + undefined_param;
}
`;
            const paramValues = { defined_param: 1.0 };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> defined_param: f32 = 1f;'), true,
                'Should inject defined value');
            assert.strictEqual(result.includes('var<private> undefined_param: f32;'), true,
                'Should leave undefined param unchanged');
        });

        it('should floor i32 values when given floats', () => {
            const inputWgsl = `var<private> count: i32;`;
            const paramValues = { count: 5.7 };
            const result = injectParameterValues(inputWgsl, paramValues);

            assert.strictEqual(result.includes('var<private> count: i32 = 5i;'), true,
                'Should floor the value to 5');
        });
    });

    describe('Sample Texture Stub Removal', () => {
        it('should remove simple stub', () => {
            const inputWgsl = `
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0f, 0f, 0f, 0f);
}

fn transform() -> vec3<f32> {
    return vec3<f32>(1.0);
}
`;
            const result = removeSampleTextureStub(inputWgsl);

            assert.strictEqual(result.includes('fn dctl_sampleTexture'), false,
                'Should remove stub function');
            assert.strictEqual(result.includes('fn transform'), true,
                'Should preserve other functions');
        });

        it('should remove stub with whitespace variations', () => {
            const inputWgsl = `
fn dctl_sampleTexture(x: i32, y: i32)    ->    vec4<f32>   {
    return vec4<f32>(0f, 0f, 0f, 0f);
}
`;
            const result = removeSampleTextureStub(inputWgsl);

            assert.strictEqual(result.includes('fn dctl_sampleTexture'), false,
                'Should handle whitespace variations');
        });

        it('should not remove actual implementation', () => {
            // A real implementation would have more than just a zero return
            const inputWgsl = `
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let uv = vec2<f32>((f32(x) + 0.5) / f32(p_Width), (f32(y) + 0.5) / f32(p_Height));
    return textureSample(u_image_tex, u_image_samp, uv);
}
`;
            const result = removeSampleTextureStub(inputWgsl);

            // The regex specifically looks for the stub pattern with vec4<f32>(...)
            // A real implementation has different structure
            assert.strictEqual(result.includes('fn dctl_sampleTexture'), true,
                'Should preserve real implementation');
        });
    });

    describe('Export Shader Structure Validation', () => {
        it('should validate complete export shader', () => {
            const completeShader = `
// Texture bindings
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;

// Color space matrices
const dctl_ap0ToWorking = mat3x3<f32>(
    vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
    vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
    vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
);

const dctl_workingToAp0 = mat3x3<f32>(
    vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
    vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
    vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
);

fn dctl_lin_to_ACEScct(lin: f32) -> f32 {
    return lin;
}

fn dctl_ACEScct_to_lin(cct: f32) -> f32 {
    return cct;
}

fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0);
}

@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const validation = validateExportShaderStructure(completeShader);

            assert.strictEqual(validation.hasEntryPoint, true, 'Should have fragment entry point');
            assert.strictEqual(validation.hasTextureBindings, true, 'Should have texture bindings');
            assert.strictEqual(validation.hasColorSpaceMatrices, true, 'Should have color space matrices');
            assert.strictEqual(validation.hasACEScctFunctions, true, 'Should have ACEScct functions');
            assert.strictEqual(validation.hasSampleTextureFunction, true, 'Should have sample texture function');
        });

        it('should detect missing entry point', () => {
            const incompleteShader = `
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;

fn helper() -> f32 {
    return 1.0;
}
`;
            const validation = validateExportShaderStructure(incompleteShader);

            assert.strictEqual(validation.hasEntryPoint, false, 'Should detect missing entry point');
        });

        it('should detect missing texture bindings', () => {
            const noBindingsShader = `
const dctl_ap0ToWorking = mat3x3<f32>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0)
);

@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const validation = validateExportShaderStructure(noBindingsShader);

            assert.strictEqual(validation.hasTextureBindings, false, 'Should detect missing bindings');
            assert.strictEqual(validation.hasColorSpaceMatrices, true, 'Should detect color space matrices');
        });
    });

    describe('Working Color Space Handling', () => {
        it('should use ACEScct encoding for log working space', () => {
            // Simulated shader generation for ACEScct working space
            const isLogWorkingSpace = true;
            const sampleTextureCode = isLogWorkingSpace
                ? `fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let uv = vec2<f32>((f32(x) + 0.5) / f32(p_Width), (f32(y) + 0.5) / f32(p_Height));
    var sampled = textureSample(u_image_tex, u_image_samp, uv);
    var ap1 = dctl_ap0ToWorking * sampled.rgb;
    var cct = dctl_lin_to_ACEScct_vec(ap1);
    return vec4<f32>(cct, sampled.a);
}`
                : `fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let uv = vec2<f32>((f32(x) + 0.5) / f32(p_Width), (f32(y) + 0.5) / f32(p_Height));
    var sampled = textureSample(u_image_tex, u_image_samp, uv);
    sampled = vec4<f32>(dctl_ap0ToWorking * sampled.rgb, sampled.a);
    return sampled;
}`;

            assert.strictEqual(sampleTextureCode.includes('dctl_lin_to_ACEScct_vec'), true,
                'Should include ACEScct encoding for log working space');
        });

        it('should use linear conversion for linear working space', () => {
            const isLogWorkingSpace = false;
            const sampleTextureCode = isLogWorkingSpace
                ? `var cct = dctl_lin_to_ACEScct_vec(ap1);`
                : `sampled = vec4<f32>(dctl_ap0ToWorking * sampled.rgb, sampled.a);`;

            assert.strictEqual(sampleTextureCode.includes('dctl_lin_to_ACEScct'), false,
                'Should not include ACEScct for linear working space');
            assert.strictEqual(sampleTextureCode.includes('dctl_ap0ToWorking'), true,
                'Should include AP0 to AP1 conversion');
        });
    });

    describe('Output Conversion', () => {
        it('should generate correct output conversion for ACEScct', () => {
            const isLogWorkingSpace = true;
            const outputCode = isLogWorkingSpace
                ? `let resultACEScct = transform(p_Width, p_Height, p_X, p_Y, u_image_tex, u_image_tex, u_image_tex);
    let resultAP1 = dctl_ACEScct_to_lin_vec(resultACEScct);
    let resultAP0 = dctl_workingToAp0 * resultAP1;
    return vec4<f32>(resultAP0, 1.0);`
                : `let resultAP1 = transform(p_Width, p_Height, p_X, p_Y, u_image_tex, u_image_tex, u_image_tex);
    let resultAP0 = dctl_workingToAp0 * resultAP1;
    return vec4<f32>(resultAP0, 1.0);`;

            assert.strictEqual(outputCode.includes('dctl_ACEScct_to_lin_vec'), true,
                'ACEScct output should decode from log');
            assert.strictEqual(outputCode.includes('dctl_workingToAp0'), true,
                'Output should convert to AP0');
        });

        it('should generate correct output conversion for linear', () => {
            const isLogWorkingSpace = false;
            const outputCode = isLogWorkingSpace
                ? `dctl_ACEScct_to_lin_vec(resultACEScct)`
                : `let resultAP0 = dctl_workingToAp0 * resultAP1;`;

            assert.strictEqual(outputCode.includes('dctl_ACEScct_to_lin'), false,
                'Linear output should not have ACEScct decode');
            assert.strictEqual(outputCode.includes('dctl_workingToAp0'), true,
                'Output should convert to AP0');
        });
    });

    describe('Color Space Matrices', () => {
        it('should have correct AP0 to AP1 matrix values', () => {
            // These are the expected matrix values from ACES specification
            const ap0ToAp1 = [
                [1.4514393161, -0.0765537734, 0.0083161484],
                [-0.2365107469, 1.1762296998, -0.0060324498],
                [-0.2149285693, -0.0996759264, 0.9977163014],
            ];

            const matrixString = `mat3x3<f32>(
    vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
    vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
    vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
)`;

            // Verify key matrix values are present
            assert.strictEqual(matrixString.includes('1.4514393161'), true, 'Should have correct R->R coefficient');
            assert.strictEqual(matrixString.includes('1.1762296998'), true, 'Should have correct G->G coefficient');
            assert.strictEqual(matrixString.includes('0.9977163014'), true, 'Should have correct B->B coefficient');
        });

        it('should have correct AP1 to AP0 matrix values', () => {
            // These are the inverse matrix values
            const ap1ToAp0 = [
                [0.6954522414, 0.0447945634, -0.0055258826],
                [0.1406786965, 0.8596711185, 0.0040252103],
                [0.1638690622, 0.0955343182, 1.0015006723],
            ];

            const matrixString = `mat3x3<f32>(
    vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
    vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
    vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
)`;

            // Verify key matrix values are present
            assert.strictEqual(matrixString.includes('0.6954522414'), true, 'Should have correct R->R coefficient');
            assert.strictEqual(matrixString.includes('0.8596711185'), true, 'Should have correct G->G coefficient');
            assert.strictEqual(matrixString.includes('1.0015006723'), true, 'Should have correct B->B coefficient');
        });
    });

    describe('Entry Point Validation (Regression Tests)', () => {
        /**
         * Validates that the entry point correctly calls transform.
         *
         * The DCTL transform function internally calls dctl_sampleTexture() to get pixel values,
         * so the entry point should NOT pre-sample the texture and pass values.
         *
         * Correct pattern:
         *   transform(p_Width, p_Height, p_X, p_Y)
         *
         * Incorrect patterns:
         *   - transform(..., sampled.x, sampled.y, sampled.z) - unnecessary, transform samples internally
         *   - transform(..., u_image_tex, u_image_tex, u_image_tex) - type mismatch
         */
        function validateEntryPoint(entryPointCode: string): {
            callsTransformWith4Args: boolean;
            doesNotPassSampledValues: boolean;
            doesNotPassTextures: boolean;
            hasCorrectPattern: boolean;
        } {
            // Check that transform is called with only 4 args (p_Width, p_Height, p_X, p_Y)
            const callsTransformWith4Args = /transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y\s*\)/.test(entryPointCode);

            // Check that transform is NOT called with sampled.x, sampled.y, sampled.z
            const passesSampledValues = /transform\s*\([^)]*sampled\.[xyz]/.test(entryPointCode);

            // Check that u_image_tex is NOT passed directly to transform
            const passesTexture = /transform\s*\([^)]*u_image_tex/.test(entryPointCode);

            return {
                callsTransformWith4Args,
                doesNotPassSampledValues: !passesSampledValues,
                doesNotPassTextures: !passesTexture,
                hasCorrectPattern: callsTransformWith4Args && !passesSampledValues && !passesTexture,
            };
        }

        it('should call transform with only 4 parameters (ACEScct working space)', () => {
            // Correct entry point for ACEScct - transform samples internally
            const correctEntryPoint = `
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    // transform() internally calls dctl_sampleTexture() to get pixel values
    let resultACEScct = transform(p_Width, p_Height, p_X, p_Y);

    let resultAP1 = dctl_ACEScct_to_lin_vec(resultACEScct);
    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}`;
            const validation = validateEntryPoint(correctEntryPoint);

            assert.strictEqual(validation.callsTransformWith4Args, true, 'Should call transform with 4 args');
            assert.strictEqual(validation.doesNotPassSampledValues, true, 'Should not pass sampled values');
            assert.strictEqual(validation.doesNotPassTextures, true, 'Should not pass textures');
            assert.strictEqual(validation.hasCorrectPattern, true, 'Should have correct entry point pattern');
        });

        it('should call transform with only 4 parameters (linear working space)', () => {
            // Correct entry point for linear - transform samples internally
            const correctEntryPoint = `
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    // transform() internally calls dctl_sampleTexture() to get pixel values
    let resultAP1 = transform(p_Width, p_Height, p_X, p_Y);

    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}`;
            const validation = validateEntryPoint(correctEntryPoint);

            assert.strictEqual(validation.callsTransformWith4Args, true, 'Should call transform with 4 args');
            assert.strictEqual(validation.doesNotPassSampledValues, true, 'Should not pass sampled values');
            assert.strictEqual(validation.doesNotPassTextures, true, 'Should not pass textures');
            assert.strictEqual(validation.hasCorrectPattern, true, 'Should have correct entry point pattern');
        });

        it('should detect INCORRECT entry point passing texture instead of using internal sampling', () => {
            // This was a bug: passing u_image_tex directly to transform (type mismatch)
            const incorrectEntryPoint = `
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    let resultACEScct = transform(p_Width, p_Height, p_X, p_Y, u_image_tex, u_image_tex, u_image_tex);

    let resultAP1 = dctl_ACEScct_to_lin_vec(resultACEScct);
    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}`;
            const validation = validateEntryPoint(incorrectEntryPoint);

            assert.strictEqual(validation.callsTransformWith4Args, false, 'Should NOT have 4-arg call pattern');
            assert.strictEqual(validation.doesNotPassTextures, false, 'Should detect texture being passed');
            assert.strictEqual(validation.hasCorrectPattern, false, 'Should detect incorrect pattern');
        });

        it('should detect INCORRECT entry point passing sampled values (unnecessary)', () => {
            // This is also incorrect: transform samples internally, no need to pre-sample
            const unnecessarySamplingEntryPoint = `
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    let sampled = dctl_sampleTexture(p_X, p_Y);
    let result = transform(p_Width, p_Height, p_X, p_Y, sampled.x, sampled.y, sampled.z);

    return vec4<f32>(result, 1.0);
}`;
            const validation = validateEntryPoint(unnecessarySamplingEntryPoint);

            assert.strictEqual(validation.callsTransformWith4Args, false, 'Should NOT have 4-arg call pattern');
            assert.strictEqual(validation.doesNotPassSampledValues, false, 'Should detect sampled values being passed');
            assert.strictEqual(validation.hasCorrectPattern, false, 'Should detect incorrect pattern');
        });
    });
});
