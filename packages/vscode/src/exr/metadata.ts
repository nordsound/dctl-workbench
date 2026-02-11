/**
 * EXR Metadata Utilities
 *
 * Provides common chromaticities definitions and metadata utilities.
 */

import type { Chromaticities } from '../plugins/types';

// =============================================================================
// Standard Chromaticities
// =============================================================================

/**
 * ACES2065-1 (AP0) chromaticities
 * Academy Color Encoding Specification primaries
 */
export const ACES_CHROMATICITIES: Chromaticities = {
    redX: 0.7347,
    redY: 0.2653,
    greenX: 0.0,
    greenY: 1.0,
    blueX: 0.0001,
    blueY: -0.077,
    whiteX: 0.32168,
    whiteY: 0.33767,
};

/**
 * ACEScg (AP1) chromaticities
 * Academy Color Encoding Specification working space
 */
export const ACESCG_CHROMATICITIES: Chromaticities = {
    redX: 0.713,
    redY: 0.293,
    greenX: 0.165,
    greenY: 0.83,
    blueX: 0.128,
    blueY: 0.044,
    whiteX: 0.32168,
    whiteY: 0.33767,
};

/**
 * sRGB / Rec.709 chromaticities
 */
export const SRGB_CHROMATICITIES: Chromaticities = {
    redX: 0.64,
    redY: 0.33,
    greenX: 0.3,
    greenY: 0.6,
    blueX: 0.15,
    blueY: 0.06,
    whiteX: 0.3127,
    whiteY: 0.329,
};

/**
 * Rec.2020 / BT.2020 chromaticities
 */
export const REC2020_CHROMATICITIES: Chromaticities = {
    redX: 0.708,
    redY: 0.292,
    greenX: 0.17,
    greenY: 0.797,
    blueX: 0.131,
    blueY: 0.046,
    whiteX: 0.3127,
    whiteY: 0.329,
};

/**
 * DCI-P3 chromaticities
 */
export const DCI_P3_CHROMATICITIES: Chromaticities = {
    redX: 0.68,
    redY: 0.32,
    greenX: 0.265,
    greenY: 0.69,
    blueX: 0.15,
    blueY: 0.06,
    whiteX: 0.314,
    whiteY: 0.351,
};

/**
 * Display P3 chromaticities (DCI-P3 with D65 white point)
 */
export const DISPLAY_P3_CHROMATICITIES: Chromaticities = {
    redX: 0.68,
    redY: 0.32,
    greenX: 0.265,
    greenY: 0.69,
    blueX: 0.15,
    blueY: 0.06,
    whiteX: 0.3127,
    whiteY: 0.329,
};

/**
 * Adobe RGB chromaticities
 */
export const ADOBE_RGB_CHROMATICITIES: Chromaticities = {
    redX: 0.64,
    redY: 0.33,
    greenX: 0.21,
    greenY: 0.71,
    blueX: 0.15,
    blueY: 0.06,
    whiteX: 0.3127,
    whiteY: 0.329,
};

/**
 * ProPhoto RGB / ROMM RGB chromaticities
 */
export const PROPHOTO_RGB_CHROMATICITIES: Chromaticities = {
    redX: 0.7347,
    redY: 0.2653,
    greenX: 0.1596,
    greenY: 0.8404,
    blueX: 0.0366,
    blueY: 0.0001,
    whiteX: 0.3457,
    whiteY: 0.3585,
};

// =============================================================================
// Standard White Points
// =============================================================================

/** D50 white point (5003K) */
export const D50_WHITE_POINT = { x: 0.3457, y: 0.3585 };

/** D55 white point (5503K) */
export const D55_WHITE_POINT = { x: 0.3324, y: 0.3474 };

/** D60 white point (6003K) - ACES */
export const D60_WHITE_POINT = { x: 0.32168, y: 0.33767 };

/** D65 white point (6504K) */
export const D65_WHITE_POINT = { x: 0.3127, y: 0.329 };

/** DCI white point */
export const DCI_WHITE_POINT = { x: 0.314, y: 0.351 };

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if two chromaticities are approximately equal
 */
export function chromaticitiesEqual(
    a: Chromaticities,
    b: Chromaticities,
    tolerance: number = 0.0001
): boolean {
    return (
        Math.abs(a.redX - b.redX) < tolerance &&
        Math.abs(a.redY - b.redY) < tolerance &&
        Math.abs(a.greenX - b.greenX) < tolerance &&
        Math.abs(a.greenY - b.greenY) < tolerance &&
        Math.abs(a.blueX - b.blueX) < tolerance &&
        Math.abs(a.blueY - b.blueY) < tolerance &&
        Math.abs(a.whiteX - b.whiteX) < tolerance &&
        Math.abs(a.whiteY - b.whiteY) < tolerance
    );
}

/**
 * Known color space definitions
 */
export type KnownColorSpace =
    | 'ACES2065-1'
    | 'ACEScg'
    | 'sRGB'
    | 'Rec.2020'
    | 'DCI-P3'
    | 'Display P3'
    | 'Adobe RGB'
    | 'ProPhoto RGB'
    | 'unknown';

/**
 * Identify color space from chromaticities
 */
export function identifyColorSpace(
    chroma: Chromaticities,
    tolerance: number = 0.001
): KnownColorSpace {
    if (chromaticitiesEqual(chroma, ACES_CHROMATICITIES, tolerance)) {
        return 'ACES2065-1';
    }
    if (chromaticitiesEqual(chroma, ACESCG_CHROMATICITIES, tolerance)) {
        return 'ACEScg';
    }
    if (chromaticitiesEqual(chroma, SRGB_CHROMATICITIES, tolerance)) {
        return 'sRGB';
    }
    if (chromaticitiesEqual(chroma, REC2020_CHROMATICITIES, tolerance)) {
        return 'Rec.2020';
    }
    if (chromaticitiesEqual(chroma, DCI_P3_CHROMATICITIES, tolerance)) {
        return 'DCI-P3';
    }
    if (chromaticitiesEqual(chroma, DISPLAY_P3_CHROMATICITIES, tolerance)) {
        return 'Display P3';
    }
    if (chromaticitiesEqual(chroma, ADOBE_RGB_CHROMATICITIES, tolerance)) {
        return 'Adobe RGB';
    }
    if (chromaticitiesEqual(chroma, PROPHOTO_RGB_CHROMATICITIES, tolerance)) {
        return 'ProPhoto RGB';
    }
    return 'unknown';
}

/**
 * Get chromaticities for a known color space
 */
export function getChromaticities(colorSpace: KnownColorSpace): Chromaticities | undefined {
    switch (colorSpace) {
        case 'ACES2065-1':
            return ACES_CHROMATICITIES;
        case 'ACEScg':
            return ACESCG_CHROMATICITIES;
        case 'sRGB':
            return SRGB_CHROMATICITIES;
        case 'Rec.2020':
            return REC2020_CHROMATICITIES;
        case 'DCI-P3':
            return DCI_P3_CHROMATICITIES;
        case 'Display P3':
            return DISPLAY_P3_CHROMATICITIES;
        case 'Adobe RGB':
            return ADOBE_RGB_CHROMATICITIES;
        case 'ProPhoto RGB':
            return PROPHOTO_RGB_CHROMATICITIES;
        default:
            return undefined;
    }
}

/**
 * Convert xy chromaticity to XYZ (assuming Y=1)
 */
export function xyToXYZ(x: number, y: number): [number, number, number] {
    if (y === 0) {
        return [0, 0, 0];
    }
    const X = x / y;
    const Y = 1;
    const Z = (1 - x - y) / y;
    return [X, Y, Z];
}

/**
 * Calculate RGB to XYZ matrix from chromaticities
 */
export function calculateRGBtoXYZMatrix(chroma: Chromaticities): number[][] {
    // Convert primaries to XYZ
    const [Xr, Yr, Zr] = xyToXYZ(chroma.redX, chroma.redY);
    const [Xg, Yg, Zg] = xyToXYZ(chroma.greenX, chroma.greenY);
    const [Xb, Yb, Zb] = xyToXYZ(chroma.blueX, chroma.blueY);
    const [Xw, Yw, Zw] = xyToXYZ(chroma.whiteX, chroma.whiteY);

    // Solve for scaling factors S = [Sr, Sg, Sb]
    // M * S = W where M is the primaries matrix and W is white point
    const M = [
        [Xr, Xg, Xb],
        [Yr, Yg, Yb],
        [Zr, Zg, Zb],
    ];

    // Invert M to solve for S
    const det =
        M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
        M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
        M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);

    if (Math.abs(det) < 1e-10) {
        throw new Error('Singular matrix - invalid chromaticities');
    }

    const invDet = 1 / det;
    const invM = [
        [
            (M[1][1] * M[2][2] - M[1][2] * M[2][1]) * invDet,
            (M[0][2] * M[2][1] - M[0][1] * M[2][2]) * invDet,
            (M[0][1] * M[1][2] - M[0][2] * M[1][1]) * invDet,
        ],
        [
            (M[1][2] * M[2][0] - M[1][0] * M[2][2]) * invDet,
            (M[0][0] * M[2][2] - M[0][2] * M[2][0]) * invDet,
            (M[0][2] * M[1][0] - M[0][0] * M[1][2]) * invDet,
        ],
        [
            (M[1][0] * M[2][1] - M[1][1] * M[2][0]) * invDet,
            (M[0][1] * M[2][0] - M[0][0] * M[2][1]) * invDet,
            (M[0][0] * M[1][1] - M[0][1] * M[1][0]) * invDet,
        ],
    ];

    // S = invM * W
    const Sr = invM[0][0] * Xw + invM[0][1] * Yw + invM[0][2] * Zw;
    const Sg = invM[1][0] * Xw + invM[1][1] * Yw + invM[1][2] * Zw;
    const Sb = invM[2][0] * Xw + invM[2][1] * Yw + invM[2][2] * Zw;

    // Final matrix = M * diag(S)
    return [
        [Xr * Sr, Xg * Sg, Xb * Sb],
        [Yr * Sr, Yg * Sg, Yb * Sb],
        [Zr * Sr, Zg * Sg, Zb * Sb],
    ];
}
