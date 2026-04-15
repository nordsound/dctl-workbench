/**
 * Encoding helpers for uploading small matrices into WebGPU uniforms.
 *
 * WGSL's `mat3x3<f32>` is laid out column-major with each column padded
 * to a `vec4`'s alignment (16 bytes). Naïvely copying a 3×3 row-major
 * JS array into a 9-element Float32Array produces wrong results in
 * both shape (transposed) and size (missing padding).
 */

type Mat3 = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

/**
 * Encode a row-major 3×3 matrix into a Float32Array that can be copied
 * straight into a WebGPU uniform bound to a `mat3x3<f32>`.
 *
 * Output layout (12 floats):
 *   col0.x, col0.y, col0.z, pad,
 *   col1.x, col1.y, col1.z, pad,
 *   col2.x, col2.y, col2.z, pad
 */
export function encodeMat3ForWgslUniform(matrix: Mat3): Float32Array {
    const out = new Float32Array(12);
    for (let col = 0; col < 3; col++) {
        out[col * 4 + 0] = matrix[0][col];
        out[col * 4 + 1] = matrix[1][col];
        out[col * 4 + 2] = matrix[2][col];
        // out[col * 4 + 3] remains 0 — the column's vec4 padding slot.
    }
    return out;
}

/** Byte size of the packed mat3x3 uniform (12 × f32 = 48 bytes). */
export const MAT3X3_UNIFORM_BYTE_SIZE = 48;

/**
 * Encode a row-major 3×3 matrix into a Float32Array suitable for a
 * GLSL `mat3` uniform upload via `uniformMatrix3fv(loc, false, encoded)`.
 *
 * GLSL's `mat3` is column-major like WGSL's `mat3x3<f32>`, but tightly
 * packed — no vec4 padding. The output is exactly 9 floats in the order
 * (col0.x, col0.y, col0.z, col1.x, col1.y, col1.z, col2.x, col2.y, col2.z).
 *
 * Equivalent to `encodeMat3ForWgslUniform` with padding slots 3, 7, 11
 * stripped — a test in matrix-encoding.test.ts pins this invariant.
 */
export function encodeMat3ForGlslUniform(matrix: Mat3): Float32Array {
    const out = new Float32Array(9);
    for (let col = 0; col < 3; col++) {
        out[col * 3 + 0] = matrix[0][col];
        out[col * 3 + 1] = matrix[1][col];
        out[col * 3 + 2] = matrix[2][col];
    }
    return out;
}
