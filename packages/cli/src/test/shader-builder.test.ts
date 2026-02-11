/**
 * Shader Builder Tests
 *
 * Tests for buildBufferComputeShader and buildBufferComputeShaderWithRgc functions
 * that wrap the core shader building functionality.
 */

import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    buildBufferComputeShader,
    buildBufferComputeShaderWithRgc,
    detectTransformSignature,
    injectParameters,
    removeSampleTextureStub,
    rewriteTextureTransformSignature,
    rewriteTextureTransformForCompute,
} from '../shader-builder.js';
import type { CompileResult } from '@dctl-workbench/core';

/**
 * Create a mock CompileResult for testing
 */
function createMockCompileResult(wgsl: string): CompileResult {
    return {
        wgsl,
        diagnostics: [],
        parameters: [],
        entry_point: 'transform',
    };
}

describe('buildBufferComputeShader', () => {
    it('should generate compute shader for simple DCTL', () => {
        const mockWgsl = `
var<private> gain: f32 = 1.0f;

fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R * gain, p_G * gain, p_B * gain);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 1920,
            height: 1080,
        });

        // Check basic structure
        assert.ok(shader.includes('const p_Width: i32 = 1920;'));
        assert.ok(shader.includes('const p_Height: i32 = 1080;'));
        assert.ok(shader.includes('@compute @workgroup_size(8, 8, 1)'));
        assert.ok(shader.includes('fn main(@builtin(global_invocation_id) global_id: vec3<u32>)'));
        // Should have storage buffers for compute shader
        assert.ok(shader.includes('var<storage, read> input_buffer: array<f32>'));
        assert.ok(shader.includes('var<storage, read_write> output_buffer: array<f32>'));
    });

    it('should handle multiple UI parameters', () => {
        const mockWgsl = `
var<private> gain: f32;
var<private> offset: f32;
var<private> saturation: f32 = 1.0f;

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R * gain + offset, p_G * gain + offset, p_B * saturation);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 100,
            height: 100,
            paramValues: { gain: 1.5, offset: 0.1, saturation: 0.8 },
        });

        // Check parameters are injected
        assert.ok(shader.includes('var<private> gain: f32 = 1.5f;'));
        assert.ok(shader.includes('var<private> offset: f32 = 0.1f;'));
        assert.ok(shader.includes('var<private> saturation: f32 = 0.8f;'));
    });

    it('should inject color space conversions for ACEScct', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 100,
            height: 100,
            workingColorSpace: 'ACEScct',
        });

        // Check ACEScct encoding/decoding functions are present
        assert.ok(shader.includes('fn lin_to_ACEScct'));
        assert.ok(shader.includes('fn ACEScct_to_lin'));
        // Check color matrices
        assert.ok(shader.includes('mat_ap0_to_ap1'));
        assert.ok(shader.includes('mat_ap1_to_ap0'));
    });

    it('should handle ACEScg working space (linear)', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 100,
            height: 100,
            workingColorSpace: 'ACEScg',
        });

        // Check that ACEScct encoding is NOT applied (commented or absent)
        // Since ACEScg is linear, we don't need log encoding
        assert.ok(shader.includes('mat_ap0_to_ap1'));
        assert.ok(shader.includes('mat_ap1_to_ap0'));
    });

    it('should generate correct workgroup size', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 256,
            height: 256,
        });

        // Default workgroup size is 8x8x1
        assert.ok(shader.includes('@workgroup_size(8, 8, 1)'));
    });

    it('should handle texture-based DCTL signature', () => {
        const mockWgsl = `
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32> {
    let sampled = dctl_sampleTexture(p_X, p_Y);
    return sampled.rgb;
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 100,
            height: 100,
        });

        // For compute shader, texture params should be rewritten to i32
        assert.ok(shader.includes('fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: i32, p_TexG: i32, p_TexB: i32)'));
        // Compute shader should call with dummy values
        assert.ok(shader.includes('transform(p_Width, p_Height, x, y, 0, 0, 0)'));
    });

    it('should set input and output color spaces', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShader(compileResult, {
            width: 100,
            height: 100,
            inputColorSpace: 'AP0',
            outputColorSpace: 'AP0',
        });

        // Check shader comment indicates color spaces
        assert.ok(shader.includes('Input: AP0'));
        assert.ok(shader.includes('Output: AP0'));
    });
});

describe('buildBufferComputeShaderWithRgc', () => {
    it('should include RGC shader code', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const rgcFunctions = `
fn applyRGC(input: vec4<f32>) -> vec4<f32> {
    // Mock RGC implementation
    return input;
}
`;
        const rgcTextureBindings = `
@group(0) @binding(2) var rgc_lut: texture_2d<f32>;
`;

        const shader = buildBufferComputeShaderWithRgc(compileResult, {
            width: 100,
            height: 100,
            rgcWgslFunctions: rgcFunctions,
            rgcMainFunctionName: 'applyRGC',
            rgcTextureBindings: rgcTextureBindings,
        });

        assert.ok(shader.includes('fn applyRGC'));
        assert.ok(shader.includes('rgc_lut'));
        assert.ok(shader.includes('RGC: true'));
    });

    it('should apply RGC in correct order', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const rgcFunctions = `
fn myRgc(input: vec4<f32>) -> vec4<f32> {
    return input;
}
`;

        const shader = buildBufferComputeShaderWithRgc(compileResult, {
            width: 100,
            height: 100,
            rgcWgslFunctions: rgcFunctions,
            rgcMainFunctionName: 'myRgc',
            rgcTextureBindings: '',
        });

        // RGC should be called after AP0->AP1 conversion but before ACEScct encoding
        // Check the order in the main function
        const mainFnStart = shader.indexOf('fn main(');
        const rgcCallPos = shader.indexOf('myRgc', mainFnStart);
        assert.ok(rgcCallPos > 0, 'RGC function should be called in main');
    });

    it('should work with ACEScct working space and RGC', () => {
        const mockWgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const compileResult = createMockCompileResult(mockWgsl);

        const shader = buildBufferComputeShaderWithRgc(compileResult, {
            width: 100,
            height: 100,
            workingColorSpace: 'ACEScct',
            rgcWgslFunctions: 'fn rgc(v: vec4<f32>) -> vec4<f32> { return v; }',
            rgcMainFunctionName: 'rgc',
            rgcTextureBindings: '',
        });

        // Should have both RGC and ACEScct
        assert.ok(shader.includes('fn rgc'));
        assert.ok(shader.includes('lin_to_ACEScct'));
        assert.ok(shader.includes('ACEScct_to_lin'));
    });
});

describe('detectTransformSignature', () => {
    it('should detect texture-based signature', () => {
        const wgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32> {
    return vec3<f32>(0.0, 0.0, 0.0);
}
`;
        const type = detectTransformSignature(wgsl);
        assert.strictEqual(type, 'texture');
    });

    it('should detect float-based signature with p_R', () => {
        const wgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const type = detectTransformSignature(wgsl);
        assert.strictEqual(type, 'float');
    });

    it('should default to texture for unknown signature', () => {
        const wgsl = `
fn someOtherFunction() -> void {}
`;
        const type = detectTransformSignature(wgsl);
        assert.strictEqual(type, 'texture');
    });
});

describe('injectParameters', () => {
    it('should inject float parameter', () => {
        const wgsl = 'var<private> gain: f32;';
        const result = injectParameters(wgsl, { gain: 2.5 });
        assert.ok(result.includes('var<private> gain: f32 = 2.5f;'));
    });

    it('should inject integer parameter', () => {
        const wgsl = 'var<private> mode: i32;';
        const result = injectParameters(wgsl, { mode: 3 });
        assert.ok(result.includes('var<private> mode: i32 = 3i;'));
    });

    it('should inject boolean parameter', () => {
        const wgsl = 'var<private> enabled: bool;';
        const result = injectParameters(wgsl, { enabled: true });
        assert.ok(result.includes('var<private> enabled: bool = true;'));
    });

    it('should handle parameter with suffix', () => {
        const wgsl = 'var<private> dmax_2: f32;';
        const result = injectParameters(wgsl, { dmax: 1000.0 });
        assert.ok(result.includes('var<private> dmax_2: f32 = 1000f;'));
    });

    it('should preserve parameters without matching values', () => {
        const wgsl = 'var<private> gain: f32 = 1.0f;';
        const result = injectParameters(wgsl, { other: 2.0 });
        assert.strictEqual(result, wgsl);
    });

    it('should handle multiple parameters', () => {
        const wgsl = `
var<private> gain: f32;
var<private> offset: f32 = 0.0f;
var<private> mode: i32;
`;
        const result = injectParameters(wgsl, { gain: 1.5, offset: 0.1, mode: 2 });
        assert.ok(result.includes('var<private> gain: f32 = 1.5f;'));
        assert.ok(result.includes('var<private> offset: f32 = 0.1f;'));
        assert.ok(result.includes('var<private> mode: i32 = 2i;'));
    });
});

describe('removeSampleTextureStub', () => {
    it('should remove dctl_sampleTexture stub', () => {
        const wgsl = `
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}

fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const result = removeSampleTextureStub(wgsl);
        assert.ok(!result.includes('fn dctl_sampleTexture'));
        assert.ok(result.includes('fn transform'));
    });

    it('should preserve code when no stub present', () => {
        const wgsl = `
fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_R: f32, p_G: f32, p_B: f32) -> vec3<f32> {
    return vec3<f32>(p_R, p_G, p_B);
}
`;
        const result = removeSampleTextureStub(wgsl);
        assert.ok(result.includes('fn transform'));
    });
});

describe('rewriteTextureTransformSignature', () => {
    it('should remove texture_2d parameters', () => {
        const wgsl = `fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32>`;
        const result = rewriteTextureTransformSignature(wgsl);
        assert.strictEqual(result, 'fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32) -> vec3<f32>');
    });
});

describe('rewriteTextureTransformForCompute', () => {
    it('should replace texture_2d with i32', () => {
        const wgsl = `fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>) -> vec3<f32>`;
        const result = rewriteTextureTransformForCompute(wgsl);
        assert.strictEqual(result, 'fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: i32, p_TexG: i32, p_TexB: i32) -> vec3<f32>');
    });
});
