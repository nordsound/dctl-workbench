/**
 * Pure builder for the pre-transform compute-shader WGSL.
 *
 * The shader applies a 3×3 row-major matrix to the RGB channels of an
 * input texture and writes the result into an rgba32float storage
 * texture. The host then feeds that intermediate texture into the
 * existing OCIO display-transform pipeline, so no other shader needs
 * to change to enable plugin-side color conversion.
 *
 * Layout:
 *   @group(0) @binding(0) — input image texture   (rgba16unorm or rgba32float)
 *   @group(0) @binding(1) — output storage texture (always rgba32float)
 *   @group(0) @binding(2) — uniform mat3x3<f32>   (pre-transform matrix)
 */

export type PreTransformInputFormat = 'rgba16unorm' | 'rgba32float';

const WORKGROUP_SIZE = 8;

export interface BuildPreTransformWGSLOptions {
    inputFormat: PreTransformInputFormat;
}

/**
 * Return the WGSL source for the pre-transform compute pass.
 *
 * The input-format knob is largely informational — both rgba16unorm and
 * rgba32float expose themselves as `texture_2d<f32>` for sampling, so
 * the generated source is the same modulo a descriptive comment. Keeping
 * the parameter lets the caller guard for unsupported formats up-front.
 */
export function buildPreTransformWGSL(options: BuildPreTransformWGSLOptions): string {
    const { inputFormat } = options;
    if (inputFormat !== 'rgba16unorm' && inputFormat !== 'rgba32float') {
        throw new Error(`buildPreTransformWGSL: unsupported inputFormat '${inputFormat}'`);
    }

    return `\
// Pre-transform compute pass (input=${inputFormat}, output=rgba32float).
// Applies a 3x3 matrix to each pixel's RGB; alpha is preserved verbatim.

@group(0) @binding(0) var inputTex:  texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var<uniform>   preMatrix: mat3x3<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
fn apply_pre_transform(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(inputTex);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }
    let coord = vec2<i32>(i32(gid.x), i32(gid.y));
    let pixel = textureLoad(inputTex, coord, 0);
    let rgb = preMatrix * pixel.rgb;
    textureStore(outputTex, coord, vec4<f32>(rgb, pixel.a));
}
`;
}

/** Workgroup size used by the compute pass, exported for the dispatcher. */
export const PRE_TRANSFORM_WORKGROUP_SIZE = WORKGROUP_SIZE;
