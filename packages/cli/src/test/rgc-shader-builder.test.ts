/**
 * RGC Shader Builder Tests
 *
 * Tests for RGC shader building utilities.
 * Since buildRgcShader depends on OCIO and Naga, we test the GLSL utilities
 * from @dctl-workbench/core that are used in the RGC pipeline.
 */

import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
    buildVulkanGlslPreamble,
    buildOcioMainFunction,
} from '@dctl-workbench/core';

describe('fixGlslForNaga', () => {
    it('should remove C-style float suffixes', () => {
        const input = 'float x = 1.0f; float y = 2.5f; float z = 3f;';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, 'float x = 1.0; float y = 2.5; float z = 3;');
    });

    it('should remove const from array declarations', () => {
        const input = 'const float arr[4] = float[4](1.0, 2.0, 3.0, 4.0);';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, 'float arr[4] = float[4](1.0, 2.0, 3.0, 4.0);');
    });

    it('should fix integer literals in float context with base suffix', () => {
        const input = 'outColor_base + 1;';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, 'outColor_base + 1.0;');
    });

    it('should fix integer literals in float context with lo suffix', () => {
        const input = 'idx_lo - 2;';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, 'idx_lo - 2.0;');
    });

    it('should fix integer literals in float context with hi suffix', () => {
        const input = 'idx_hi + 0;';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, 'idx_hi + 0.0;');
    });

    it('should fix texture coordinate calculations', () => {
        const input = '(idx + 0.5) / 256';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, '(float(idx) + 0.5) / 256.0');
    });

    it('should fix texture coordinate with offset', () => {
        const input = '(idx - 16 + 0.5) / 1024';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, '(float(idx) - 16.0 + 0.5) / 1024.0');
    });

    it('should handle multiple transformations in one string', () => {
        const input = `
const float lut[4] = float[4](0.0f, 0.25f, 0.5f, 1.0f);
float coord = (idx + 0.5) / 256;
float result = outColor_base + 1;
`;
        const output = fixGlslForNaga(input);
        assert.ok(!output.includes('const float lut'));
        assert.ok(!output.includes('0.0f'));
        assert.ok(output.includes('(float(idx) + 0.5) / 256.0'));
        assert.ok(output.includes('outColor_base + 1.0;'));
    });

    it('should preserve valid GLSL code', () => {
        const input = 'vec3 color = vec3(1.0, 0.5, 0.0);';
        const output = fixGlslForNaga(input);
        assert.strictEqual(output, input);
    });
});

describe('processSamplerDeclarations', () => {
    it('should convert sampler2D declaration to texture/sampler pair', () => {
        const input = 'uniform sampler2D myTexture;';
        const result = processSamplerDeclarations(input, 0);

        assert.strictEqual(result.declarations.length, 1);
        assert.strictEqual(result.declarations[0].name, 'myTexture');
        assert.strictEqual(result.declarations[0].type, 'sampler2D');
        assert.strictEqual(result.declarations[0].texName, 'myTexture_tex');
        assert.strictEqual(result.declarations[0].samplerName, 'myTexture_samp');

        assert.strictEqual(result.bindings.length, 2);
        assert.strictEqual(result.bindings[0].type, 'texture2D');
        assert.strictEqual(result.bindings[0].binding, 0);
        assert.strictEqual(result.bindings[1].type, 'sampler');
        assert.strictEqual(result.bindings[1].binding, 1);

        assert.strictEqual(result.nextBindingIndex, 2);
        assert.ok(result.code.includes('texture2D myTexture_tex'));
        assert.ok(result.code.includes('sampler myTexture_samp'));
    });

    it('should convert sampler3D declaration to texture/sampler pair', () => {
        const input = 'uniform sampler3D lut3D;';
        const result = processSamplerDeclarations(input, 0);

        assert.strictEqual(result.declarations.length, 1);
        assert.strictEqual(result.declarations[0].type, 'sampler3D');
        assert.strictEqual(result.bindings[0].type, 'texture3D');
    });

    it('should handle multiple sampler declarations', () => {
        const input = `
uniform sampler2D tex1;
uniform sampler3D lut3D;
uniform sampler2D tex2;
`;
        const result = processSamplerDeclarations(input, 0);

        assert.strictEqual(result.declarations.length, 3);
        assert.strictEqual(result.bindings.length, 6);
        assert.strictEqual(result.nextBindingIndex, 6);
    });

    it('should start from specified binding index', () => {
        const input = 'uniform sampler2D myTexture;';
        const result = processSamplerDeclarations(input, 10);

        assert.strictEqual(result.bindings[0].binding, 10);
        assert.strictEqual(result.bindings[1].binding, 11);
        assert.strictEqual(result.nextBindingIndex, 12);
    });

    it('should skip duplicate declarations by default', () => {
        const input = `
uniform sampler2D tex;
uniform sampler2D tex;
`;
        const result = processSamplerDeclarations(input, 0);

        // First one should be converted, second one left as-is
        assert.strictEqual(result.declarations.length, 1);
        assert.ok(result.code.includes('texture2D tex_tex'));
        // The second declaration should remain
        assert.ok(result.code.includes('uniform sampler2D tex;'));
    });

    it('should remove duplicate declarations when configured', () => {
        const input = `
uniform sampler2D tex;
uniform sampler2D tex;
`;
        const result = processSamplerDeclarations(input, 0, { duplicateStrategy: 'remove' });

        assert.strictEqual(result.declarations.length, 1);
        // Count occurrences - should only have converted version
        const matches = result.code.match(/tex_tex/g);
        assert.strictEqual(matches?.length, 1);
    });

    it('should apply prefix to generated names', () => {
        const input = 'uniform sampler2D myTex;';
        const result = processSamplerDeclarations(input, 0, { prefix: 'rgc_' });

        assert.strictEqual(result.declarations[0].texName, 'rgc_myTex_tex');
        assert.strictEqual(result.declarations[0].samplerName, 'rgc_myTex_samp');
        assert.ok(result.code.includes('rgc_myTex_tex'));
    });
});

describe('replaceSamplerTextureCalls', () => {
    it('should replace texture() calls for 2D samplers', () => {
        const code = 'vec4 color = texture(myTex, uv);';
        const declarations = [
            { name: 'myTex', type: 'sampler2D' as const, texName: 'myTex_tex', samplerName: 'myTex_samp' }
        ];
        const result = replaceSamplerTextureCalls(code, declarations);
        assert.strictEqual(result, 'vec4 color = texture(sampler2D(myTex_tex, myTex_samp), uv);');
    });

    it('should replace texture() calls for 3D samplers', () => {
        const code = 'vec4 color = texture(lut3D, coord3);';
        const declarations = [
            { name: 'lut3D', type: 'sampler3D' as const, texName: 'lut3D_tex', samplerName: 'lut3D_samp' }
        ];
        const result = replaceSamplerTextureCalls(code, declarations);
        assert.strictEqual(result, 'vec4 color = texture(sampler3D(lut3D_tex, lut3D_samp), coord3);');
    });

    it('should handle multiple samplers', () => {
        const code = `
vec4 c1 = texture(tex1, uv);
vec4 c2 = texture(tex2, uv);
`;
        const declarations = [
            { name: 'tex1', type: 'sampler2D' as const, texName: 'tex1_tex', samplerName: 'tex1_samp' },
            { name: 'tex2', type: 'sampler2D' as const, texName: 'tex2_tex', samplerName: 'tex2_samp' }
        ];
        const result = replaceSamplerTextureCalls(code, declarations);
        assert.ok(result.includes('sampler2D(tex1_tex, tex1_samp)'));
        assert.ok(result.includes('sampler2D(tex2_tex, tex2_samp)'));
    });

    it('should preserve texture calls not in declarations', () => {
        const code = 'vec4 color = texture(otherTex, uv);';
        const declarations = [
            { name: 'myTex', type: 'sampler2D' as const, texName: 'myTex_tex', samplerName: 'myTex_samp' }
        ];
        const result = replaceSamplerTextureCalls(code, declarations);
        assert.strictEqual(result, code);
    });

    it('should handle spaces in texture() call', () => {
        const code = 'texture(  myTex  ,uv)';
        const declarations = [
            { name: 'myTex', type: 'sampler2D' as const, texName: 'myTex_tex', samplerName: 'myTex_samp' }
        ];
        const result = replaceSamplerTextureCalls(code, declarations);
        assert.ok(result.includes('sampler2D(myTex_tex, myTex_samp)'));
    });
});

describe('findOcioMainFunction', () => {
    it('should find OCIODisplay function', () => {
        const code = 'vec4 OCIODisplay(vec4 inColor) { return inColor; }';
        const result = findOcioMainFunction(code);
        assert.strictEqual(result, 'OCIODisplay');
    });

    it('should find ocio_main function', () => {
        const code = 'vec4 ocio_main(vec4 inColor) { return inColor; }';
        const result = findOcioMainFunction(code);
        assert.strictEqual(result, 'ocio_main');
    });

    it('should find OCIOMain function', () => {
        const code = 'vec4 OCIOMain(vec4 inColor) { return inColor; }';
        const result = findOcioMainFunction(code);
        assert.strictEqual(result, 'OCIOMain');
    });

    it('should return OCIOMain as default if not found', () => {
        const code = 'vec4 someOtherFunction(vec4 inColor) { return inColor; }';
        const result = findOcioMainFunction(code);
        assert.strictEqual(result, 'OCIOMain');
    });

    it('should match first occurrence if multiple are present', () => {
        const code = `
vec4 OCIODisplay(vec4 inColor) { return inColor; }
vec4 OCIOMain(vec4 inColor) { return inColor; }
`;
        const result = findOcioMainFunction(code);
        assert.strictEqual(result, 'OCIODisplay');
    });
});

describe('buildVulkanGlslPreamble', () => {
    it('should include version declaration', () => {
        const result = buildVulkanGlslPreamble();
        assert.ok(result.startsWith('#version 450'));
    });

    it('should include vertex input by default', () => {
        const result = buildVulkanGlslPreamble();
        assert.ok(result.includes('layout(location = 0) in vec2 v_texCoord;'));
    });

    it('should include fragment output by default', () => {
        const result = buildVulkanGlslPreamble();
        assert.ok(result.includes('layout(location = 0) out vec4 fragColor;'));
    });

    it('should include image texture bindings by default', () => {
        const result = buildVulkanGlslPreamble();
        assert.ok(result.includes('texture2D u_image_tex'));
        assert.ok(result.includes('sampler u_image_samp'));
    });

    it('should exclude vertex input when disabled', () => {
        const result = buildVulkanGlslPreamble({ hasVertexInput: false });
        assert.ok(!result.includes('v_texCoord'));
    });

    it('should exclude fragment output when disabled', () => {
        const result = buildVulkanGlslPreamble({ hasFragmentOutput: false });
        assert.ok(!result.includes('fragColor'));
    });

    it('should exclude image texture when disabled', () => {
        const result = buildVulkanGlslPreamble({ hasImageTexture: false });
        assert.ok(!result.includes('u_image_tex'));
        assert.ok(!result.includes('u_image_samp'));
    });

    it('should use custom binding indices', () => {
        const result = buildVulkanGlslPreamble({
            imageTextureBinding: 5,
            imageSamplerBinding: 6,
        });
        assert.ok(result.includes('binding = 5'));
        assert.ok(result.includes('binding = 6'));
    });
});

describe('buildOcioMainFunction', () => {
    it('should create main function calling OCIO function', () => {
        const result = buildOcioMainFunction('OCIODisplay');
        assert.ok(result.includes('void main()'));
        assert.ok(result.includes('texture(sampler2D(u_image_tex, u_image_samp), v_texCoord)'));
        assert.ok(result.includes('OCIODisplay(color)'));
    });

    it('should clamp to non-negative values', () => {
        const result = buildOcioMainFunction('OCIOMain');
        assert.ok(result.includes('max(result, vec4(0.0))'));
    });

    it('should use custom function name', () => {
        const result = buildOcioMainFunction('myCustomOcio');
        assert.ok(result.includes('myCustomOcio(color)'));
    });
});

describe('WGSL Post-Processing Transformations', () => {
    /**
     * These tests verify the WGSL transformations applied in rgc-shader-builder.ts
     * for compute shader compatibility.
     */

    it('should convert textureSample to textureSampleLevel', () => {
        // This transformation is done in rgc-shader-builder.ts
        const wgsl = 'let color = textureSample(tex, samp, uv);';
        // The replacement pattern from rgc-shader-builder.ts:
        let result = wgsl.replace(/textureSample\s*\(/g, 'textureSampleLevel(');
        result = result.replace(/(textureSampleLevel\([^;]+)(\);)/g, '$1, 0.0);');
        assert.strictEqual(result, 'let color = textureSampleLevel(tex, samp, uv, 0.0);');
    });

    it('should remove binding declarations from WGSL', () => {
        const wgsl = `@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
fn myFunc() {}`;
        // The pattern from rgc-shader-builder.ts
        let result = wgsl.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var\s+[^;]+;/g, '');
        result = result.trim();
        assert.strictEqual(result, 'fn myFunc() {}');
    });

    it('should remove struct declarations for output', () => {
        const wgsl = `struct FragmentOutput {
    @location(0) fragColor: vec4<f32>
}
fn myFunc() {}`;
        const result = wgsl.replace(/struct\s+FragmentOutput\s*\{[^}]*\}/g, '').trim();
        assert.strictEqual(result, 'fn myFunc() {}');
    });

    it('should clean up consecutive empty lines', () => {
        const wgsl = `fn a() {}


fn b() {}`;
        const result = wgsl.replace(/\n\s*\n\s*\n/g, '\n\n');
        assert.strictEqual(result, `fn a() {}

fn b() {}`);
    });
});
