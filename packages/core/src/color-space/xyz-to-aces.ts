/**
 * XYZ (D65) ↔ ACES2065-1 (AP0) Color Conversion.
 *
 * Provides the transformation between CIE XYZ with a D65 illuminant and
 * ACES2065-1 (AP0). LibRaw and other RAW decoders commonly output XYZ
 * under D65, which requires a Bradford chromatic adaptation to the ACES
 * white point (~D60) before the XYZ→AP0 primaries conversion.
 *
 * Pipeline: XYZ(D65) → CAT(Bradford) → XYZ(ACES WP) → ACES AP0
 *
 * ACES White Point: x=0.32168, y=0.33767 (≈D60)
 * D65 White Point:  x=0.31272, y=0.32903
 *
 * The matrices here are the pre-multiplied CAT × XYZ→AP0 products, so
 * a single 3×3 multiply completes the transform.
 *
 * Reference values verified against the `colour-science` Python library:
 *   colour.RGB_COLOURSPACES['ACES2065-1'].matrix_XYZ_to_RGB
 *   colour.adaptation.matrix_chromatic_adaptation_VonKries()
 */

/**
 * Combined XYZ(D65) → ACES2065-1 (AP0) matrix.
 * Includes Bradford D65 → ACES-WP chromatic adaptation.
 */
export const M_XYZ_D65_TO_AP0: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
] = [
    [ 1.0634783942,  0.0064037762, -0.0157655211],
    [-0.4920693795,  1.3682084519,  0.0913560627],
    [-0.0028078016,  0.0046290619,  0.9166363028],
] as const;

/**
 * Inverse matrix: ACES2065-1 (AP0) → XYZ(D65). Useful for round-trip
 * verification and reverse transforms.
 */
export const M_AP0_TO_XYZ_D65: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
] = [
    [ 0.9382964242, -0.0044477114,  0.0165813392],
    [ 0.3373755050,  0.7295300884, -0.0669055935],
    [ 0.0011703858, -0.0036977896,  1.0913338956],
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
export function applyMatrix3x3InPlace(data: Float32Array, matrix: Mat3): void {
    if (data.length % 3 !== 0) {
        throw new Error('applyMatrix3x3InPlace: data length must be divisible by 3');
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
export function applyMatrix3x3RGBAInPlace(data: Float32Array, matrix: Mat3): void {
    if (data.length % 4 !== 0) {
        throw new Error('applyMatrix3x3RGBAInPlace: data length must be divisible by 4');
    }
    const m00 = matrix[0][0], m01 = matrix[0][1], m02 = matrix[0][2];
    const m10 = matrix[1][0], m11 = matrix[1][1], m12 = matrix[1][2];
    const m20 = matrix[2][0], m21 = matrix[2][1], m22 = matrix[2][2];

    for (let i = 0; i < data.length; i += 4) {
        const x = data[i];
        const y = data[i + 1];
        const z = data[i + 2];
        // data[i + 3] is alpha — preserved
        data[i]     = m00 * x + m01 * y + m02 * z;
        data[i + 1] = m10 * x + m11 * y + m12 * z;
        data[i + 2] = m20 * x + m21 * y + m22 * z;
    }
}

/** Convert XYZ(D65) triplets to ACES2065-1 in place. */
export function xyzD65ToAces(data: Float32Array): void {
    applyMatrix3x3InPlace(data, M_XYZ_D65_TO_AP0);
}

/** Convert XYZ(D65) RGBA to ACES2065-1 RGBA in place (alpha preserved). */
export function xyzD65ToAcesRGBA(data: Float32Array): void {
    applyMatrix3x3RGBAInPlace(data, M_XYZ_D65_TO_AP0);
}

/** Convert ACES2065-1 triplets to XYZ(D65) in place. */
export function acesToXyzD65(data: Float32Array): void {
    applyMatrix3x3InPlace(data, M_AP0_TO_XYZ_D65);
}

/** Convert ACES2065-1 RGBA to XYZ(D65) RGBA in place (alpha preserved). */
export function acesToXyzD65RGBA(data: Float32Array): void {
    applyMatrix3x3RGBAInPlace(data, M_AP0_TO_XYZ_D65);
}
