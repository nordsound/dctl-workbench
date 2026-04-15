/**
 * L6 — unit tests for the WebGL2 pre-transform runner.
 *
 * WebGL2 has no compute shaders, so the pre-transform pass is implemented
 * as a full-screen fragment pass that renders the input texture into an
 * RGBA32F framebuffer attachment, multiplying pixel.rgb by a 3×3 matrix
 * uniform.
 *
 * Headless WebGL2 is hard in Node (gl, headless-gl, etc. don't ship with
 * this project's toolchain), so this file uses a compact mock that
 * records API calls. The goal is to pin down the runner's behavior at
 * the API-sequence level — the WGSL/GLSL shader tests and the matrix
 * encoder tests independently prove the per-pixel math is correct.
 *
 * Coverage:
 *   - FBO + RGBA32F output texture creation (L6.1 analog)
 *   - shader compile + program link on first call, cached after
 *   - VBO + attribute binding for the full-screen quad
 *   - uniformMatrix3fv upload with the expected column-major 9-float data
 *   - viewport matches the output texture size
 *   - source texture left untouched (caller owns deletion)
 *   - default framebuffer restored after the pass
 */

import { strict as assert } from 'assert';
import {
    createWebGL2PreTransformCache,
    runPreTransformWebGL2,
} from '../../webview/shared/pre-transform-runner-webgl2';
import { encodeMat3ForGlslUniform } from '../../webview/shared/matrix-encoding';
import {
    buildPreTransformVertexGLSL,
    buildPreTransformFragmentGLSL,
    PRE_TRANSFORM_GLSL_ATTRIB_POSITION,
    PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX,
    PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
} from '../../webview/shared/pre-transform-shader-glsl';

type Mat3 = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

const IDENTITY: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
];

const SRGB_TO_AP0: Mat3 = [
    [0.4395722998, 0.3839185441, 0.1765091561],
    [0.0895766616, 0.8150065542, 0.0954167842],
    [0.0173096404, 0.1095964685, 0.8730938911],
];

// -----------------------------------------------------------------------
// Compact WebGL2 mock
// -----------------------------------------------------------------------

interface MockResource {
    id: number;
    kind: string;
    [key: string]: any;
}

class MockWebGL2 {
    // WebGL2 constants the runner uses. Real WebGL2 exposes these as
    // numeric enums on the context; the mock assigns arbitrary unique
    // values — what matters is identity between `gl.X` reads.
    readonly VERTEX_SHADER = 0x8B31;
    readonly FRAGMENT_SHADER = 0x8B30;
    readonly COMPILE_STATUS = 0x8B81;
    readonly LINK_STATUS = 0x8B82;

    readonly TEXTURE_2D = 0x0DE1;
    readonly TEXTURE0 = 0x84C0;

    readonly RGBA32F = 0x8814;
    readonly RGBA = 0x1908;
    readonly FLOAT = 0x1406;

    readonly FRAMEBUFFER = 0x8D40;
    readonly COLOR_ATTACHMENT0 = 0x8CE0;
    readonly FRAMEBUFFER_COMPLETE = 0x8CD5;

    readonly ARRAY_BUFFER = 0x8892;
    readonly STATIC_DRAW = 0x88E4;

    readonly TRIANGLE_STRIP = 0x0005;
    readonly TRIANGLES = 0x0004;

    readonly LINEAR = 0x2601;
    readonly NEAREST = 0x2600;
    readonly CLAMP_TO_EDGE = 0x812F;
    readonly TEXTURE_MIN_FILTER = 0x2801;
    readonly TEXTURE_MAG_FILTER = 0x2800;
    readonly TEXTURE_WRAP_S = 0x2802;
    readonly TEXTURE_WRAP_T = 0x2803;

    // Call log
    readonly calls: Array<{ name: string; args: any[] }> = [];

    // Resources
    private nextId = 1;
    readonly textures: MockResource[] = [];
    readonly buffers: MockResource[] = [];
    readonly shaders: MockResource[] = [];
    readonly programs: MockResource[] = [];
    readonly framebuffers: MockResource[] = [];

    // Active bindings (for assertions that care about state)
    activeFramebuffer: MockResource | null = null;
    activeProgram: MockResource | null = null;
    lastViewport: [number, number, number, number] | null = null;

    // Uniform uploads for introspection
    readonly uniformMatrix3fvUploads: Array<{
        location: MockResource;
        transpose: boolean;
        data: Float32Array;
    }> = [];
    readonly uniform1iUploads: Array<{ location: MockResource; value: number }> = [];

    // ---- helpers ---------------------------------------------------------

    private mk(kind: string, extra: Record<string, any> = {}): MockResource {
        const res = { id: this.nextId++, kind, ...extra };
        return res;
    }

    private log(name: string, args: any[]): void {
        this.calls.push({ name, args });
    }

    // ---- shader/program --------------------------------------------------

    createShader(type: number): MockResource {
        const s = this.mk('shader', { type, source: '', compiled: false });
        this.shaders.push(s);
        this.log('createShader', [type]);
        return s;
    }

    shaderSource(shader: MockResource, source: string): void {
        shader.source = source;
        this.log('shaderSource', [shader.id, source]);
    }

    compileShader(shader: MockResource): void {
        shader.compiled = true;
        this.log('compileShader', [shader.id]);
    }

    getShaderParameter(shader: MockResource, pname: number): boolean {
        if (pname === this.COMPILE_STATUS) return !!shader.compiled;
        return false;
    }

    getShaderInfoLog(_shader: MockResource): string {
        return '';
    }

    createProgram(): MockResource {
        const p = this.mk('program', { attached: [] as MockResource[], linked: false });
        this.programs.push(p);
        this.log('createProgram', []);
        return p;
    }

    attachShader(program: MockResource, shader: MockResource): void {
        program.attached.push(shader);
        this.log('attachShader', [program.id, shader.id]);
    }

    linkProgram(program: MockResource): void {
        program.linked = true;
        this.log('linkProgram', [program.id]);
    }

    getProgramParameter(program: MockResource, pname: number): boolean {
        if (pname === this.LINK_STATUS) return !!program.linked;
        return false;
    }

    getProgramInfoLog(_program: MockResource): string {
        return '';
    }

    useProgram(program: MockResource | null): void {
        this.activeProgram = program;
        this.log('useProgram', [program?.id ?? null]);
    }

    getAttribLocation(_program: MockResource, name: string): number {
        // Return 0 for the known position attribute, -1 otherwise.
        if (name === PRE_TRANSFORM_GLSL_ATTRIB_POSITION) return 0;
        return -1;
    }

    getUniformLocation(_program: MockResource, name: string): MockResource {
        return this.mk('uniformLocation', { name });
    }

    // ---- texture ---------------------------------------------------------

    createTexture(): MockResource {
        const t = this.mk('texture', { width: 0, height: 0, internalFormat: 0 });
        this.textures.push(t);
        this.log('createTexture', []);
        return t;
    }

    bindTexture(target: number, texture: MockResource | null): void {
        this.log('bindTexture', [target, texture?.id ?? null]);
    }

    texImage2D(
        target: number,
        level: number,
        internalFormat: number,
        width: number,
        height: number,
        border: number,
        format: number,
        type: number,
        pixels: ArrayBufferView | null,
    ): void {
        // Find the currently bound TEXTURE_2D via the last bindTexture call.
        // For assertions we annotate the most recently created texture if it
        // was just bound.
        const lastBind = [...this.calls].reverse().find((c) => c.name === 'bindTexture');
        if (lastBind && lastBind.args[0] === target) {
            const boundId = lastBind.args[1];
            const tex = this.textures.find((t) => t.id === boundId);
            if (tex) {
                tex.width = width;
                tex.height = height;
                tex.internalFormat = internalFormat;
            }
        }
        this.log('texImage2D', [target, level, internalFormat, width, height, border, format, type, pixels]);
    }

    texParameteri(target: number, pname: number, param: number): void {
        this.log('texParameteri', [target, pname, param]);
    }

    deleteTexture(texture: MockResource | null): void {
        if (texture) texture.deleted = true;
        this.log('deleteTexture', [texture?.id ?? null]);
    }

    activeTexture(unit: number): void {
        this.log('activeTexture', [unit]);
    }

    // ---- framebuffer -----------------------------------------------------

    createFramebuffer(): MockResource {
        const f = this.mk('framebuffer', { attachments: {} as Record<number, MockResource> });
        this.framebuffers.push(f);
        this.log('createFramebuffer', []);
        return f;
    }

    bindFramebuffer(target: number, framebuffer: MockResource | null): void {
        if (target === this.FRAMEBUFFER) this.activeFramebuffer = framebuffer;
        this.log('bindFramebuffer', [target, framebuffer?.id ?? null]);
    }

    framebufferTexture2D(
        _target: number,
        attachment: number,
        _texTarget: number,
        texture: MockResource,
        _level: number,
    ): void {
        if (this.activeFramebuffer) {
            this.activeFramebuffer.attachments[attachment] = texture;
        }
        this.log('framebufferTexture2D', [attachment, texture.id]);
    }

    checkFramebufferStatus(_target: number): number {
        return this.FRAMEBUFFER_COMPLETE;
    }

    deleteFramebuffer(framebuffer: MockResource | null): void {
        if (framebuffer) framebuffer.deleted = true;
        this.log('deleteFramebuffer', [framebuffer?.id ?? null]);
    }

    // ---- buffer ---------------------------------------------------------

    createBuffer(): MockResource {
        const b = this.mk('buffer', { data: null as ArrayBufferView | null });
        this.buffers.push(b);
        this.log('createBuffer', []);
        return b;
    }

    bindBuffer(target: number, buffer: MockResource | null): void {
        this.log('bindBuffer', [target, buffer?.id ?? null]);
    }

    bufferData(target: number, data: ArrayBufferView, usage: number): void {
        const lastBind = [...this.calls].reverse().find((c) => c.name === 'bindBuffer');
        if (lastBind) {
            const boundId = lastBind.args[1];
            const buf = this.buffers.find((b) => b.id === boundId);
            if (buf) buf.data = data;
        }
        this.log('bufferData', [target, data, usage]);
    }

    // ---- vertex attrib --------------------------------------------------

    enableVertexAttribArray(index: number): void {
        this.log('enableVertexAttribArray', [index]);
    }

    vertexAttribPointer(
        index: number,
        size: number,
        type: number,
        normalized: boolean,
        stride: number,
        offset: number,
    ): void {
        this.log('vertexAttribPointer', [index, size, type, normalized, stride, offset]);
    }

    // ---- uniforms --------------------------------------------------------

    uniformMatrix3fv(location: MockResource, transpose: boolean, data: Float32Array): void {
        this.uniformMatrix3fvUploads.push({ location, transpose, data });
        this.log('uniformMatrix3fv', [location.id, transpose, data]);
    }

    uniform1i(location: MockResource, value: number): void {
        this.uniform1iUploads.push({ location, value });
        this.log('uniform1i', [location.id, value]);
    }

    // ---- draw ------------------------------------------------------------

    viewport(x: number, y: number, w: number, h: number): void {
        this.lastViewport = [x, y, w, h];
        this.log('viewport', [x, y, w, h]);
    }

    drawArrays(mode: number, first: number, count: number): void {
        this.log('drawArrays', [mode, first, count]);
    }
}

// -----------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------

function makeContextAndSource(w = 32, h = 16): {
    gl: MockWebGL2;
    source: MockResource;
} {
    const gl = new MockWebGL2();
    // Pretend the caller created the source texture separately (as
    // `createImageTexture()` does in exr-viewer.ts). We track it via the
    // mock so we can later assert the runner didn't delete it.
    gl.bindTexture(gl.TEXTURE_2D, null); // noise
    const source = gl.createTexture();
    return { gl, source };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('runPreTransformWebGL2 — first call (no cache)', () => {
    it('compiles vertex and fragment shaders with the builder sources', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            32, 16,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        // Exactly two shaders should exist (one of each kind).
        assert.equal(gl.shaders.length, 2, 'expected 2 shader objects');
        const vs = gl.shaders.find((s) => s.type === gl.VERTEX_SHADER);
        const fs = gl.shaders.find((s) => s.type === gl.FRAGMENT_SHADER);
        assert.ok(vs, 'expected a vertex shader');
        assert.ok(fs, 'expected a fragment shader');
        assert.equal(vs!.source, buildPreTransformVertexGLSL());
        assert.equal(fs!.source, buildPreTransformFragmentGLSL());
        assert.ok(vs!.compiled, 'vertex shader must be compiled');
        assert.ok(fs!.compiled, 'fragment shader must be compiled');
    });

    it('links a program with both shaders attached', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            32, 16,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        assert.equal(gl.programs.length, 1);
        const program = gl.programs[0];
        assert.ok(program.linked, 'program must be linked');
        assert.equal(program.attached.length, 2, 'both shaders must be attached');
        assert.equal(gl.activeProgram, program, 'program must be made current');
    });

    it('creates an RGBA32F output texture with the passed dimensions', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            17, 11, // deliberately non-power-of-2
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        // The runner creates exactly one new texture (the output). The
        // source texture was made before runPreTransformWebGL2 ran and
        // must not be reused as the output.
        const newTex = gl.textures.find(
            (t) => t !== source && t.internalFormat === gl.RGBA32F,
        );
        assert.ok(newTex, 'expected an RGBA32F output texture');
        assert.equal(newTex!.width, 17);
        assert.equal(newTex!.height, 11);
    });

    it('creates a framebuffer and attaches the output texture to COLOR_ATTACHMENT0', () => {
        const { gl, source } = makeContextAndSource();
        const out = runPreTransformWebGL2(
            gl as any,
            source as any,
            32, 16,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        assert.ok(gl.framebuffers.length >= 1, 'expected a framebuffer');
        const fb = gl.framebuffers[0];
        assert.equal(
            fb.attachments[gl.COLOR_ATTACHMENT0],
            out,
            'COLOR_ATTACHMENT0 must point to the returned texture',
        );
    });

    it('sets viewport to (0, 0, width, height)', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            64, 48,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );
        assert.deepEqual(gl.lastViewport, [0, 0, 64, 48]);
    });

    it('uploads the matrix to u_preMatrix in GLSL column-major order (transpose=false)', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            SRGB_TO_AP0,
            createWebGL2PreTransformCache(),
        );

        const upload = gl.uniformMatrix3fvUploads.find(
            (u) => u.location.name === PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
        );
        assert.ok(upload, `expected an upload to ${PRE_TRANSFORM_GLSL_UNIFORM_MATRIX}`);
        assert.equal(upload!.transpose, false, 'data is column-major; transpose must be false');
        const expected = encodeMat3ForGlslUniform(SRGB_TO_AP0);
        assert.equal(upload!.data.length, 9);
        for (let i = 0; i < 9; i++) {
            assert.ok(
                Math.abs(upload!.data[i] - expected[i]) < 1e-12,
                `data[${i}] = ${upload!.data[i]}; expected ${expected[i]}`,
            );
        }
    });

    it('binds the source texture to texture unit 0 and sets u_inputTex = 0', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        // A bindTexture(TEXTURE_2D, source) call must occur after activeTexture(TEXTURE0).
        const idxActive0 = gl.calls.findIndex(
            (c) => c.name === 'activeTexture' && c.args[0] === gl.TEXTURE0,
        );
        assert.ok(idxActive0 >= 0, 'expected activeTexture(TEXTURE0)');
        const idxBindSource = gl.calls.findIndex(
            (c, i) => i > idxActive0
                && c.name === 'bindTexture'
                && c.args[0] === gl.TEXTURE_2D
                && c.args[1] === source.id,
        );
        assert.ok(idxBindSource > idxActive0, 'source must be bound to TEXTURE0 after activeTexture');

        const upload = gl.uniform1iUploads.find(
            (u) => u.location.name === PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX,
        );
        assert.ok(upload, `expected uniform1i(${PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX}, 0)`);
        assert.equal(upload!.value, 0);
    });

    it('issues a single drawArrays call for a full-screen quad', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        const draws = gl.calls.filter((c) => c.name === 'drawArrays');
        assert.equal(draws.length, 1, 'expected exactly one drawArrays');
        const [mode, first, count] = draws[0].args;
        assert.ok(
            mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLES,
            'mode must be TRIANGLE_STRIP or TRIANGLES',
        );
        assert.equal(first, 0);
        // 4 (strip) or 6 (triangles) — both cover the full viewport.
        assert.ok(count === 4 || count === 6, `unexpected vertex count ${count}`);
    });

    it('restores the default framebuffer after the pass', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );
        assert.equal(gl.activeFramebuffer, null, 'default framebuffer must be restored');
    });

    it('does not delete the source texture (caller owns that)', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );
        assert.notEqual((source as any).deleted, true, 'source must not be deleted');
    });

    it('creates a VBO containing a full-screen-quad vertex set (4 or 6 vertices × 2 components)', () => {
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            IDENTITY,
            createWebGL2PreTransformCache(),
        );

        assert.ok(gl.buffers.length >= 1, 'expected a VBO');
        const vbo = gl.buffers[0];
        const data = vbo.data as Float32Array | null;
        assert.ok(data instanceof Float32Array, 'VBO data must be a Float32Array');
        // 4 vertices × 2 components = 8, or 6 × 2 = 12.
        assert.ok(
            data!.length === 8 || data!.length === 12,
            `VBO length ${data!.length} unexpected`,
        );
        // All coordinates should be ±1 (clip space); no value outside that range.
        for (const v of data!) {
            assert.ok(Math.abs(Math.abs(v) - 1) < 1e-9, `unexpected clip-space coord ${v}`);
        }
    });
});

describe('runPreTransformWebGL2 — cache reuse on subsequent calls', () => {
    it('compiles shaders only once across calls', () => {
        const { gl, source } = makeContextAndSource();
        const cache = createWebGL2PreTransformCache();

        runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);
        runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);
        runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);

        assert.equal(gl.shaders.length, 2, 'shaders should be compiled once, not per call');
        assert.equal(gl.programs.length, 1, 'program should be linked once');
    });

    it('creates the VBO only once across calls', () => {
        const { gl, source } = makeContextAndSource();
        const cache = createWebGL2PreTransformCache();

        runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);
        runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);

        assert.equal(gl.buffers.length, 1, 'VBO must be cached');
    });

    it('creates a fresh output texture on each call', () => {
        const { gl, source } = makeContextAndSource();
        const cache = createWebGL2PreTransformCache();

        const outA = runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);
        const outB = runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);

        assert.notEqual(outA, outB, 'each call must allocate a new output texture');
        const newTextures = gl.textures.filter(
            (t) => t.internalFormat === gl.RGBA32F,
        );
        assert.equal(newTextures.length, 2);
    });

    it('uploads the matrix on every call (cache does not memoize the matrix)', () => {
        const { gl, source } = makeContextAndSource();
        const cache = createWebGL2PreTransformCache();

        runPreTransformWebGL2(gl as any, source as any, 8, 8, IDENTITY, cache);
        runPreTransformWebGL2(gl as any, source as any, 8, 8, SRGB_TO_AP0, cache);

        const matrixUploads = gl.uniformMatrix3fvUploads.filter(
            (u) => u.location.name === PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
        );
        assert.equal(matrixUploads.length, 2);

        const identityExpected = encodeMat3ForGlslUniform(IDENTITY);
        const srgbExpected = encodeMat3ForGlslUniform(SRGB_TO_AP0);
        for (let i = 0; i < 9; i++) {
            assert.ok(Math.abs(matrixUploads[0].data[i] - identityExpected[i]) < 1e-12);
            assert.ok(Math.abs(matrixUploads[1].data[i] - srgbExpected[i]) < 1e-12);
        }
    });
});

describe('runPreTransformWebGL2 — L6 regression (missing runner inputs)', () => {
    it('matrix encoding matches the WGSL path (produces the same per-pixel transform)', () => {
        // Cross-checks that the GLSL encoder and WGSL encoder would
        // hand the fragment/compute shader identical column data.
        const { gl, source } = makeContextAndSource();
        runPreTransformWebGL2(
            gl as any,
            source as any,
            8, 8,
            SRGB_TO_AP0,
            createWebGL2PreTransformCache(),
        );
        const upload = gl.uniformMatrix3fvUploads.find(
            (u) => u.location.name === PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
        );
        assert.ok(upload);

        // Column 0, rows (0..2) from the row-major SRGB_TO_AP0 — identical
        // to what encodeMat3ForWgslUniform would place at indices 0..2.
        // Float32 rounding: assert within f32 resolution, not bit-for-bit.
        const approx = (a: number, b: number) => assert.ok(
            Math.abs(a - b) < 1e-6,
            `expected ${a} ≈ ${b}`,
        );
        approx(upload!.data[0], SRGB_TO_AP0[0][0]);
        approx(upload!.data[1], SRGB_TO_AP0[1][0]);
        approx(upload!.data[2], SRGB_TO_AP0[2][0]);
        approx(upload!.data[3], SRGB_TO_AP0[0][1]);
        approx(upload!.data[4], SRGB_TO_AP0[1][1]);
        approx(upload!.data[5], SRGB_TO_AP0[2][1]);
        approx(upload!.data[6], SRGB_TO_AP0[0][2]);
        approx(upload!.data[7], SRGB_TO_AP0[1][2]);
        approx(upload!.data[8], SRGB_TO_AP0[2][2]);
    });
});
