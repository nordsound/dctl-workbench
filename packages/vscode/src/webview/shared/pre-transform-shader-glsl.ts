/**
 * Pure builder for the WebGL2 pre-transform shader pair.
 *
 * The WebGPU path applies the plugin-supplied 3×3 matrix through a compute
 * pass (see `pre-transform-shader.ts`). WebGL2 has no compute; the same
 * effect is achieved by rendering a full-screen triangle with a fragment
 * shader that samples the input texture, multiplies `pixel.rgb` by a
 * `mat3` uniform, and writes to an FBO-attached RGBA32F texture.
 *
 * The shader source is static. What callers care about is the *contract*:
 *   - attribute name used for the clip-space vertex positions
 *   - sampler2D uniform name used for the input image texture
 *   - mat3 uniform name used for the pre-transform matrix
 *
 * Exporting these constants alongside the builders lets the runner bind
 * uniforms / attributes by name without duplicating string literals.
 */

/** Attribute name for clip-space vertex positions in the vertex shader. */
export const PRE_TRANSFORM_GLSL_ATTRIB_POSITION = 'a_position';

/** Uniform name for the input texture in the fragment shader. */
export const PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX = 'u_inputTex';

/** Uniform name for the 3×3 pre-transform matrix in the fragment shader. */
export const PRE_TRANSFORM_GLSL_UNIFORM_MATRIX = 'u_preMatrix';

/**
 * Return the vertex shader source for the pre-transform pass.
 *
 * The vertex shader emits a full-screen triangle (two triangles in the
 * caller's VBO) in normalized device coordinates and forwards the
 * derived UV to the fragment stage. `a_position` is expected to be in
 * clip space already (`[-1, 1]` range), so the UV is simply
 * `a_position * 0.5 + 0.5`.
 */
export function buildPreTransformVertexGLSL(): string {
    return `\
#version 300 es
// Pre-transform pass — vertex shader (full-screen quad).
// Input: clip-space positions in [-1, 1]. Output: [0, 1] UV.

in vec2 ${PRE_TRANSFORM_GLSL_ATTRIB_POSITION};
out vec2 v_uv;

void main() {
    v_uv = ${PRE_TRANSFORM_GLSL_ATTRIB_POSITION} * 0.5 + 0.5;
    gl_Position = vec4(${PRE_TRANSFORM_GLSL_ATTRIB_POSITION}, 0.0, 1.0);
}
`;
}

/**
 * Return the fragment shader source for the pre-transform pass.
 *
 * Samples `u_inputTex` at the interpolated UV, multiplies the RGB by
 * `u_preMatrix`, and writes `(rgb, input_alpha)` to `outColor`. Alpha
 * passes through untouched — the runner's tests cover this invariant.
 */
export function buildPreTransformFragmentGLSL(): string {
    return `\
#version 300 es
// Pre-transform pass — fragment shader.
// Applies a 3x3 matrix to each pixel's RGB; alpha is preserved verbatim.

precision highp float;

uniform sampler2D ${PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX};
uniform mat3 ${PRE_TRANSFORM_GLSL_UNIFORM_MATRIX};

in vec2 v_uv;
out vec4 outColor;

void main() {
    vec4 pixel = texture(${PRE_TRANSFORM_GLSL_UNIFORM_INPUT_TEX}, v_uv);
    vec3 rgb = ${PRE_TRANSFORM_GLSL_UNIFORM_MATRIX} * pixel.rgb;
    outColor = vec4(rgb, pixel.a);
}
`;
}
