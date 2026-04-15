/**
 * L5.a (GLSL variant) — tests for the WebGL2 pre-transform fragment/vertex
 * shader generator. The WebGPU path applies the plugin-supplied 3×3 matrix
 * through a compute pass; in WebGL2 there are no compute shaders, so the
 * same effect is achieved via a full-screen-quad fragment shader rendered
 * into an FBO-attached RGBA32F texture.
 *
 * The shader source is static — the generator returns a constant string
 * that the host pipeline relies on for:
 *   - the uniform name it binds the matrix to (`u_preMatrix`)
 *   - the sampler name (`u_inputTex`)
 *   - the attribute name (`a_position`)
 *   - `#version 300 es` + `precision highp float;` headers (WebGL2 ESSL 3.0)
 *
 * These tests pin down that contract so a refactor cannot silently break
 * the runner's uniform/attribute lookups.
 */

import { strict as assert } from 'assert';
import {
    buildPreTransformVertexGLSL,
    buildPreTransformFragmentGLSL,
    PRE_TRANSFORM_GLSL_ATTRIB_POSITION,
    PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX,
    PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
} from '../../webview/shared/pre-transform-shader-glsl';

describe('buildPreTransformVertexGLSL — structure', () => {
    it('targets WebGL2 ESSL 3.0 (`#version 300 es`)', () => {
        const vs = buildPreTransformVertexGLSL();
        assert.match(vs, /^#version 300 es\b/);
    });

    it('declares an `in vec2` position attribute bound to the exported constant', () => {
        const vs = buildPreTransformVertexGLSL();
        // The constant tells the host which attribute to bind; the shader
        // source must actually use that name.
        const name = PRE_TRANSFORM_GLSL_ATTRIB_POSITION;
        const pattern = new RegExp(`in\\s+vec2\\s+${name}\\b`);
        assert.match(vs, pattern, `expected attribute '${name}' in vertex shader`);
    });

    it('passes a `vec2 v_uv` varying to the fragment stage', () => {
        const vs = buildPreTransformVertexGLSL();
        // ESSL 3.0 uses `out` in vertex and `in` in fragment for varyings.
        assert.match(vs, /out\s+vec2\s+v_uv\b/);
        assert.match(vs, /v_uv\s*=/);
    });

    it('writes to gl_Position using the attribute', () => {
        const vs = buildPreTransformVertexGLSL();
        assert.match(vs, /gl_Position\s*=/);
    });
});

describe('buildPreTransformFragmentGLSL — structure', () => {
    it('targets WebGL2 ESSL 3.0 with highp float precision', () => {
        const fs = buildPreTransformFragmentGLSL();
        assert.match(fs, /^#version 300 es\b/);
        assert.match(fs, /precision\s+highp\s+float\b/);
    });

    it('declares a `sampler2D` input texture under the exported uniform name', () => {
        const fs = buildPreTransformFragmentGLSL();
        const name = PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX;
        const pattern = new RegExp(`uniform\\s+sampler2D\\s+${name}\\b`);
        assert.match(fs, pattern, `expected uniform '${name}' in fragment shader`);
    });

    it('declares a `mat3` pre-transform uniform under the exported name', () => {
        const fs = buildPreTransformFragmentGLSL();
        const name = PRE_TRANSFORM_GLSL_UNIFORM_MATRIX;
        const pattern = new RegExp(`uniform\\s+mat3\\s+${name}\\b`);
        assert.match(fs, pattern, `expected uniform '${name}' in fragment shader`);
    });

    it('receives the `v_uv` varying from the vertex stage', () => {
        const fs = buildPreTransformFragmentGLSL();
        assert.match(fs, /in\s+vec2\s+v_uv\b/);
    });

    it('applies the matrix to RGB (preMatrix * pixel.rgb)', () => {
        const fs = buildPreTransformFragmentGLSL();
        const uname = PRE_TRANSFORM_GLSL_UNIFORM_MATRIX;
        // Tolerates any RGB expression on the right-hand side, including
        // `pixel.rgb`, `p.rgb`, or `texture(...).rgb`.
        const pattern = new RegExp(`${uname}\\s*\\*\\s*[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)?\\.rgb`);
        assert.match(fs, pattern, `expected a '${uname} * <expr>.rgb' expression`);
    });

    it('preserves alpha in the output (the .a swizzle appears inside a vec4 constructor)', () => {
        const fs = buildPreTransformFragmentGLSL();
        // Tolerates both `vec4(rgb, pixel.a)` (vec3 + float) and the fully
        // expanded `vec4(r, g, b, pixel.a)` forms — the invariant is that
        // a `.a` component of some identifier is the last argument.
        assert.match(fs, /vec4\s*\([^)]*\.a\s*\)/);
    });

    it('writes to an out variable named `outColor`', () => {
        // ESSL 3.0 requires `out vec4` for fragment output (no gl_FragColor).
        const fs = buildPreTransformFragmentGLSL();
        assert.match(fs, /out\s+vec4\s+outColor\b/);
        assert.match(fs, /outColor\s*=/);
    });

    it('samples the input texture with texture(...) (ESSL 3.0 style, not texture2D)', () => {
        const fs = buildPreTransformFragmentGLSL();
        assert.match(fs, /\btexture\s*\(/);
        assert.doesNotMatch(fs, /\btexture2D\s*\(/);
    });
});

describe('buildPreTransform{Vertex,Fragment}GLSL — constants', () => {
    it('exported uniform / attribute constants are non-empty strings', () => {
        assert.equal(typeof PRE_TRANSFORM_GLSL_ATTRIB_POSITION, 'string');
        assert.ok(PRE_TRANSFORM_GLSL_ATTRIB_POSITION.length > 0);
        assert.equal(typeof PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX, 'string');
        assert.ok(PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX.length > 0);
        assert.equal(typeof PRE_TRANSFORM_GLSL_UNIFORM_MATRIX, 'string');
        assert.ok(PRE_TRANSFORM_GLSL_UNIFORM_MATRIX.length > 0);
    });

    it('vertex and fragment sources share a non-trivial byte length (not empty strings)', () => {
        const vs = buildPreTransformVertexGLSL();
        const fs = buildPreTransformFragmentGLSL();
        assert.ok(vs.length > 100, `vertex shader is suspiciously short: ${vs.length} chars`);
        assert.ok(fs.length > 150, `fragment shader is suspiciously short: ${fs.length} chars`);
    });
});
