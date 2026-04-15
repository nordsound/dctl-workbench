/**
 * XYZ (D50) ↔ ACES2065-1 (AP0) Color Conversion.
 *
 * Converts between CIE XYZ with a D50 illuminant and ACES2065-1 (AP0).
 * D50 is the standard white point for print / ICC / DNG ForwardMatrix
 * workflows, so plugins that emit XYZ in D50 use these helpers.
 *
 * Pipeline: XYZ(D50) → Bradford CAT → XYZ(ACES WP ≈ D60) → ACES AP0
 *
 * D50 White Point: x=0.34567, y=0.35850
 * ACES White Point: x=0.32168, y=0.33767 (≈D60)
 *
 * The matrices here are the pre-multiplied CAT × XYZ→AP0 products so a
 * single 3×3 multiply completes the transform.
 *
 * Reference values verified against the `colour-science` Python library:
 *   colour.RGB_COLOURSPACES['ACES2065-1'].matrix_XYZ_to_RGB
 *   colour.adaptation.matrix_chromatic_adaptation_VonKries(D50 → ACES WP, 'Bradford')
 */

/**
 * Combined XYZ(D50) → ACES2065-1 (AP0) matrix.
 * Includes Bradford D50 → ACES WP chromatic adaptation.
 */
export const M_XYZ_D50_TO_AP0: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
] = [
    [ 1.0158358037, -0.0177257006,  0.0463465552],
    [-0.5078088842,  1.3913069112,  0.1191588728],
    [ 0.0084586363, -0.0140343957,  1.2189684415],
] as const;

/**
 * Inverse matrix: ACES2065-1 (AP0) → XYZ(D50).
 * Includes Bradford ACES WP → D50 chromatic adaptation.
 */
export const M_AP0_TO_XYZ_D50: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
] = [
    [ 0.9908492304,  0.0122316616, -0.0388688976],
    [ 0.3618790851,  0.7225079038, -0.0843869889],
    [-0.0027092407,  0.0082336001,  0.8196639252],
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
export function applyMatrix3x3InPlaceD50(data: Float32Array, matrix: Mat3): void {
    if (data.length % 3 !== 0) {
        throw new Error('applyMatrix3x3InPlaceD50: data length must be divisible by 3');
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
export function applyMatrix3x3RGBAInPlaceD50(data: Float32Array, matrix: Mat3): void {
    if (data.length % 4 !== 0) {
        throw new Error('applyMatrix3x3RGBAInPlaceD50: data length must be divisible by 4');
    }
    const m00 = matrix[0][0], m01 = matrix[0][1], m02 = matrix[0][2];
    const m10 = matrix[1][0], m11 = matrix[1][1], m12 = matrix[1][2];
    const m20 = matrix[2][0], m21 = matrix[2][1], m22 = matrix[2][2];

    for (let i = 0; i < data.length; i += 4) {
        const x = data[i];
        const y = data[i + 1];
        const z = data[i + 2];
        // alpha preserved
        data[i]     = m00 * x + m01 * y + m02 * z;
        data[i + 1] = m10 * x + m11 * y + m12 * z;
        data[i + 2] = m20 * x + m21 * y + m22 * z;
    }
}

/** Convert XYZ(D50) triplets to ACES2065-1 in place. */
export function xyzD50ToAces(data: Float32Array): void {
    applyMatrix3x3InPlaceD50(data, M_XYZ_D50_TO_AP0);
}

/** Convert XYZ(D50) RGBA to ACES2065-1 RGBA in place (alpha preserved). */
export function xyzD50ToAcesRGBA(data: Float32Array): void {
    applyMatrix3x3RGBAInPlaceD50(data, M_XYZ_D50_TO_AP0);
}

/** Convert ACES2065-1 triplets to XYZ(D50) in place. */
export function acesToXyzD50(data: Float32Array): void {
    applyMatrix3x3InPlaceD50(data, M_AP0_TO_XYZ_D50);
}

/** Convert ACES2065-1 RGBA to XYZ(D50) RGBA in place (alpha preserved). */
export function acesToXyzD50RGBA(data: Float32Array): void {
    applyMatrix3x3RGBAInPlaceD50(data, M_AP0_TO_XYZ_D50);
}
