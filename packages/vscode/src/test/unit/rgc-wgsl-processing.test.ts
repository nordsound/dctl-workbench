/**
 * Unit tests for RGC WGSL processing
 * Tests the string manipulation logic used in dctl-compute-wgsl-builder.ts
 */

import * as assert from 'assert';

/**
 * Simulates the RGC WGSL processing logic from buildCompleteComputeShader
 * This is a direct port of the processing steps to enable unit testing
 */
function processRgcWgsl(
    rgcWgsl: string,
    rgcTextures: { samplerName: string }[] = [],
    rgcTextures3D: { samplerName: string }[] = []
): {
    functions: string;
    hadArrayBefore: boolean;
    hasArrayAfter: boolean;
    arrayDeclarations: string[];
    hasApplyRgcFunction: boolean;
    hasRenamedArray: boolean;
} {
    // Check for array declarations before processing
    const hadArrayBefore = rgcWgsl.includes('hues_array');

    // Extract array declarations to preserve them
    const arrayDeclarations: string[] = [];
    const arrayDeclRegex = /var<private>\s+(\w+)\s*:\s*array<[^>]+>[^;]*;/g;
    let arrayMatch;
    while ((arrayMatch = arrayDeclRegex.exec(rgcWgsl)) !== null) {
        arrayDeclarations.push(arrayMatch[0]);
    }

    let rgcFunctions = rgcWgsl
        // Remove all binding declarations (texture, sampler, uniform)
        .replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var\s+\w+\s*:\s*(texture_2d|texture_3d|sampler)[^;]*;/g, '')
        // Remove any uniform declarations
        .replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var<uniform>[^;]+;/g, '')
        // Remove struct declarations (FragmentOutput, VertexOutput, Params, etc.)
        .replace(/struct\s+(FragmentOutput|VertexOutput|\w+Params)\s*\{[^}]*\}\s*/g, '')
        // Remove only fragment I/O var<private> declarations (not arrays/data)
        .replace(/var<private>\s+(v_texCoord_\d*|fragColor|gl_\w+)\s*:\s*[^;]+;/g, '')
        // Remove @fragment fn main and everything after (entry point is at the end)
        .replace(/@fragment[\s\S]*$/m, '')
        // Also remove any fn main_1 helper function that naga might generate
        .replace(/fn\s+main_1\s*\(\s*\)\s*\{[\s\S]*?\n\}\s*\n?/gm, '')
        // Clean up any empty lines
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();

    // Check if array declaration survived processing
    const hasArrayAfterInitialProcessing = rgcFunctions.includes('hues_array');

    // If array declarations were removed, add them back
    if (arrayDeclarations.length > 0 && !hasArrayAfterInitialProcessing) {
        rgcFunctions = arrayDeclarations.join('\n') + '\n\n' + rgcFunctions;
    }

    // Prefix texture/sampler references with rgc_
    for (const tex of rgcTextures) {
        const name = tex.samplerName;
        rgcFunctions = rgcFunctions
            .replace(new RegExp(`\\b${name}_tex\\b`, 'g'), `rgc_${name}_tex`)
            .replace(new RegExp(`\\b${name}_samp\\b`, 'g'), `rgc_${name}_samp`);
    }
    for (const tex of rgcTextures3D) {
        const name = tex.samplerName;
        rgcFunctions = rgcFunctions
            .replace(new RegExp(`\\b${name}_tex\\b`, 'g'), `rgc_${name}_tex`)
            .replace(new RegExp(`\\b${name}_samp\\b`, 'g'), `rgc_${name}_samp`);
    }

    // Rename OCIODisplay to applyACES2RGC
    rgcFunctions = rgcFunctions
        .replace(/fn\s+OCIODisplay\s*\(/g, 'fn applyACES2RGC(')
        .replace(/fn\s+ocio_main\s*\(/g, 'fn applyACES2RGC(')
        .replace(/fn\s+OCIOMain\s*\(/g, 'fn applyACES2RGC(');

    // Prefix ALL ocio_ functions with rgc_
    const ocioFunctionPattern = /\bocio_(\w+)/g;
    rgcFunctions = rgcFunctions.replace(ocioFunctionPattern, 'rgc_ocio_$1');

    const hasArrayAfter = rgcFunctions.includes('hues_array');
    const hasApplyRgcFunction = rgcFunctions.includes('fn applyACES2RGC');
    const hasRenamedArray = rgcFunctions.includes('rgc_ocio_gamut_cusp_table_0_hues_array');

    return {
        functions: rgcFunctions,
        hadArrayBefore,
        hasArrayAfter,
        arrayDeclarations,
        hasApplyRgcFunction,
        hasRenamedArray
    };
}

describe('RGC WGSL Processing', () => {
    describe('Array Declaration Preservation', () => {
        it('should preserve array declarations that appear before @fragment', () => {
            const inputWgsl = `
var<private> ocio_gamut_cusp_table_0_hues_array: array<i32, 360> = array<i32, 360>(
    0, 1, 2, 3, 4, 5
);

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.hadArrayBefore, true, 'Should have found array before processing');
            assert.strictEqual(result.hasArrayAfter, true, 'Array should be preserved after processing');
            assert.strictEqual(result.hasRenamedArray, true, 'Array should be renamed to rgc_ocio_');
            assert.strictEqual(result.hasApplyRgcFunction, true, 'OCIODisplay should be renamed to applyACES2RGC');
        });

        it('should restore array declarations that appear after @fragment (naga output edge case)', () => {
            // This is the problematic case: when naga puts array declarations after @fragment
            const inputWgsl = `
fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    let idx = ocio_gamut_cusp_table_0_hues_array[0];
    return input;
}

@fragment
fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}

var<private> ocio_gamut_cusp_table_0_hues_array: array<i32, 360> = array<i32, 360>(
    0, 1, 2, 3, 4, 5
);
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.hadArrayBefore, true, 'Should have found array in input');
            assert.strictEqual(result.arrayDeclarations.length, 1, 'Should have extracted one array declaration');
            assert.strictEqual(result.hasArrayAfter, true, 'Array should be restored after processing');
            assert.strictEqual(result.hasRenamedArray, true, 'Restored array should be renamed');
        });

        it('should handle multiple array declarations', () => {
            const inputWgsl = `
var<private> ocio_reach_m_table_0_hues_array: array<i32, 180>;
var<private> ocio_gamut_cusp_table_0_hues_array: array<i32, 360>;

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.arrayDeclarations.length, 2, 'Should extract both array declarations');
            assert.strictEqual(result.hasRenamedArray, true, 'Arrays should be renamed');
        });

        it('should not modify WGSL without array declarations', () => {
            const inputWgsl = `
fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.hadArrayBefore, false, 'Should not find array in input');
            assert.strictEqual(result.arrayDeclarations.length, 0, 'Should not extract any array declarations');
            assert.strictEqual(result.hasApplyRgcFunction, true, 'OCIODisplay should still be renamed');
        });
    });

    describe('Binding Declaration Removal', () => {
        it('should remove texture binding declarations', () => {
            const inputWgsl = `
@group(0) @binding(0) var my_texture: texture_2d<f32>;
@group(0) @binding(1) var my_sampler: sampler;

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('@group'), false, 'Should remove binding declarations');
            assert.strictEqual(result.functions.includes('@binding'), false, 'Should remove binding decorators');
        });

        it('should remove 3D texture bindings', () => {
            const inputWgsl = `
@group(0) @binding(0) var lut_3d: texture_3d<f32>;
@group(0) @binding(1) var lut_sampler: sampler;

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('texture_3d'), false, 'Should remove 3D texture declarations');
        });
    });

    describe('Function Renaming', () => {
        it('should rename OCIODisplay to applyACES2RGC', () => {
            const inputWgsl = `
fn OCIODisplay(inColor: vec4<f32>) -> vec4<f32> {
    return inColor;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('fn applyACES2RGC'), true, 'Should rename to applyACES2RGC');
            assert.strictEqual(result.functions.includes('fn OCIODisplay'), false, 'Should not contain original name');
        });

        it('should prefix ocio_ helper functions with rgc_', () => {
            const inputWgsl = `
fn ocio_helper_function() -> f32 {
    return 1.0;
}

fn ocio_get_focus_gain(x: f32) -> f32 {
    return x * 2.0;
}

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    let h = ocio_helper_function();
    let g = ocio_get_focus_gain(h);
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('fn rgc_ocio_helper_function'), true, 'Should prefix helper function');
            assert.strictEqual(result.functions.includes('fn rgc_ocio_get_focus_gain'), true, 'Should prefix all ocio_ functions');
            // Check that calls are also renamed
            assert.strictEqual(result.functions.includes('rgc_ocio_helper_function()'), true, 'Should prefix function calls');
        });
    });

    describe('Fragment Shader Removal', () => {
        it('should remove everything after @fragment', () => {
            const inputWgsl = `
fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main(@location(0) texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let color = OCIODisplay(vec4<f32>(1.0));
    return color;
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('@fragment'), false, 'Should remove @fragment');
            assert.strictEqual(result.functions.includes('fn main'), false, 'Should remove main function');
            assert.strictEqual(result.functions.includes('texCoord'), false, 'Should remove main function body');
        });

        it('should remove fragment I/O var<private> declarations', () => {
            const inputWgsl = `
var<private> v_texCoord_1: vec2<f32>;
var<private> fragColor: vec4<f32>;
var<private> gl_FragCoord: vec4<f32>;

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('v_texCoord'), false, 'Should remove v_texCoord');
            assert.strictEqual(result.functions.includes('fragColor'), false, 'Should remove fragColor');
            assert.strictEqual(result.functions.includes('gl_FragCoord'), false, 'Should remove gl_FragCoord');
        });

        it('should preserve data arrays while removing fragment I/O', () => {
            const inputWgsl = `
var<private> v_texCoord_1: vec2<f32>;
var<private> ocio_data_array: array<f32, 10>;

fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    return input;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const result = processRgcWgsl(inputWgsl);

            assert.strictEqual(result.functions.includes('v_texCoord'), false, 'Should remove fragment I/O');
            assert.strictEqual(result.functions.includes('rgc_ocio_data_array'), true, 'Should preserve data array');
        });
    });

    describe('Texture Reference Prefixing', () => {
        it('should prefix 2D texture references with rgc_', () => {
            const inputWgsl = `
fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    let sample = textureSample(lut_tex, lut_samp, vec2<f32>(0.5, 0.5));
    return sample;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const textures = [{ samplerName: 'lut' }];
            const result = processRgcWgsl(inputWgsl, textures, []);

            assert.strictEqual(result.functions.includes('rgc_lut_tex'), true, 'Should prefix texture name');
            assert.strictEqual(result.functions.includes('rgc_lut_samp'), true, 'Should prefix sampler name');
        });

        it('should prefix 3D texture references with rgc_', () => {
            const inputWgsl = `
fn OCIODisplay(input: vec4<f32>) -> vec4<f32> {
    let sample = textureSample(lut3d_tex, lut3d_samp, vec3<f32>(0.5));
    return sample;
}

@fragment
fn main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0);
}
`;
            const textures3D = [{ samplerName: 'lut3d' }];
            const result = processRgcWgsl(inputWgsl, [], textures3D);

            assert.strictEqual(result.functions.includes('rgc_lut3d_tex'), true, 'Should prefix 3D texture name');
            assert.strictEqual(result.functions.includes('rgc_lut3d_samp'), true, 'Should prefix 3D sampler name');
        });
    });

    describe('Real-world OCIO Output Simulation', () => {
        it('should correctly process simulated OCIO RGC shader output', () => {
            // This simulates the structure of actual OCIO-generated WGSL
            // Note: Texture references must be inside functions that are preserved (not in main())
            const simulatedOcioWgsl = `
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;
@group(0) @binding(2) var ocio_gamut_cusp_table_0_tex: texture_2d<f32>;
@group(0) @binding(3) var ocio_gamut_cusp_table_0_samp: sampler;
@group(0) @binding(4) var ocio_reach_m_table_0_tex: texture_2d<f32>;
@group(0) @binding(5) var ocio_reach_m_table_0_samp: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

var<private> v_texCoord_1: vec2<f32>;

var<private> ocio_gamut_cusp_table_0_hues_array: array<i32, 360> = array<i32, 360>(
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9
);

fn ocio_gamut_cusp_table_0_sample(h: f32) -> f32 {
    // Texture lookup inside helper function (preserved)
    let value = textureSample(ocio_gamut_cusp_table_0_tex, ocio_gamut_cusp_table_0_samp, vec2<f32>(h, 0.5));
    let idx = ocio_gamut_cusp_table_0_hues_array[i32(h * 360.0) % 360];
    return value.r + f32(idx);
}

fn ocio_reach_m_table_0_sample(x: f32) -> f32 {
    // Another texture lookup inside helper
    let value = textureSample(ocio_reach_m_table_0_tex, ocio_reach_m_table_0_samp, vec2<f32>(x, 0.5));
    return value.r;
}

fn ocio_get_focus_gain(x: f32, y: f32) -> f32 {
    return x * y;
}

fn OCIODisplay(inPixel: vec4<f32>) -> vec4<f32> {
    let h = ocio_gamut_cusp_table_0_sample(inPixel.r);
    let m = ocio_reach_m_table_0_sample(inPixel.g);
    let g = ocio_get_focus_gain(h, m);
    return vec4<f32>(g, g, g, 1.0);
}

@fragment
fn main(in: VertexOutput) -> @location(0) vec4<f32> {
    v_texCoord_1 = in.texCoord;
    let color = textureSample(u_image_tex, u_image_samp, in.texCoord);
    return OCIODisplay(color);
}
`;
            const textures = [
                { samplerName: 'ocio_gamut_cusp_table_0' },
                { samplerName: 'ocio_reach_m_table_0' }
            ];

            const result = processRgcWgsl(simulatedOcioWgsl, textures, []);

            // Verify array declarations are preserved and renamed
            assert.strictEqual(result.hadArrayBefore, true, 'Should find hues_array in input');
            assert.strictEqual(result.hasRenamedArray, true, 'hues_array should be renamed to rgc_ocio_');

            // Verify OCIODisplay is renamed
            assert.strictEqual(result.hasApplyRgcFunction, true, 'Should have applyACES2RGC function');
            assert.strictEqual(result.functions.includes('fn OCIODisplay'), false, 'Should not have original OCIODisplay');

            // Verify helper functions are renamed
            assert.strictEqual(result.functions.includes('fn rgc_ocio_gamut_cusp_table_0_sample'), true, 'Should rename sample function');
            assert.strictEqual(result.functions.includes('fn rgc_ocio_reach_m_table_0_sample'), true, 'Should rename reach function');
            assert.strictEqual(result.functions.includes('fn rgc_ocio_get_focus_gain'), true, 'Should rename focus gain function');

            // Verify texture references are prefixed
            // Note: Since textures are named ocio_xxx, after ocio_ rename they become rgc_ocio_xxx
            // So the texture reference replacement (rgc_${samplerName}_tex) results in rgc_ocio_xxx_tex
            // Then the ocio_ rename makes it rgc_rgc_ocio_xxx_tex? No - the \b prevents that.
            // Let's check: input has "ocio_gamut_cusp_table_0_tex",
            //   replace with "rgc_ocio_gamut_cusp_table_0_tex"
            //   then ocio_ rename pattern \bocio_(\w+) doesn't match because rgc_ precedes ocio_
            assert.strictEqual(result.functions.includes('rgc_ocio_gamut_cusp_table_0_tex'), true, 'Should prefix texture');
            assert.strictEqual(result.functions.includes('rgc_ocio_gamut_cusp_table_0_samp'), true, 'Should prefix sampler');

            // Verify binding declarations are removed
            assert.strictEqual(result.functions.includes('@group'), false, 'Should remove all @group');
            assert.strictEqual(result.functions.includes('@binding'), false, 'Should remove all @binding');

            // Verify fragment shader is removed
            assert.strictEqual(result.functions.includes('@fragment'), false, 'Should remove @fragment');
            assert.strictEqual(result.functions.includes('fn main(in: VertexOutput)'), false, 'Should remove main function');

            // Verify struct declarations are removed
            assert.strictEqual(result.functions.includes('struct VertexOutput'), false, 'Should remove VertexOutput struct');

            // Verify fragment I/O vars are removed
            assert.strictEqual(result.functions.includes('v_texCoord_1'), false, 'Should remove v_texCoord');
        });
    });
});
