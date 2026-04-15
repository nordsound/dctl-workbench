/**
 * WebGL2 executor for the pre-transform pass.
 *
 * The WebGPU path uses a compute shader (see `pre-transform-runner.ts`).
 * Here the same effect is built out of render-to-texture: a full-screen
 * fragment pass samples the input texture, multiplies `pixel.rgb` by a
 * 3×3 matrix uniform, and writes the result into an RGBA32F texture
 * attached to a temporary framebuffer.
 *
 * The returned texture replaces the viewer's current image texture for
 * downstream passes (OCIO, DCTL) — the caller is responsible for deleting
 * the previous one after it has swapped it out.
 *
 * Notes on invariants:
 *   - The program, VBO, and uniform locations are compiled / created once
 *     and cached for the lifetime of the viewer. Subsequent calls reuse
 *     them; only the output texture + framebuffer are fresh per call.
 *   - Alpha is preserved verbatim (shader-level); the RGBA32F attachment
 *     can hold out-of-[0,1] values that a subsequent matrix may produce.
 *   - The default framebuffer is restored at the end of the call so the
 *     viewer's normal render path is unaffected.
 */

import {
    buildPreTransformVertexGLSL,
    buildPreTransformFragmentGLSL,
    PRE_TRANSFORM_GLSL_ATTRIB_POSITION,
    PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX,
    PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
} from './pre-transform-shader-glsl';
import { encodeMat3ForGlslUniform } from './matrix-encoding';

// ---------------------------------------------------------------------------
// Minimal WebGL2 surface declared locally.
//
// The webview itself compiles under a tsconfig that pulls in the DOM lib, so
// these shadow the real globals at runtime. Declaring them here instead of
// enabling DOM for the unit-test tsconfig avoids an incompatibility between
// DOM's newer `Float32Array<ArrayBufferLike>` and the @webgpu/types'
// `GPUAllowSharedBufferSource` used by texture-utils.ts under test.
// ---------------------------------------------------------------------------

type WebGLShader = unknown;
type WebGLProgram = unknown;
type WebGLBuffer = unknown;
type WebGLTexture = unknown;
type WebGLFramebuffer = unknown;
type WebGLUniformLocation = unknown;

interface WebGL2Shim {
    // Constants the runner references through `gl.X`.
    readonly VERTEX_SHADER: number;
    readonly FRAGMENT_SHADER: number;
    readonly COMPILE_STATUS: number;
    readonly LINK_STATUS: number;
    readonly TEXTURE_2D: number;
    readonly TEXTURE0: number;
    readonly RGBA32F: number;
    readonly RGBA: number;
    readonly FLOAT: number;
    readonly FRAMEBUFFER: number;
    readonly COLOR_ATTACHMENT0: number;
    readonly FRAMEBUFFER_COMPLETE: number;
    readonly ARRAY_BUFFER: number;
    readonly STATIC_DRAW: number;
    readonly TRIANGLE_STRIP: number;
    readonly NEAREST: number;
    readonly CLAMP_TO_EDGE: number;
    readonly TEXTURE_MIN_FILTER: number;
    readonly TEXTURE_MAG_FILTER: number;
    readonly TEXTURE_WRAP_S: number;
    readonly TEXTURE_WRAP_T: number;

    // Shader + program
    createShader(type: number): WebGLShader | null;
    shaderSource(shader: WebGLShader, source: string): void;
    compileShader(shader: WebGLShader): void;
    getShaderParameter(shader: WebGLShader, pname: number): boolean;
    getShaderInfoLog(shader: WebGLShader): string | null;
    createProgram(): WebGLProgram | null;
    attachShader(program: WebGLProgram, shader: WebGLShader): void;
    linkProgram(program: WebGLProgram): void;
    getProgramParameter(program: WebGLProgram, pname: number): boolean;
    getProgramInfoLog(program: WebGLProgram): string | null;
    useProgram(program: WebGLProgram | null): void;
    getAttribLocation(program: WebGLProgram, name: string): number;
    getUniformLocation(program: WebGLProgram, name: string): WebGLUniformLocation | null;

    // Texture
    createTexture(): WebGLTexture | null;
    bindTexture(target: number, texture: WebGLTexture | null): void;
    texImage2D(
        target: number, level: number, internalFormat: number,
        width: number, height: number, border: number,
        format: number, type: number, pixels: ArrayBufferView | null,
    ): void;
    texParameteri(target: number, pname: number, param: number): void;
    deleteTexture(texture: WebGLTexture | null): void;
    activeTexture(unit: number): void;

    // Framebuffer
    createFramebuffer(): WebGLFramebuffer | null;
    bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null): void;
    framebufferTexture2D(
        target: number, attachment: number, texTarget: number,
        texture: WebGLTexture, level: number,
    ): void;
    checkFramebufferStatus(target: number): number;
    deleteFramebuffer(framebuffer: WebGLFramebuffer | null): void;

    // Buffer
    createBuffer(): WebGLBuffer | null;
    bindBuffer(target: number, buffer: WebGLBuffer | null): void;
    bufferData(target: number, data: ArrayBufferView, usage: number): void;

    // Vertex attrib
    enableVertexAttribArray(index: number): void;
    vertexAttribPointer(
        index: number, size: number, type: number,
        normalized: boolean, stride: number, offset: number,
    ): void;

    // Uniforms
    uniformMatrix3fv(location: WebGLUniformLocation | null, transpose: boolean, data: Float32Array): void;
    uniform1i(location: WebGLUniformLocation | null, value: number): void;

    // Draw
    viewport(x: number, y: number, width: number, height: number): void;
    drawArrays(mode: number, first: number, count: number): void;
}

export type PreTransformMatrix = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

/**
 * Per-renderer cache shared across `runPreTransformWebGL2` calls.
 * Everything in here depends only on the GL context, not on any
 * particular image — so it's safe to create once and reuse.
 */
export interface WebGL2PreTransformCache {
    program: WebGLProgram | null;
    vbo: WebGLBuffer | null;
    positionAttrib: number;
    inputTexLoc: WebGLUniformLocation | null;
    matrixLoc: WebGLUniformLocation | null;
}

export function createWebGL2PreTransformCache(): WebGL2PreTransformCache {
    return {
        program: null,
        vbo: null,
        positionAttrib: -1,
        inputTexLoc: null,
        matrixLoc: null,
    };
}

// Full-screen quad as a triangle strip (4 vertices × 2 floats = 8 floats).
// Positions are already in clip space; the vertex shader derives UVs from
// them directly.
const FULLSCREEN_STRIP = new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
     1,  1,
]);
const FULLSCREEN_STRIP_VERTEX_COUNT = 4;

function compileShader(gl: WebGL2Shim, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('gl.createShader returned null');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? '(no log)';
        throw new Error(`pre-transform shader compile failed: ${log}`);
    }
    return shader;
}

function linkProgram(
    gl: WebGL2Shim,
    vs: WebGLShader,
    fs: WebGLShader,
): WebGLProgram {
    const program = gl.createProgram();
    if (!program) throw new Error('gl.createProgram returned null');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? '(no log)';
        throw new Error(`pre-transform program link failed: ${log}`);
    }
    return program;
}

function ensureProgramAndVbo(
    gl: WebGL2Shim,
    cache: WebGL2PreTransformCache,
): void {
    if (!cache.program) {
        const vs = compileShader(gl, gl.VERTEX_SHADER, buildPreTransformVertexGLSL());
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, buildPreTransformFragmentGLSL());
        cache.program = linkProgram(gl, vs, fs);
        cache.positionAttrib = gl.getAttribLocation(
            cache.program,
            PRE_TRANSFORM_GLSL_ATTRIB_POSITION,
        );
        cache.inputTexLoc = gl.getUniformLocation(
            cache.program,
            PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX,
        );
        cache.matrixLoc = gl.getUniformLocation(
            cache.program,
            PRE_TRANSFORM_GLSL_UNIFORM_MATRIX,
        );
    }
    if (!cache.vbo) {
        cache.vbo = gl.createBuffer();
        if (!cache.vbo) throw new Error('gl.createBuffer returned null');
        gl.bindBuffer(gl.ARRAY_BUFFER, cache.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_STRIP, gl.STATIC_DRAW);
    }
}

function createOutputTexture(
    gl: WebGL2Shim,
    width: number,
    height: number,
): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) throw new Error('gl.createTexture returned null');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        width,
        height,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
    );
    // Nearest sampling keeps the intermediate free of bilinear smoothing
    // at pixel boundaries; the downstream OCIO / DCTL shaders pick their
    // own filters when they sample it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

/**
 * Execute one pre-transform pass in WebGL2 and return the new RGBA32F
 * texture. The caller is responsible for deleting the previous source
 * texture once it has swapped this one in.
 */
export function runPreTransformWebGL2(
    gl: WebGL2Shim,
    source: WebGLTexture,
    width: number,
    height: number,
    matrix: PreTransformMatrix,
    cache: WebGL2PreTransformCache,
): WebGLTexture {
    ensureProgramAndVbo(gl, cache);

    // --- Allocate output + temporary FBO ----------------------------------
    const output = createOutputTexture(gl, width, height);
    const fbo = gl.createFramebuffer();
    if (!fbo) {
        gl.deleteTexture(output);
        throw new Error('gl.createFramebuffer returned null');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        output,
        0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(output);
        throw new Error(`pre-transform framebuffer incomplete (status=${status})`);
    }

    // --- Set up draw state ------------------------------------------------
    gl.viewport(0, 0, width, height);
    gl.useProgram(cache.program);

    // Bind the position VBO and tell the attribute how to pull from it.
    gl.bindBuffer(gl.ARRAY_BUFFER, cache.vbo);
    gl.enableVertexAttribArray(cache.positionAttrib);
    gl.vertexAttribPointer(cache.positionAttrib, 2, gl.FLOAT, false, 0, 0);

    // Bind the source image texture on unit 0 and tell the sampler uniform
    // to read from that unit.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(cache.inputTexLoc, 0);

    // Upload the matrix as tight column-major 9 floats (transpose=false).
    gl.uniformMatrix3fv(cache.matrixLoc, false, encodeMat3ForGlslUniform(matrix));

    // --- Draw and restore default framebuffer -----------------------------
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, FULLSCREEN_STRIP_VERTEX_COUNT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);

    return output;
}
