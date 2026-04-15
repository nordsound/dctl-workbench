/**
 * Linear sRGB (D65) ↔ ACES2065-1 (AP0) Color Conversion.
 *
 * Buffer-based helpers mirroring `xyz-to-aces.ts` / `xyz-d50-to-aces.ts`,
 * built on the existing `SRGB_TO_AP0` / `AP0_TO_SRGB` matrices.
 *
 * Used as a fallback path for plugins when no more-accurate color
 * metadata (DNG ForwardMatrix, camera XYZ matrix) is available.
 */

/**
 * Linear-sRGB (D65) → ACES2065-1 (AP0) matrix — Bradford adapted.
 * Values match `SRGB_TO_AP0` in `./index`; duplicated here to avoid the
 * circular-import hazard from depending on index.ts during init.
 */
export const M_SRGB_TO_AP0: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
] = [
    [0.4395722998, 0.3839185441, 0.1765091561],
    [0.0895766616, 0.8150065542, 0.0954167842],
    [0.0173096404, 0.1095964685, 0.8730938911],
] as const;

/** Inverse matrix: ACES2065-1 (AP0) → linear sRGB (D65). */
export const M_AP0_TO_SRGB: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
] = [
    [ 2.5216494298, -1.1368885542, -0.3849175932],
    [-0.2752135512,  1.3697051510, -0.0943924508],
    [-0.0159250101, -0.1478063681,  1.1638276817],
] as const;

type Mat3 = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

/**
 * Apply a 3×3 matrix to an interleaved RGB Float32Array in place.
 * Length must be a multiple of 3.
 */
export function applyMatrix3x3InPlaceSrgb(data: Float32Array, matrix: Mat3): void {
    if (data.length % 3 !== 0) {
        throw new Error('applyMatrix3x3InPlaceSrgb: data length must be divisible by 3');
    }
    const m00 = matrix[0][0], m01 = matrix[0][1], m02 = matrix[0][2];
    const m10 = matrix[1][0], m11 = matrix[1][1], m12 = matrix[1][2];
    const m20 = matrix[2][0], m21 = matrix[2][1], m22 = matrix[2][2];
    for (let i = 0; i < data.length; i += 3) {
        const x = data[i];
        const y = data[i + 1];
        const z = data[i + 2];
        data[i]     = m00 * x + m01 * y + m02 * z;
        data[i + 1] = m10 * x + m11 * y + m12 * z;
        data[i + 2] = m20 * x + m21 * y + m22 * z;
    }
}

/**
 * Apply a 3×3 matrix to an interleaved RGBA Float32Array in place.
 * Alpha channel is preserved. Length must be a multiple of 4.
 */
export function applyMatrix3x3RGBAInPlaceSrgb(data: Float32Array, matrix: Mat3): void {
    if (data.length % 4 !== 0) {
        throw new Error('applyMatrix3x3RGBAInPlaceSrgb: data length must be divisible by 4');
    }
    const m00 = matrix[0][0], m01 = matrix[0][1], m02 = matrix[0][2];
    const m10 = matrix[1][0], m11 = matrix[1][1], m12 = matrix[1][2];
    const m20 = matrix[2][0], m21 = matrix[2][1], m22 = matrix[2][2];
    for (let i = 0; i < data.length; i += 4) {
        const x = data[i];
        const y = data[i + 1];
        const z = data[i + 2];
        data[i]     = m00 * x + m01 * y + m02 * z;
        data[i + 1] = m10 * x + m11 * y + m12 * z;
        data[i + 2] = m20 * x + m21 * y + m22 * z;
    }
}

/** Convert linear-sRGB RGB triplets to ACES2065-1 in place. */
export function srgbToAces(data: Float32Array): void {
    applyMatrix3x3InPlaceSrgb(data, M_SRGB_TO_AP0);
}

/** Convert linear-sRGB RGBA to ACES2065-1 RGBA in place (alpha preserved). */
export function srgbToAcesRGBA(data: Float32Array): void {
    applyMatrix3x3RGBAInPlaceSrgb(data, M_SRGB_TO_AP0);
}

/** Convert ACES2065-1 RGB triplets to linear-sRGB in place. */
export function acesToSrgb(data: Float32Array): void {
    applyMatrix3x3InPlaceSrgb(data, M_AP0_TO_SRGB);
}

/** Convert ACES2065-1 RGBA to linear-sRGB RGBA in place (alpha preserved). */
export function acesToSrgbRGBA(data: Float32Array): void {
    applyMatrix3x3RGBAInPlaceSrgb(data, M_AP0_TO_SRGB);
}
