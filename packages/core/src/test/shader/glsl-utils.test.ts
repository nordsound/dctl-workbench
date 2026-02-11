/**
 * GLSL Utilities Unit Tests
 */

import { strict as assert } from 'assert';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
    buildVulkanGlslPreamble,
    buildOcioMainFunction,
} from '../../shader/glsl-utils';

describe('fixGlslForNaga', () => {
    it('should remove C-style float suffixes', () => {
        const input = 'float x = 1.0f; float y = 2.5f;';
        const result = fixGlslForNaga(input);
        assert.ok(!result.includes('1.0f'));
        assert.ok(!result.includes('2.5f'));
        assert.ok(result.includes('1.0'));
        assert.ok(result.includes('2.5'));
    });

    it('should remove const from array declarations', () => {
        const input = 'const float arr[10] = float[10](1.0);';
        const result = fixGlslForNaga(input);
        assert.ok(!result.includes('const float arr'));
        assert.ok(result.includes('float arr[10]'));
    });

    it('should fix integer literals in float context with _base suffix', () => {
        const input = 'x_base + 1;';
        const result = fixGlslForNaga(input);
        assert.ok(result.includes('x_base + 1.0;'));
    });

    it('should fix integer literals in float context with _lo suffix', () => {
        const input = 'y_lo - 2;';
        const result = fixGlslForNaga(input);
        assert.ok(result.includes('y_lo - 2.0;'));
    });

    it('should fix texture coordinate calculations without decimal', () => {
        const input = '(idx + 0.5) / 32';
        const result = fixGlslForNaga(input);
        assert.ok(result.includes('(float(idx) + 0.5) / 32.0'));
    });

    it('should handle complex texture coordinate expressions', () => {
        const input = '(coord - 1 + 0.5) / 64';
        const result = fixGlslForNaga(input);
        assert.ok(result.includes('(float(coord) - 1.0 + 0.5) / 64.0'));
    });

    it('should not modify already correct code', () => {
        const input = 'float x = 1.0;';
        const result = fixGlslForNaga(input);
        assert.equal(result, 'float x = 1.0;');
    });
});

describe('processSamplerDeclarations', () => {
    it('should convert sampler2D declarations to separated texture/sampler', () => {
        const input = 'uniform sampler2D myTex;';
        const result = processSamplerDeclarations(input, 0);

        assert.equal(result.declarations.length, 1);
        assert.equal(result.declarations[0].name, 'myTex');
        assert.equal(result.declarations[0].type, 'sampler2D');
        assert.ok(result.code.includes('texture2D myTex_tex'));
        assert.ok(result.code.includes('uniform sampler myTex_samp'));
    });

    it('should convert sampler3D declarations', () => {
        const input = 'uniform sampler3D lutTex;';
        const result = processSamplerDeclarations(input, 0);

        assert.equal(result.declarations.length, 1);
        assert.equal(result.declarations[0].type, 'sampler3D');
        assert.ok(result.code.includes('texture3D lutTex_tex'));
    });

    it('should generate correct bindings', () => {
        const input = 'uniform sampler2D tex1;';
        const result = processSamplerDeclarations(input, 2);

        assert.equal(result.bindings.length, 2);
        assert.equal(result.bindings[0].binding, 2);
        assert.equal(result.bindings[0].type, 'texture2D');
        assert.equal(result.bindings[1].binding, 3);
        assert.equal(result.bindings[1].type, 'sampler');
        assert.equal(result.nextBindingIndex, 4);
    });

    it('should handle multiple declarations', () => {
        const input = `
uniform sampler2D tex1;
uniform sampler3D lut;
uniform sampler2D tex2;
`;
        const result = processSamplerDeclarations(input, 0);

        assert.equal(result.declarations.length, 3);
        assert.equal(result.bindings.length, 6);
        assert.equal(result.nextBindingIndex, 6);
    });

    it('should skip duplicate declarations by default', () => {
        const input = `
uniform sampler2D myTex;
uniform sampler2D myTex;
`;
        const result = processSamplerDeclarations(input, 0);

        assert.equal(result.declarations.length, 1);
    });

    it('should remove duplicate declarations when strategy is remove', () => {
        const input = `
uniform sampler2D myTex;
uniform sampler2D myTex;
`;
        const result = processSamplerDeclarations(input, 0, { duplicateStrategy: 'remove' });

        // First one is converted, second one is removed (empty string)
        assert.equal(result.declarations.length, 1);
        const secondMatch = result.code.match(/uniform sampler2D myTex/g);
        assert.equal(secondMatch, null);
    });

    it('should add prefix to generated variable names', () => {
        const input = 'uniform sampler2D tex;';
        const result = processSamplerDeclarations(input, 0, { prefix: 'ocio_' });

        assert.equal(result.declarations[0].texName, 'ocio_tex_tex');
        assert.equal(result.declarations[0].samplerName, 'ocio_tex_samp');
    });
});

describe('replaceSamplerTextureCalls', () => {
    it('should replace texture() calls with separated sampler constructor', () => {
        const code = 'vec4 c = texture(myTex, coord);';
        const declarations = [{
            name: 'myTex',
            type: 'sampler2D' as const,
            texName: 'myTex_tex',
            samplerName: 'myTex_samp',
        }];

        const result = replaceSamplerTextureCalls(code, declarations);
        assert.ok(result.includes('texture(sampler2D(myTex_tex, myTex_samp),'));
    });

    it('should handle sampler3D', () => {
        const code = 'vec4 c = texture(lutTex, uvw);';
        const declarations = [{
            name: 'lutTex',
            type: 'sampler3D' as const,
            texName: 'lutTex_tex',
            samplerName: 'lutTex_samp',
        }];

        const result = replaceSamplerTextureCalls(code, declarations);
        assert.ok(result.includes('texture(sampler3D(lutTex_tex, lutTex_samp),'));
    });

    it('should handle multiple declarations', () => {
        const code = 'vec4 a = texture(tex1, c1); vec4 b = texture(tex2, c2);';
        const declarations = [
            { name: 'tex1', type: 'sampler2D' as const, texName: 'tex1_tex', samplerName: 'tex1_samp' },
            { name: 'tex2', type: 'sampler2D' as const, texName: 'tex2_tex', samplerName: 'tex2_samp' },
        ];

        const result = replaceSamplerTextureCalls(code, declarations);
        assert.ok(result.includes('sampler2D(tex1_tex, tex1_samp)'));
        assert.ok(result.includes('sampler2D(tex2_tex, tex2_samp)'));
    });
});

describe('findOcioMainFunction', () => {
    it('should find OCIODisplay function', () => {
        const code = 'vec4 OCIODisplay(vec4 inPixel) { return inPixel; }';
        const result = findOcioMainFunction(code);
        assert.equal(result, 'OCIODisplay');
    });

    it('should find ocio_main function', () => {
        const code = 'vec4 ocio_main(vec4 color) { return color; }';
        const result = findOcioMainFunction(code);
        assert.equal(result, 'ocio_main');
    });

    it('should find OCIOMain function', () => {
        const code = 'vec4 OCIOMain(vec4 pixel) { return pixel; }';
        const result = findOcioMainFunction(code);
        assert.equal(result, 'OCIOMain');
    });

    it('should return OCIOMain as default if not found', () => {
        const code = 'void someFunction() {}';
        const result = findOcioMainFunction(code);
        assert.equal(result, 'OCIOMain');
    });
});

describe('buildVulkanGlslPreamble', () => {
    it('should include version 450 declaration', () => {
        const result = buildVulkanGlslPreamble();
        assert.ok(result.includes('#version 450'));
    });

    it('should include vertex input when enabled', () => {
        const result = buildVulkanGlslPreamble({ hasVertexInput: true });
        assert.ok(result.includes('layout(location = 0) in vec2 v_texCoord'));
    });

    it('should not include vertex input when disabled', () => {
        const result = buildVulkanGlslPreamble({ hasVertexInput: false, hasFragmentOutput: false, hasImageTexture: false });
        assert.ok(!result.includes('v_texCoord'));
    });

    it('should include fragment output when enabled', () => {
        const result = buildVulkanGlslPreamble({ hasFragmentOutput: true });
        assert.ok(result.includes('layout(location = 0) out vec4 fragColor'));
    });

    it('should include image texture bindings when enabled', () => {
        const result = buildVulkanGlslPreamble({ hasImageTexture: true });
        assert.ok(result.includes('uniform texture2D u_image_tex'));
        assert.ok(result.includes('uniform sampler u_image_samp'));
    });

    it('should use custom binding indices', () => {
        const result = buildVulkanGlslPreamble({
            hasImageTexture: true,
            imageTextureBinding: 5,
            imageSamplerBinding: 6,
        });
        assert.ok(result.includes('binding = 5'));
        assert.ok(result.includes('binding = 6'));
    });

    it('should not include image texture when disabled', () => {
        const result = buildVulkanGlslPreamble({ hasImageTexture: false, hasVertexInput: false, hasFragmentOutput: false });
        assert.ok(!result.includes('u_image_tex'));
    });
});

describe('buildOcioMainFunction', () => {
    it('should create main function calling specified OCIO function', () => {
        const result = buildOcioMainFunction('OCIODisplay');
        assert.ok(result.includes('void main()'));
        assert.ok(result.includes('OCIODisplay(color)'));
    });

    it('should sample texture using combined sampler', () => {
        const result = buildOcioMainFunction('myFunc');
        assert.ok(result.includes('texture(sampler2D(u_image_tex, u_image_samp), v_texCoord)'));
    });

    it('should clamp result with max(result, vec4(0.0))', () => {
        const result = buildOcioMainFunction('OCIOMain');
        assert.ok(result.includes('fragColor = max(result, vec4(0.0))'));
    });
});
