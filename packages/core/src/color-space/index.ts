/**
 * Color Space Module
 *
 * Color space conversion matrices and functions.
 */

// =============================================================================
// Color Space Matrices (WGSL format)
// =============================================================================

/**
 * AP0 to AP1 matrix (ACES2065-1 to ACEScg)
 */
export const AP0_TO_AP1_MATRIX = {
    wgsl: `const dctl_ap0ToWorking = mat3x3<f32>(
    vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
    vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
    vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
);`,
    glsl: `const mat3 dctl_ap0ToWorking = mat3(
    1.4514393161, -0.0765537734, 0.0083161484,
    -0.2365107469, 1.1762296998, -0.0060324498,
    -0.2149285693, -0.0996759264, 0.9977163014
);`,
    values: [
        [1.4514393161, -0.0765537734, 0.0083161484],
        [-0.2365107469, 1.1762296998, -0.0060324498],
        [-0.2149285693, -0.0996759264, 0.9977163014],
    ],
};

/**
 * AP1 to AP0 matrix (ACEScg to ACES2065-1)
 */
export const AP1_TO_AP0_MATRIX = {
    wgsl: `const dctl_workingToAp0 = mat3x3<f32>(
    vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
    vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
    vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
);`,
    glsl: `const mat3 dctl_workingToAp0 = mat3(
    0.6954522414, 0.0447945634, -0.0055258826,
    0.1406786965, 0.8596711185, 0.0040252103,
    0.1638690622, 0.0955343182, 1.0015006723
);`,
    values: [
        [0.6954522414, 0.0447945634, -0.0055258826],
        [0.1406786965, 0.8596711185, 0.0040252103],
        [0.1638690622, 0.0955343182, 1.0015006723],
    ],
};

// =============================================================================
// ACEScct Encoding/Decoding (WGSL)
// =============================================================================

/**
 * ACEScct encoding functions (WGSL)
 */
export const ACESCCT_ENCODE_WGSL = `
// ACEScct encoding
fn dctl_lin_to_ACEScct_single(x: f32) -> f32 {
    let A: f32 = 10.5402377416545;
    let B: f32 = 0.0729055341958355;
    if (x <= 0.0078125) {
        return A * x + B;
    } else {
        return (log2(x) + 9.72) / 17.52;
    }
}

fn dctl_lin_to_ACEScct_vec(lin: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dctl_lin_to_ACEScct_single(lin.r),
        dctl_lin_to_ACEScct_single(lin.g),
        dctl_lin_to_ACEScct_single(lin.b)
    );
}
`;

/**
 * ACEScct decoding functions (WGSL)
 */
export const ACESCCT_DECODE_WGSL = `
// ACEScct decoding
fn dctl_ACEScct_to_lin_single(x: f32) -> f32 {
    let A: f32 = 10.5402377416545;
    let B: f32 = 0.0729055341958355;
    let cut: f32 = 0.155251141552511;
    if (x <= cut) {
        return (x - B) / A;
    } else {
        return pow(2.0, x * 17.52 - 9.72);
    }
}

fn dctl_ACEScct_to_lin_vec(cct: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dctl_ACEScct_to_lin_single(cct.r),
        dctl_ACEScct_to_lin_single(cct.g),
        dctl_ACEScct_to_lin_single(cct.b)
    );
}
`;

/**
 * ACEScct encoding functions (GLSL)
 */
export const ACESCCT_ENCODE_GLSL = `
// ACEScct encoding
float dctl_lin_to_ACEScct_single(float x) {
    const float A = 10.5402377416545;
    const float B = 0.0729055341958355;
    if (x <= 0.0078125) {
        return A * x + B;
    } else {
        return (log2(x) + 9.72) / 17.52;
    }
}

vec3 dctl_lin_to_ACEScct_vec(vec3 lin) {
    return vec3(
        dctl_lin_to_ACEScct_single(lin.r),
        dctl_lin_to_ACEScct_single(lin.g),
        dctl_lin_to_ACEScct_single(lin.b)
    );
}
`;

/**
 * ACEScct decoding functions (GLSL)
 */
export const ACESCCT_DECODE_GLSL = `
// ACEScct decoding
float dctl_ACEScct_to_lin_single(float x) {
    const float A = 10.5402377416545;
    const float B = 0.0729055341958355;
    const float cut = 0.155251141552511;
    if (x <= cut) {
        return (x - B) / A;
    } else {
        return pow(2.0, x * 17.52 - 9.72);
    }
}

vec3 dctl_ACEScct_to_lin_vec(vec3 cct) {
    return vec3(
        dctl_ACEScct_to_lin_single(cct.r),
        dctl_ACEScct_to_lin_single(cct.g),
        dctl_ACEScct_to_lin_single(cct.b)
    );
}
`;

// =============================================================================
// JavaScript Color Space Functions
// =============================================================================

/**
 * Linear to ACEScct encoding (single channel)
 */
export function linToACEScct(x: number): number {
    const A = 10.5402377416545;
    const B = 0.0729055341958355;
    if (x <= 0.0078125) {
        return A * x + B;
    } else {
        return (Math.log2(x) + 9.72) / 17.52;
    }
}

/**
 * ACEScct to linear decoding (single channel)
 */
export function ACEScctToLin(x: number): number {
    const A = 10.5402377416545;
    const B = 0.0729055341958355;
    const cut = 0.155251141552511;
    if (x <= cut) {
        return (x - B) / A;
    } else {
        return Math.pow(2, x * 17.52 - 9.72);
    }
}

/**
 * Apply 3x3 matrix to RGB values
 */
export function applyMatrix3x3(
    matrix: number[][],
    r: number,
    g: number,
    b: number
): [number, number, number] {
    return [
        matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b,
        matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b,
        matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b,
    ];
}

/**
 * Convert AP0 to AP1
 */
export function ap0ToAp1(r: number, g: number, b: number): [number, number, number] {
    return applyMatrix3x3(AP0_TO_AP1_MATRIX.values, r, g, b);
}

/**
 * Convert AP1 to AP0
 */
export function ap1ToAp0(r: number, g: number, b: number): [number, number, number] {
    return applyMatrix3x3(AP1_TO_AP0_MATRIX.values, r, g, b);
}

// =============================================================================
// Color Space Definitions
// =============================================================================

export type ColorSpace = 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB';

export interface ColorSpaceInfo {
    name: string;
    isLinear: boolean;
    isLog: boolean;
    primaries: 'AP0' | 'AP1' | 'sRGB';
}

export const COLOR_SPACE_INFO: Record<ColorSpace, ColorSpaceInfo> = {
    'ACES2065-1': { name: 'ACES2065-1', isLinear: true, isLog: false, primaries: 'AP0' },
    'ACEScg': { name: 'ACEScg', isLinear: true, isLog: false, primaries: 'AP1' },
    'ACEScc': { name: 'ACEScc', isLinear: false, isLog: true, primaries: 'AP1' },
    'ACEScct': { name: 'ACEScct', isLinear: false, isLog: true, primaries: 'AP1' },
    'linear_sRGB': { name: 'Linear sRGB', isLinear: true, isLog: false, primaries: 'sRGB' },
};

/**
 * Check if a color space is a log space (requires encoding/decoding)
 */
export function isLogColorSpace(colorSpace: ColorSpace): boolean {
    return COLOR_SPACE_INFO[colorSpace]?.isLog ?? false;
}

/**
 * Check if a color space uses AP1 primaries
 */
export function isAp1ColorSpace(colorSpace: ColorSpace): boolean {
    return COLOR_SPACE_INFO[colorSpace]?.primaries === 'AP1';
}

// =============================================================================
// Matrix Types and Raw Values
// =============================================================================

/**
 * 3x3 Matrix type (row-major, column vectors)
 */
export type Matrix3x3 = [
    [number, number, number],
    [number, number, number],
    [number, number, number]
];

/**
 * AP0 (ACES2065-1) to AP1 (ACEScg) - raw matrix
 */
export const AP0_TO_AP1: Matrix3x3 = [
    [1.4514393161, -0.2365107469, -0.2149285693],
    [-0.0765537734, 1.1762296998, -0.0996759264],
    [0.0083161484, -0.0060324498, 0.9977163014],
];

/**
 * AP1 (ACEScg) to AP0 (ACES2065-1) - raw matrix
 */
export const AP1_TO_AP0: Matrix3x3 = [
    [0.6954522414, 0.1406786965, 0.1638690622],
    [0.0447945634, 0.8596711185, 0.0955343182],
    [-0.0055258826, 0.0040252103, 1.0015006723],
];

/**
 * AP0 (ACES2065-1) to linear sRGB (D65)
 */
export const AP0_TO_SRGB: Matrix3x3 = [
    [2.5216494298, -1.1368885542, -0.3849175932],
    [-0.2752135512, 1.3697051510, -0.0943924508],
    [-0.0159250101, -0.1478063681, 1.1638276817],
];

/**
 * Linear sRGB (D65) to AP0 (ACES2065-1)
 */
export const SRGB_TO_AP0: Matrix3x3 = [
    [0.4395722998, 0.3839185441, 0.1765091561],
    [0.0895766616, 0.8150065542, 0.0954167842],
    [0.0173096404, 0.1095964685, 0.8730938911],
];

/**
 * AP1 (ACEScg) to linear sRGB (D65)
 */
export const AP1_TO_SRGB: Matrix3x3 = [
    [1.7050509310, -0.6217921206, -0.0832588076],
    [-0.1302564175, 1.1408047365, -0.0105483190],
    [-0.0240033617, -0.1289689761, 1.1529723378],
];

/**
 * Linear sRGB (D65) to AP1 (ACEScg)
 */
export const SRGB_TO_AP1: Matrix3x3 = [
    [0.6130973875, 0.3395228678, 0.0473797447],
    [0.0701948181, 0.9163554907, 0.0134496912],
    [0.0206155355, 0.1095697761, 0.8698146884],
];

/**
 * 3x3 Identity matrix
 */
export const IDENTITY_3X3: Matrix3x3 = [
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
];

// =============================================================================
// Matrix Utilities
// =============================================================================

/**
 * Format matrix as GLSL mat3 constructor
 */
export function matrixToGlsl(matrix: Matrix3x3, name?: string): string {
    // Extract columns from row-major matrix for column-major GLSL constructor
    const col0 = [matrix[0][0], matrix[1][0], matrix[2][0]];
    const col1 = [matrix[0][1], matrix[1][1], matrix[2][1]];
    const col2 = [matrix[0][2], matrix[1][2], matrix[2][2]];
    const values = [...col0, ...col1, ...col2]
        .map(v => v.toFixed(10))
        .join(', ');

    if (name) {
        return `const mat3 ${name} = mat3(${values});`;
    }
    return `mat3(${values})`;
}

/**
 * Format matrix as WGSL mat3x3<f32> constructor
 */
export function matrixToWgsl(matrix: Matrix3x3, name?: string): string {
    const col0 = `vec3<f32>(${matrix[0][0].toFixed(10)}, ${matrix[1][0].toFixed(10)}, ${matrix[2][0].toFixed(10)})`;
    const col1 = `vec3<f32>(${matrix[0][1].toFixed(10)}, ${matrix[1][1].toFixed(10)}, ${matrix[2][1].toFixed(10)})`;
    const col2 = `vec3<f32>(${matrix[0][2].toFixed(10)}, ${matrix[1][2].toFixed(10)}, ${matrix[2][2].toFixed(10)})`;

    if (name) {
        return `const ${name}: mat3x3<f32> = mat3x3<f32>(${col0}, ${col1}, ${col2});`;
    }
    return `mat3x3<f32>(${col0}, ${col1}, ${col2})`;
}

/**
 * Get conversion matrix between color spaces
 */
export function getConversionMatrix(
    from: 'ACES2065-1' | 'ACEScg' | 'linear_sRGB',
    to: 'ACES2065-1' | 'ACEScg' | 'linear_sRGB'
): Matrix3x3 {
    if (from === to) {
        return IDENTITY_3X3;
    }

    if (from === 'ACES2065-1' && to === 'ACEScg') return AP0_TO_AP1;
    if (from === 'ACEScg' && to === 'ACES2065-1') return AP1_TO_AP0;
    if (from === 'ACES2065-1' && to === 'linear_sRGB') return AP0_TO_SRGB;
    if (from === 'linear_sRGB' && to === 'ACES2065-1') return SRGB_TO_AP0;
    if (from === 'ACEScg' && to === 'linear_sRGB') return AP1_TO_SRGB;
    if (from === 'linear_sRGB' && to === 'ACEScg') return SRGB_TO_AP1;

    return IDENTITY_3X3;
}

/**
 * Get the linear base color space for a log color space
 */
export function getLinearBase(cs: string): 'ACES2065-1' | 'ACEScg' | 'linear_sRGB' {
    if (cs === 'ACEScc' || cs === 'ACEScct') {
        return 'ACEScg';
    }
    return cs as 'ACES2065-1' | 'ACEScg' | 'linear_sRGB';
}

// =============================================================================
// GLSL Code Generation for Log Color Spaces
// =============================================================================

/**
 * Generate GLSL function for linear to ACEScc conversion
 */
export function generateLinToACESccGlsl(): string {
    return `
// Linear (AP1) to ACEScc
vec3 lin_to_ACEScc(vec3 lin) {
    vec3 result;
    for (int i = 0; i < 3; i++) {
        float x = lin[i];
        if (x <= 0.0) {
            result[i] = (log2(pow(2.0, -15.0)) + 9.72) / 17.52;
        } else if (x < pow(2.0, -15.0)) {
            result[i] = (log2(pow(2.0, -16.0) + x * 0.5) + 9.72) / 17.52;
        } else {
            result[i] = (log2(x) + 9.72) / 17.52;
        }
    }
    return result;
}`;
}

/**
 * Generate GLSL function for ACEScc to linear conversion
 */
export function generateACESccToLinGlsl(): string {
    return `
// ACEScc to Linear (AP1)
vec3 ACEScc_to_lin(vec3 cc) {
    vec3 result;
    for (int i = 0; i < 3; i++) {
        float x = cc[i];
        if (x < (9.72 - 15.0) / 17.52) {
            result[i] = (pow(2.0, x * 17.52 - 9.72) - pow(2.0, -16.0)) * 2.0;
        } else {
            result[i] = pow(2.0, x * 17.52 - 9.72);
        }
    }
    return result;
}`;
}

/**
 * Generate GLSL function for linear to ACEScct conversion
 */
export function generateLinToACEScctGlsl(): string {
    return `
// Linear (AP1) to ACEScct
vec3 lin_to_ACEScct(vec3 lin) {
    const float cut = 0.0078125;
    const float a = 10.5402377416545;
    const float b = 0.0729055341958355;

    vec3 result;
    for (int i = 0; i < 3; i++) {
        float x = lin[i];
        if (x <= cut) {
            result[i] = a * x + b;
        } else {
            result[i] = (log2(x) + 9.72) / 17.52;
        }
    }
    return result;
}`;
}

/**
 * Generate GLSL function for ACEScct to linear conversion
 */
export function generateACEScctToLinGlsl(): string {
    return `
// ACEScct to Linear (AP1)
vec3 ACEScct_to_lin(vec3 cct) {
    const float cut = 0.155251141552511;
    const float a = 10.5402377416545;
    const float b = 0.0729055341958355;

    vec3 result;
    for (int i = 0; i < 3; i++) {
        float x = cct[i];
        if (x <= cut) {
            result[i] = (x - b) / a;
        } else {
            result[i] = pow(2.0, x * 17.52 - 9.72);
        }
    }
    return result;
}`;
}
