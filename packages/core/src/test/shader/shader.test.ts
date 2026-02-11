/**
 * Shader Module Unit Tests
 */

import { strict as assert } from 'assert';
import {
    detectTransformSignature,
    rewriteTextureTransformSignature,
    rewriteTextureTransformForCompute,
    extractWgslParams,
    injectParameters,
    removeSampleTextureStub,
    generateColorSpaceCode,
    generateFragmentTextureSampler,
    generateFragmentEntryPoint,
    buildExportShader,
    buildComputeShader,
    buildShaderParamMapping,
    buildDctlParamAccessors,
} from '../../shader/index';

describe('detectTransformSignature', () => {
    it('should detect texture-based signature (texture_2d params)', () => {
        const wgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`;
        const result = detectTransformSignature(wgsl);
        assert.equal(result, 'texture');
    });

    it('should detect float-based signature (p_R, p_G, p_B params)', () => {
        const wgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}`;
        const result = detectTransformSignature(wgsl);
        assert.equal(result, 'float');
    });

    it('should default to texture for unknown signature', () => {
        const wgsl = `
fn transform(a: i32, b: i32) -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`;
        const result = detectTransformSignature(wgsl);
        assert.equal(result, 'texture');
    });

    it('should default to texture when no transform function found', () => {
        const wgsl = `
fn other_function() -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`;
        const result = detectTransformSignature(wgsl);
        assert.equal(result, 'texture');
    });
});

describe('rewriteTextureTransformSignature', () => {
    it('should remove texture_2d parameters from signature', () => {
        const wgsl = `fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>)`;
        const result = rewriteTextureTransformSignature(wgsl);
        assert.equal(result, 'fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32)');
    });

    it('should preserve p_Width, p_Height, p_X, p_Y parameters', () => {
        const wgsl = `fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>)`;
        const result = rewriteTextureTransformSignature(wgsl);
        assert.ok(result.includes('p_Width: i32'));
        assert.ok(result.includes('p_Height: i32'));
        assert.ok(result.includes('p_X: i32'));
        assert.ok(result.includes('p_Y: i32'));
    });

    it('should not modify non-matching signatures', () => {
        const wgsl = `fn other(x: i32) -> i32 { return x; }`;
        const result = rewriteTextureTransformSignature(wgsl);
        assert.equal(result, wgsl);
    });
});

describe('rewriteTextureTransformForCompute', () => {
    it('should replace texture_2d with i32 dummy params', () => {
        const wgsl = `fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>)`;
        const result = rewriteTextureTransformForCompute(wgsl);
        assert.ok(result.includes('p_TexR: i32'));
        assert.ok(result.includes('p_TexG: i32'));
        assert.ok(result.includes('p_TexB: i32'));
    });
});

describe('extractWgslParams', () => {
    it('should extract uninitialized var<private> declarations', () => {
        const wgsl = `
var<private> gain: f32;
var<private> iterations: i32;
var<private> enabled: bool;
`;
        const params = extractWgslParams(wgsl);
        assert.equal(params.length, 3);
        assert.equal(params[0].name, 'gain');
        assert.equal(params[0].type, 'f32');
        assert.equal(params[1].name, 'iterations');
        assert.equal(params[1].type, 'i32');
        assert.equal(params[2].name, 'enabled');
        assert.equal(params[2].type, 'bool');
    });

    it('should extract initialized var<private> declarations', () => {
        const wgsl = `
var<private> gain: f32 = 1.0f;
var<private> count: i32 = 5i;
`;
        const params = extractWgslParams(wgsl);
        assert.equal(params.length, 2);
        assert.equal(params[0].name, 'gain');
        assert.equal(params[1].name, 'count');
    });
});

describe('injectParameters', () => {
    it('should inject f32 parameter values', () => {
        const wgsl = `var<private> gain: f32;`;
        const result = injectParameters(wgsl, { gain: 2.5 });
        assert.ok(result.includes('var<private> gain: f32 = 2.5f;'));
    });

    it('should inject i32 parameter values', () => {
        const wgsl = `var<private> iterations: i32;`;
        const result = injectParameters(wgsl, { iterations: 10 });
        assert.ok(result.includes('var<private> iterations: i32 = 10i;'));
    });

    it('should inject bool parameter values', () => {
        const wgsl = `var<private> enabled: bool;`;
        const result = injectParameters(wgsl, { enabled: true });
        assert.ok(result.includes('var<private> enabled: bool = true;'));
    });

    it('should handle renamed parameters with _N suffix', () => {
        const wgsl = `var<private> dmax_2: f32;`;
        const result = injectParameters(wgsl, { dmax: 100.0 });
        assert.ok(result.includes('var<private> dmax_2: f32 = 100f;'));
    });

    it('should prefer exact match over base name match', () => {
        const wgsl = `var<private> gain: f32;`;
        const result = injectParameters(wgsl, { gain: 3.0, gai: 1.0 });
        assert.ok(result.includes('var<private> gain: f32 = 3f;'));
    });

    it('should not modify parameters without values', () => {
        const wgsl = `var<private> unused: f32;`;
        const result = injectParameters(wgsl, { other: 1.0 });
        assert.equal(result, wgsl);
    });

    it('should floor i32 values when given floats', () => {
        const wgsl = `var<private> count: i32;`;
        const result = injectParameters(wgsl, { count: 5.9 });
        assert.ok(result.includes('var<private> count: i32 = 5i;'));
    });

    it('should inject boolean true as i32 = 1 for checkbox params', () => {
        // DCTL CHECK_BOX compiles to i32, but VS Code stores value as boolean
        const wgsl = `var<private> clamp_min: i32;`;
        const result = injectParameters(wgsl, { clamp_min: true });
        assert.ok(result.includes('var<private> clamp_min: i32 = 1i;'),
            `Expected i32 = 1i, got: ${result}`);
    });

    it('should inject boolean false as i32 = 0 for checkbox params', () => {
        const wgsl = `var<private> clamp_min: i32;`;
        const result = injectParameters(wgsl, { clamp_min: false });
        assert.ok(result.includes('var<private> clamp_min: i32 = 0i;'),
            `Expected i32 = 0i, got: ${result}`);
    });
});

describe('removeSampleTextureStub', () => {
    it('should remove stub returning vec4(0,0,0,0)', () => {
        const wgsl = `
fn dctl_sampleTexture(tex: texture_2d<f32>, x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

fn transform() -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`;
        const result = removeSampleTextureStub(wgsl);
        assert.ok(!result.includes('fn dctl_sampleTexture'));
        assert.ok(result.includes('fn transform'));
    });

    it('should preserve code when no stub present', () => {
        const wgsl = `
fn transform() -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`;
        const result = removeSampleTextureStub(wgsl);
        assert.ok(result.includes('fn transform'));
    });
});

describe('generateColorSpaceCode', () => {
    it('should generate ACEScct encoding for log color spaces', () => {
        const code = generateColorSpaceCode('ACEScct');
        assert.ok(code.includes('dctl_ap0ToWorking'));
        assert.ok(code.includes('dctl_workingToAp0'));
        assert.ok(code.includes('dctl_lin_to_ACEScct'));
        assert.ok(code.includes('dctl_ACEScct_to_lin'));
    });

    it('should not generate encoding functions for linear color spaces', () => {
        const code = generateColorSpaceCode('ACEScg');
        assert.ok(code.includes('dctl_ap0ToWorking'));
        assert.ok(code.includes('dctl_workingToAp0'));
        assert.ok(!code.includes('dctl_lin_to_ACEScct'));
        assert.ok(!code.includes('dctl_ACEScct_to_lin'));
    });

    it('should include mat3x3<f32> matrix definitions', () => {
        const code = generateColorSpaceCode('ACEScct');
        assert.ok(code.includes('mat3x3<f32>'));
    });
});

describe('generateFragmentTextureSampler', () => {
    it('should generate sampler with ACEScct encoding for log spaces', () => {
        const code = generateFragmentTextureSampler('ACEScct');
        assert.ok(code.includes('fn dctl_sampleTexture'));
        assert.ok(code.includes('dctl_lin_to_ACEScct_vec'));
    });

    it('should generate linear sampler for linear spaces', () => {
        const code = generateFragmentTextureSampler('ACEScg');
        assert.ok(code.includes('fn dctl_sampleTexture'));
        assert.ok(!code.includes('dctl_lin_to_ACEScct_vec'));
    });

    it('should include RGC function call when applyRgc is true', () => {
        const code = generateFragmentTextureSampler('ACEScct', true, 'myRgcFunction');
        assert.ok(code.includes('myRgcFunction'));
        assert.ok(code.includes('Apply ACES 2.0 RGC'));
    });

    it('should not include RGC when applyRgc is false', () => {
        const code = generateFragmentTextureSampler('ACEScct', false);
        assert.ok(!code.includes('Apply ACES 2.0 RGC'));
    });
});

describe('generateFragmentEntryPoint', () => {
    it('should generate float-based entry for float transform type with log space', () => {
        const code = generateFragmentEntryPoint('float', 'ACEScct');
        assert.ok(code.includes('@fragment'));
        assert.ok(code.includes('fn main'));
        assert.ok(code.includes('transform(p_Width, p_Height, p_X, p_Y, p_R, p_G, p_B)'));
        assert.ok(code.includes('dctl_ACEScct_to_lin_vec'));
    });

    it('should generate float-based entry for float transform type with linear space', () => {
        const code = generateFragmentEntryPoint('float', 'ACEScg');
        assert.ok(code.includes('@fragment'));
        assert.ok(code.includes('transform(p_Width, p_Height, p_X, p_Y, p_R, p_G, p_B)'));
        assert.ok(!code.includes('dctl_ACEScct_to_lin_vec'));
    });

    it('should generate texture-based entry for texture transform type with log space', () => {
        const code = generateFragmentEntryPoint('texture', 'ACEScct');
        assert.ok(code.includes('@fragment'));
        assert.ok(code.includes('transform(p_Width, p_Height, p_X, p_Y)'));
        assert.ok(code.includes('dctl_ACEScct_to_lin_vec'));
    });

    it('should generate texture-based entry for texture transform type with linear space', () => {
        const code = generateFragmentEntryPoint('texture', 'ACEScg');
        assert.ok(code.includes('@fragment'));
        assert.ok(code.includes('transform(p_Width, p_Height, p_X, p_Y)'));
        assert.ok(!code.includes('dctl_ACEScct_to_lin_vec'));
    });
});

describe('buildExportShader', () => {
    const mockCompileResult = {
        wgsl: `
fn dctl_sampleTexture(tex: texture_2d<f32>, x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

var<private> gain: f32;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`,
        diagnostics: [],
        parameters: [],
        entry_point: 'transform',
    };

    it('should build a complete export shader', () => {
        const result = buildExportShader(mockCompileResult, {
            width: 1920,
            height: 1080,
        });
        assert.ok(result.wgsl);
        assert.ok(result.wgsl.includes('const p_Width: i32 = 1920'));
        assert.ok(result.wgsl.includes('const p_Height: i32 = 1080'));
        assert.ok(result.bindings.length >= 2);
    });

    it('should inject parameter values', () => {
        const result = buildExportShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            paramValues: { gain: 2.0 },
        });
        assert.ok(result.wgsl.includes('var<private> gain: f32 = 2f;'));
    });

    it('should remove dctl_sampleTexture stub', () => {
        const result = buildExportShader(mockCompileResult, {
            width: 1920,
            height: 1080,
        });
        // Should have our generated dctl_sampleTexture, not the stub
        assert.ok(!result.wgsl.includes('return vec4<f32>(0.0, 0.0, 0.0, 0.0)'));
    });

    it('should include RGC code when applyRGC is true', () => {
        const result = buildExportShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            applyRGC: true,
            rgcWgslCode: 'fn myRgcFunc() {}',
            rgcFunctionName: 'myRgcFunc',
        });
        assert.ok(result.wgsl.includes('fn myRgcFunc()'));
    });

    it('should generate ACEScct code for log working spaces', () => {
        const result = buildExportShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            workingColorSpace: 'ACEScct',
        });
        assert.ok(result.wgsl.includes('Working space: ACEScct'));
        assert.ok(result.wgsl.includes('dctl_lin_to_ACEScct'));
    });

    it('should generate linear code for ACEScg working space', () => {
        const result = buildExportShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            workingColorSpace: 'ACEScg',
        });
        assert.ok(result.wgsl.includes('Working space: ACEScg'));
        assert.ok(!result.wgsl.includes('dctl_lin_to_ACEScct'));
    });
});

describe('buildComputeShader', () => {
    const mockCompileResult = {
        wgsl: `
fn dctl_sampleTexture(tex: texture_2d<f32>, x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

var<private> gain: f32;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}`,
        diagnostics: [],
        parameters: [],
        entry_point: 'transform',
    };

    it('should build a complete compute shader', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
        });
        assert.ok(result.wgsl);
        assert.ok(result.wgsl.includes('@compute @workgroup_size(8, 8, 1)'));
        assert.ok(result.wgsl.includes('fn main(@builtin(global_invocation_id)'));
        assert.ok(result.wgsl.includes('const p_Width: i32 = 1920'));
    });

    it('should include storage buffer declarations', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
        });
        assert.ok(result.wgsl.includes('var<storage, read> input_buffer'));
        assert.ok(result.wgsl.includes('var<storage, read_write> output_buffer'));
    });

    it('should inject parameter values', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            paramValues: { gain: 2.5 },
        });
        assert.ok(result.wgsl.includes('var<private> gain: f32 = 2.5f;'));
    });

    it('should include transfer functions for ACEScct', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            workingColorSpace: 'ACEScct',
        });
        assert.ok(result.wgsl.includes('lin_to_ACEScct'));
        assert.ok(result.wgsl.includes('ACEScct_to_lin'));
    });

    it('should include AP0 to AP1 conversion for AP0 input', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            inputColorSpace: 'AP0',
        });
        assert.ok(result.wgsl.includes('mat_ap0_to_ap1'));
    });

    it('should include AP1 to AP0 conversion for AP0 output', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            outputColorSpace: 'AP0',
        });
        assert.ok(result.wgsl.includes('mat_ap1_to_ap0'));
    });

    it('should include RGC functions when applyRGC is true', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            applyRGC: true,
            rgcWgslFunctions: 'fn applyRgc() -> vec4<f32> { return vec4<f32>(1.0); }',
            rgcMainFunctionName: 'applyRgc',
        });
        assert.ok(result.wgsl.includes('fn applyRgc()'));
    });

    it('should include RGC texture bindings when provided', () => {
        const result = buildComputeShader(mockCompileResult, {
            width: 1920,
            height: 1080,
            applyRGC: true,
            rgcTextureBindings: '@group(1) @binding(0) var lut_texture: texture_3d<f32>;',
        });
        assert.ok(result.wgsl.includes('@group(1) @binding(0) var lut_texture'));
    });

    it('should handle float-based transform signature', () => {
        const floatCompileResult = {
            wgsl: `
var<private> gain: f32;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}`,
            diagnostics: [],
            parameters: [],
            entry_point: 'transform',
        };

        const result = buildComputeShader(floatCompileResult, {
            width: 1920,
            height: 1080,
        });
        assert.ok(result.wgsl.includes('Transform type: float'));
        assert.ok(result.wgsl.includes('transform(p_Width, p_Height, x, y, rgb.x, rgb.y, rgb.z)'));
    });
});

describe('buildDctlParamAccessors', () => {
    it('should generate i32 accessor for CHECK_BOX params (not bool)', () => {
        // CHECK_BOX params are mapped as type 'bool' in ShaderParamMapping,
        // but the Rust compiler declares them as var<private>: i32 in WGSL.
        // The accessor must return i32 to match, otherwise WGSL type mismatch occurs.
        const mapping = buildShaderParamMapping([
            { name: 'clamp_min', label: 'Clamp Min', type: 'DCTL_CHECK_BOX', default: true },
            { name: 'clamp_max', label: 'Clamp Max', type: 'DCTL_CHECK_BOX', default: false },
        ]);

        const accessors = buildDctlParamAccessors(mapping);

        // Accessor should return i32, not bool
        assert.ok(accessors.includes('-> i32'), `Expected accessor to return i32, got: ${accessors}`);
        assert.ok(!accessors.includes('-> bool'), `Accessor should NOT return bool, got: ${accessors}`);
    });

    it('should generate correct accessor types for all param types', () => {
        const mapping = buildShaderParamMapping([
            { name: 'gain', label: 'Gain', type: 'DCTL_SLIDER_FLOAT', default: 1.0, min: 0, max: 2, step: 0.01 },
            { name: 'iterations', label: 'Iterations', type: 'DCTL_SLIDER_INT', default: 5, min: 1, max: 10, step: 1 },
            { name: 'enabled', label: 'Enabled', type: 'DCTL_CHECK_BOX', default: true },
        ]);

        const accessors = buildDctlParamAccessors(mapping);

        // Float accessor should return f32
        assert.ok(accessors.includes('get_gain() -> f32'), `Expected f32 accessor for float param`);
        // Int accessor should return i32
        assert.ok(accessors.includes('get_iterations() -> i32'), `Expected i32 accessor for int param`);
        // CHECK_BOX accessor should return i32 (not bool) to match Rust compiler output
        assert.ok(accessors.includes('get_enabled() -> i32'), `Expected i32 accessor for check_box param`);
    });

    it('should generate correct mapping and accessors for sample2.dctl params (VALUE_BOX + CHECK_BOX)', () => {
        // Simulates the exact params from sample2.dctl:
        // DEFINE_UI_PARAMS(min_val, Minimum Value, DCTLUI_VALUE_BOX, 0.0f) → normalized to DCTL_VALUE_BOX
        // DEFINE_UI_PARAMS(max_val, Maximum Value, DCTLUI_VALUE_BOX, 1.0f) → normalized to DCTL_VALUE_BOX
        // DEFINE_UI_PARAMS(clamp_min, Clamp Min, DCTLUI_CHECK_BOX, 1) → normalized to DCTL_CHECK_BOX
        // DEFINE_UI_PARAMS(clamp_max, Clamp Max, DCTLUI_CHECK_BOX, 1) → normalized to DCTL_CHECK_BOX
        const mapping = buildShaderParamMapping([
            { name: 'min_val', label: 'Minimum Value', type: 'DCTL_VALUE_BOX', default: 0.0 },
            { name: 'max_val', label: 'Maximum Value', type: 'DCTL_VALUE_BOX', default: 1.0 },
            { name: 'clamp_min', label: 'Clamp Min', type: 'DCTL_CHECK_BOX', default: true },
            { name: 'clamp_max', label: 'Clamp Max', type: 'DCTL_CHECK_BOX', default: true },
        ]);

        // Verify mapping has 4 params
        assert.equal(mapping.length, 4, `Expected 4 params, got ${mapping.length}`);

        // Verify VALUE_BOX params are mapped as float
        const minValMapping = mapping.find(m => m.name === 'min_val');
        assert.ok(minValMapping, 'min_val mapping not found');
        assert.equal(minValMapping!.type, 'float', 'min_val should be float');
        assert.equal(minValMapping!.bufferType, 'float_params', 'min_val should use float_params');
        assert.equal(minValMapping!.index, 0, 'min_val should have index 0');

        const maxValMapping = mapping.find(m => m.name === 'max_val');
        assert.ok(maxValMapping, 'max_val mapping not found');
        assert.equal(maxValMapping!.type, 'float', 'max_val should be float');
        assert.equal(maxValMapping!.index, 1, 'max_val should have index 1');

        // Verify CHECK_BOX params are mapped as bool in int_params
        const clampMinMapping = mapping.find(m => m.name === 'clamp_min');
        assert.ok(clampMinMapping, 'clamp_min mapping not found');
        assert.equal(clampMinMapping!.type, 'bool', 'clamp_min should be bool');
        assert.equal(clampMinMapping!.bufferType, 'int_params', 'clamp_min should use int_params');
        assert.equal(clampMinMapping!.index, 0, 'clamp_min should have index 0');

        const clampMaxMapping = mapping.find(m => m.name === 'clamp_max');
        assert.ok(clampMaxMapping, 'clamp_max mapping not found');
        assert.equal(clampMaxMapping!.type, 'bool', 'clamp_max should be bool');
        assert.equal(clampMaxMapping!.index, 1, 'clamp_max should have index 1');

        // Generate accessors and verify
        const accessors = buildDctlParamAccessors(mapping);

        // float_params accessors: vec4Index = floor(index/4), componentIndex = index%4
        assert.ok(accessors.includes('fn get_min_val() -> f32 { return dctl_params.float_params[0][0]; }'),
            `Expected min_val accessor at [0][0], got: ${accessors}`);
        assert.ok(accessors.includes('fn get_max_val() -> f32 { return dctl_params.float_params[0][1]; }'),
            `Expected max_val accessor at [0][1], got: ${accessors}`);

        // int_params accessors for CHECK_BOX (should return i32, not bool)
        assert.ok(accessors.includes('fn get_clamp_min() -> i32 { return dctl_params.int_params[0][0]; }'),
            `Expected clamp_min accessor at [0][0] returning i32, got: ${accessors}`);
        assert.ok(accessors.includes('fn get_clamp_max() -> i32 { return dctl_params.int_params[0][1]; }'),
            `Expected clamp_max accessor at [0][1] returning i32, got: ${accessors}`);
    });
});
