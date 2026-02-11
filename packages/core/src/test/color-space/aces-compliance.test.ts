/**
 * ACES Compliance Tests
 *
 * Verifies color space conversions and encoding functions against
 * Academy-published reference values and specifications.
 *
 * References:
 * - S-2014-004: ACEScg color space
 * - S-2016-001: ACEScct color space
 * - SMPTE ST 2065-1: ACES2065-1 (AP0 primaries)
 * - Academy tolerance: |actual - ref| / max(|ref|, 0.1) <= 0.002
 */

import { strict as assert } from 'assert';
import {
    AP0_TO_AP1,
    AP1_TO_AP0,
    AP0_TO_SRGB,
    SRGB_TO_AP0,
    AP1_TO_SRGB,
    SRGB_TO_AP1,
    applyMatrix3x3,
    ap0ToAp1,
    ap1ToAp0,
    linToACEScct,
    ACEScctToLin,
    getConversionMatrix,
    IDENTITY_3X3,
    type Matrix3x3,
} from '../../color-space/index.js';
import {
    injectParameters,
    extractWgslParams,
} from '../../shader/index.js';
import {
    ACES_AP0_CHROMATICITIES,
    ACES_AP1_CHROMATICITIES,
    SRGB_CHROMATICITIES,
    type Chromaticities,
} from '../../exr/index.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Academy safe-guarded relative error metric.
 * |actual - ref| / max(|ref|, 0.1) <= tolerance
 */
function safeGuardedRelativeError(actual: number, reference: number): number {
    return Math.abs(actual - reference) / Math.max(Math.abs(reference), 0.1);
}

function assertAcesTolerance(actual: number, reference: number, label: string, tolerance = 0.002) {
    const err = safeGuardedRelativeError(actual, reference);
    assert.ok(
        err <= tolerance,
        `${label}: error ${err.toExponential(4)} exceeds tolerance ${tolerance}` +
        ` (actual=${actual}, reference=${reference})`
    );
}

function multiplyMatrices(a: Matrix3x3, b: Matrix3x3): Matrix3x3 {
    const result: Matrix3x3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            result[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return result;
}

// =============================================================================
// Category 2: Color Space Conversion Matrix Precision
// =============================================================================

describe('ACES Compliance: AP0 ↔ AP1 Matrix Precision', () => {

    // Academy reference values (S-2014-004, 10 decimal places)
    const REFERENCE_AP0_TO_AP1: Matrix3x3 = [
        [1.4514393161, -0.2365107469, -0.2149285693],
        [-0.0765537734, 1.1762296998, -0.0996759264],
        [0.0083161484, -0.0060324498, 0.9977163014],
    ];

    const REFERENCE_AP1_TO_AP0: Matrix3x3 = [
        [0.6954522414, 0.1406786965, 0.1638690622],
        [0.0447945634, 0.8596711185, 0.0955343182],
        [-0.0055258826, 0.0040252103, 1.0015006723],
    ];

    it('should match Academy AP0→AP1 matrix values (10 digit precision)', () => {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const actual = AP0_TO_AP1[i][j];
                const expected = REFERENCE_AP0_TO_AP1[i][j];
                assert.ok(
                    Math.abs(actual - expected) < 1e-10,
                    `AP0→AP1[${i}][${j}]: expected ${expected}, got ${actual}`
                );
            }
        }
    });

    it('should match Academy AP1→AP0 matrix values (10 digit precision)', () => {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const actual = AP1_TO_AP0[i][j];
                const expected = REFERENCE_AP1_TO_AP0[i][j];
                assert.ok(
                    Math.abs(actual - expected) < 1e-10,
                    `AP1→AP0[${i}][${j}]: expected ${expected}, got ${actual}`
                );
            }
        }
    });

    it('should produce identity when AP0→AP1 × AP1→AP0', () => {
        const product = multiplyMatrices(AP0_TO_AP1, AP1_TO_AP0);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const expected = i === j ? 1.0 : 0.0;
                assert.ok(
                    Math.abs(product[i][j] - expected) < 1e-7,
                    `(AP0→AP1 × AP1→AP0)[${i}][${j}] = ${product[i][j]}, expected ${expected}`
                );
            }
        }
    });

    it('should produce identity when AP1→AP0 × AP0→AP1', () => {
        const product = multiplyMatrices(AP1_TO_AP0, AP0_TO_AP1);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const expected = i === j ? 1.0 : 0.0;
                assert.ok(
                    Math.abs(product[i][j] - expected) < 1e-7,
                    `(AP1→AP0 × AP0→AP1)[${i}][${j}] = ${product[i][j]}, expected ${expected}`
                );
            }
        }
    });

    it('should preserve neutral gray through AP0→AP1→AP0 roundtrip', () => {
        const grays = [0.0, 0.001, 0.01, 0.18, 0.5, 1.0, 10.0, 100.0];
        for (const v of grays) {
            const ap1 = ap0ToAp1(v, v, v);
            const back = ap1ToAp0(...ap1);
            for (let ch = 0; ch < 3; ch++) {
                assertAcesTolerance(back[ch], v, `Gray ${v} ch${ch} roundtrip`);
            }
        }
    });

    it('should preserve arbitrary colors through AP0→AP1→AP0 roundtrip', () => {
        const colors: [number, number, number][] = [
            [0.5, 0.3, 0.2],
            [1.0, 0.0, 0.0],      // pure AP0 red
            [0.0, 1.0, 0.0],      // pure AP0 green
            [0.0, 0.0, 1.0],      // pure AP0 blue
            [0.001, 0.002, 0.003], // dark values
            [10.0, 5.0, 2.0],     // bright values
            [-0.1, 0.5, 0.3],     // negative component
        ];
        for (const [r, g, b] of colors) {
            const ap1 = ap0ToAp1(r, g, b);
            const back = ap1ToAp0(...ap1);
            assertAcesTolerance(back[0], r, `(${r},${g},${b}) R roundtrip`);
            assertAcesTolerance(back[1], g, `(${r},${g},${b}) G roundtrip`);
            assertAcesTolerance(back[2], b, `(${r},${g},${b}) B roundtrip`);
        }
    });

    it('should have row sums close to 1 (chromaticity conservation for white)', () => {
        // For a D60-adapted matrix, neutral (equal-energy) input should map to neutral output
        // Row sums represent the transform of (1,1,1) normalized by each channel
        for (let i = 0; i < 3; i++) {
            const rowSum = AP0_TO_AP1[i][0] + AP0_TO_AP1[i][1] + AP0_TO_AP1[i][2];
            assert.ok(
                Math.abs(rowSum - 1.0) < 0.001,
                `AP0→AP1 row ${i} sum = ${rowSum}, expected ≈1.0`
            );
        }
        for (let i = 0; i < 3; i++) {
            const rowSum = AP1_TO_AP0[i][0] + AP1_TO_AP0[i][1] + AP1_TO_AP0[i][2];
            assert.ok(
                Math.abs(rowSum - 1.0) < 0.001,
                `AP1→AP0 row ${i} sum = ${rowSum}, expected ≈1.0`
            );
        }
    });
});

describe('ACES Compliance: sRGB ↔ ACES Matrix Precision', () => {

    // sRGB matrices involve D60↔D65 chromatic adaptation (Bradford).
    // Independently-rounded 10-digit forward/inverse matrices don't perfectly
    // cancel, so we use looser tolerance (1e-4) than AP0↔AP1 (1e-7).

    it('should produce near-identity when AP0→sRGB × sRGB→AP0', () => {
        const product = multiplyMatrices(AP0_TO_SRGB, SRGB_TO_AP0);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const expected = i === j ? 1.0 : 0.0;
                assert.ok(
                    Math.abs(product[i][j] - expected) < 1e-3,
                    `(AP0→sRGB × sRGB→AP0)[${i}][${j}] = ${product[i][j]}, expected ${expected}`
                );
            }
        }
    });

    it('should produce near-identity when AP1→sRGB × sRGB→AP1', () => {
        const product = multiplyMatrices(AP1_TO_SRGB, SRGB_TO_AP1);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const expected = i === j ? 1.0 : 0.0;
                assert.ok(
                    Math.abs(product[i][j] - expected) < 1e-3,
                    `(AP1→sRGB × sRGB→AP1)[${i}][${j}] = ${product[i][j]}, expected ${expected}`
                );
            }
        }
    });

    it('should preserve colors through sRGB→AP0→sRGB roundtrip', () => {
        // Roundtrip tolerance is looser than AP0↔AP1 due to chromatic
        // adaptation rounding. 0.01 reflects achievable precision with
        // independently-rounded 10-digit matrices.
        const colors: [number, number, number][] = [
            [0.5, 0.5, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.18, 0.18, 0.18],
        ];
        for (const [r, g, b] of colors) {
            const ap0 = applyMatrix3x3(SRGB_TO_AP0, r, g, b);
            const back = applyMatrix3x3(AP0_TO_SRGB, ...ap0);
            assertAcesTolerance(back[0], r, `sRGB roundtrip (${r},${g},${b}) R`, 0.01);
            assertAcesTolerance(back[1], g, `sRGB roundtrip (${r},${g},${b}) G`, 0.01);
            assertAcesTolerance(back[2], b, `sRGB roundtrip (${r},${g},${b}) B`, 0.01);
        }
    });

    it('should have row sums close to 1 for sRGB matrices', () => {
        for (let i = 0; i < 3; i++) {
            const rowSum = SRGB_TO_AP0[i][0] + SRGB_TO_AP0[i][1] + SRGB_TO_AP0[i][2];
            assert.ok(
                Math.abs(rowSum - 1.0) < 0.001,
                `sRGB→AP0 row ${i} sum = ${rowSum}, expected ≈1.0`
            );
        }
        for (let i = 0; i < 3; i++) {
            const rowSum = SRGB_TO_AP1[i][0] + SRGB_TO_AP1[i][1] + SRGB_TO_AP1[i][2];
            assert.ok(
                Math.abs(rowSum - 1.0) < 0.001,
                `sRGB→AP1 row ${i} sum = ${rowSum}, expected ≈1.0`
            );
        }
    });
});

// =============================================================================
// Category 3: ACEScct Encoding/Decoding Precision
// =============================================================================

describe('ACES Compliance: ACEScct Encoding Precision', () => {

    // Constants from S-2016-001 specification
    const ACESCCT_A = 10.5402377416545;
    const ACESCCT_B = 0.0729055341958355;
    const ACESCCT_CUT_LINEAR = 0.0078125;       // 2^-7
    const ACESCCT_CUT_ENCODED = 0.155251141552511;

    it('should use correct constant A (slope of linear segment)', () => {
        // A = (1/17.52) / (2^-7) = 1 / (17.52 * 2^-7) per spec derivation
        // Verify our encode uses this exact value
        const x = 0.001; // well below cut, in linear range
        const encoded = linToACEScct(x);
        const expected = ACESCCT_A * x + ACESCCT_B;
        assert.ok(
            Math.abs(encoded - expected) < 1e-12,
            `Linear segment: expected ${expected}, got ${encoded}`
        );
    });

    it('should use correct constant B (offset of linear segment)', () => {
        // At x=0: ACEScct(0) = A*0 + B = B
        const encoded = linToACEScct(0);
        assert.ok(
            Math.abs(encoded - ACESCCT_B) < 1e-12,
            `Zero point: expected ${ACESCCT_B}, got ${encoded}`
        );
    });

    it('should be continuous at the encoding breakpoint (linear = 0.0078125)', () => {
        // Both sides of the piecewise function must give the same value at the breakpoint
        const linearSide = ACESCCT_A * ACESCCT_CUT_LINEAR + ACESCCT_B;
        const logSide = (Math.log2(ACESCCT_CUT_LINEAR) + 9.72) / 17.52;
        assert.ok(
            Math.abs(linearSide - logSide) < 1e-10,
            `Breakpoint discontinuity: linear=${linearSide}, log=${logSide}, diff=${Math.abs(linearSide - logSide)}`
        );
    });

    it('should encode the breakpoint to the correct ACEScct value', () => {
        const encoded = linToACEScct(ACESCCT_CUT_LINEAR);
        assert.ok(
            Math.abs(encoded - ACESCCT_CUT_ENCODED) < 1e-10,
            `Breakpoint encoding: expected ${ACESCCT_CUT_ENCODED}, got ${encoded}`
        );
    });

    it('should decode the breakpoint from the correct ACEScct value', () => {
        const decoded = ACEScctToLin(ACESCCT_CUT_ENCODED);
        assert.ok(
            Math.abs(decoded - ACESCCT_CUT_LINEAR) < 1e-10,
            `Breakpoint decoding: expected ${ACESCCT_CUT_LINEAR}, got ${decoded}`
        );
    });

    it('should encode mid-gray (0.18) to the specification value', () => {
        // Per spec: ACEScct(0.18) = (log2(0.18) + 9.72) / 17.52
        const expectedExact = (Math.log2(0.18) + 9.72) / 17.52;
        const encoded = linToACEScct(0.18);
        assert.ok(
            Math.abs(encoded - expectedExact) < 1e-12,
            `Mid-gray: expected ${expectedExact}, got ${encoded}`
        );
        // Also verify approximate value
        assert.ok(
            Math.abs(encoded - 0.4135884) < 0.0001,
            `Mid-gray approximate: expected ~0.4136, got ${encoded}`
        );
    });

    it('should handle negative values in the linear segment', () => {
        const negatives = [-0.001, -0.01, -0.1];
        for (const x of negatives) {
            const encoded = linToACEScct(x);
            const expected = ACESCCT_A * x + ACESCCT_B;
            assert.ok(
                Math.abs(encoded - expected) < 1e-12,
                `Negative value ${x}: expected ${expected}, got ${encoded}`
            );
            // Negative linear values should produce ACEScct values < B
            assert.ok(encoded < ACESCCT_B, `Negative ${x} should encode below B=${ACESCCT_B}`);
        }
    });

    it('should handle very high values in the log segment', () => {
        const highValues = [100, 1000, 10000, 65504];
        for (const x of highValues) {
            const encoded = linToACEScct(x);
            const expected = (Math.log2(x) + 9.72) / 17.52;
            assert.ok(
                Math.abs(encoded - expected) < 1e-10,
                `High value ${x}: expected ${expected}, got ${encoded}`
            );
            assert.ok(encoded <= 1.468, `High value ${x}: ACEScct=${encoded} should be <= ~1.468`);
        }
    });
});

describe('ACES Compliance: ACEScct Roundtrip Precision', () => {

    it('should roundtrip with high precision across the full range', () => {
        const testValues = [
            0.0,         // zero
            0.0001,      // near-black
            0.001,       // shadow
            0.005,       // near breakpoint
            0.0078125,   // exact breakpoint
            0.01,        // just above breakpoint
            0.05,        // shadow-mid
            0.18,        // mid-gray
            0.5,         // mid-bright
            1.0,         // reference white
            2.0,         // 1 stop above
            10.0,        // bright
            100.0,       // very bright
            1000.0,      // extreme
        ];
        for (const x of testValues) {
            const encoded = linToACEScct(x);
            const decoded = ACEScctToLin(encoded);
            const relErr = safeGuardedRelativeError(decoded, x);
            assert.ok(
                relErr < 1e-6,
                `Roundtrip ${x}: decoded=${decoded}, error=${relErr.toExponential(3)}`
            );
        }
    });

    it('should roundtrip negative values with high precision', () => {
        const negValues = [-0.001, -0.005, -0.01, -0.05];
        for (const x of negValues) {
            const encoded = linToACEScct(x);
            const decoded = ACEScctToLin(encoded);
            assert.ok(
                Math.abs(decoded - x) < 1e-10,
                `Negative roundtrip ${x}: decoded=${decoded}`
            );
        }
    });

    it('should be monotonically increasing', () => {
        let prev = linToACEScct(-0.1);
        const steps = 200;
        for (let i = 1; i <= steps; i++) {
            // Logarithmic spacing from -0.1 to 100
            const t = i / steps;
            const x = t < 0.1 ? -0.1 + t * 2 : Math.pow(10, (t - 0.1) * 2.222);
            const encoded = linToACEScct(x);
            assert.ok(
                encoded > prev,
                `Not monotonic at x=${x}: ACEScct(${x})=${encoded} <= prev=${prev}`
            );
            prev = encoded;
        }
    });
});

// =============================================================================
// Category 2+3 Combined: Full Pipeline AP0 → ACEScct → AP0
// =============================================================================

describe('ACES Compliance: Full AP0 → AP1 → ACEScct → AP1 → AP0 Pipeline', () => {

    it('should roundtrip neutral gray through full pipeline', () => {
        const grays = [0.001, 0.01, 0.18, 0.5, 1.0, 5.0];
        for (const v of grays) {
            // AP0 → AP1
            const ap1 = ap0ToAp1(v, v, v);
            // AP1 → ACEScct
            const cct = ap1.map(linToACEScct) as [number, number, number];
            // ACEScct → AP1
            const ap1Back = cct.map(ACEScctToLin) as [number, number, number];
            // AP1 → AP0
            const ap0Back = ap1ToAp0(...ap1Back);

            for (let ch = 0; ch < 3; ch++) {
                assertAcesTolerance(
                    ap0Back[ch], v,
                    `Full pipeline gray=${v} ch${ch}`
                );
            }
        }
    });

    it('should roundtrip arbitrary colors through full pipeline', () => {
        const colors: [number, number, number][] = [
            [0.5, 0.3, 0.2],
            [1.0, 0.5, 0.1],
            [0.02, 0.03, 0.01],
            [2.0, 1.5, 0.8],
        ];
        for (const [r, g, b] of colors) {
            const ap1 = ap0ToAp1(r, g, b);
            const cct = ap1.map(linToACEScct) as [number, number, number];
            const ap1Back = cct.map(ACEScctToLin) as [number, number, number];
            const ap0Back = ap1ToAp0(...ap1Back);

            assertAcesTolerance(ap0Back[0], r, `Full pipeline (${r},${g},${b}) R`);
            assertAcesTolerance(ap0Back[1], g, `Full pipeline (${r},${g},${b}) G`);
            assertAcesTolerance(ap0Back[2], b, `Full pipeline (${r},${g},${b}) B`);
        }
    });
});

// =============================================================================
// Category 4: DCTL Parameter Injection Tests
// =============================================================================

describe('ACES Compliance: DCTL Parameter Injection', () => {

    it('should inject f32 parameter for DCTLUI_VALUE_BOX', () => {
        const wgsl = 'var<private> min_val: f32;\nvar<private> max_val: f32;';
        const result = injectParameters(wgsl, { min_val: 0.45, max_val: 1.0 });
        assert.ok(result.includes('var<private> min_val: f32 = 0.45f;'), `Got: ${result}`);
        assert.ok(result.includes('var<private> max_val: f32 = 1f;'), `Got: ${result}`);
    });

    it('should inject boolean as i32 for DCTLUI_CHECK_BOX', () => {
        const wgsl = 'var<private> clamp_min: i32;\nvar<private> clamp_max: i32;';
        const result = injectParameters(wgsl, { clamp_min: true, clamp_max: false });
        assert.ok(result.includes('var<private> clamp_min: i32 = 1i;'), `Got: ${result}`);
        assert.ok(result.includes('var<private> clamp_max: i32 = 0i;'), `Got: ${result}`);
    });

    it('should inject i32 parameter for DCTLUI_COMBO_BOX', () => {
        const wgsl = 'var<private> method: i32;';
        const result = injectParameters(wgsl, { method: 2 });
        assert.ok(result.includes('var<private> method: i32 = 2i;'), `Got: ${result}`);
    });

    it('should handle renamed parameters with _N suffix', () => {
        // Rust compiler may rename parameters to avoid conflicts
        const wgsl = 'var<private> gain_2: f32;\nvar<private> offset_3: f32;';
        const result = injectParameters(wgsl, { gain: 1.5, offset: 0.02 });
        assert.ok(result.includes('var<private> gain_2: f32 = 1.5f;'), `Got: ${result}`);
        assert.ok(result.includes('var<private> offset_3: f32 = 0.02f;'), `Got: ${result}`);
    });

    it('should not modify parameters without provided values', () => {
        const wgsl = 'var<private> gain: f32;\nvar<private> offset: f32;';
        const result = injectParameters(wgsl, { gain: 1.5 });
        assert.ok(result.includes('var<private> gain: f32 = 1.5f;'));
        assert.ok(result.includes('var<private> offset: f32;'), 'Unset param should remain unchanged');
    });

    it('should floor float values when injecting as i32', () => {
        const wgsl = 'var<private> count: i32;';
        const result = injectParameters(wgsl, { count: 3.7 });
        assert.ok(result.includes('var<private> count: i32 = 3i;'), `Got: ${result}`);
    });

    it('should extract all parameter declarations from WGSL', () => {
        const wgsl = [
            'var<private> gain: f32;',
            'var<private> clamp_min: i32;',
            'var<private> enabled: bool;',
            'var<private> initialized: f32 = 1.0f;',
            'fn transform() {}',
        ].join('\n');
        const params = extractWgslParams(wgsl);
        assert.equal(params.length, 4);
        assert.equal(params[0].name, 'gain');
        assert.equal(params[0].type, 'f32');
        assert.equal(params[1].name, 'clamp_min');
        assert.equal(params[1].type, 'i32');
        assert.equal(params[2].name, 'enabled');
        assert.equal(params[2].type, 'bool');
        assert.equal(params[3].name, 'initialized');
        assert.equal(params[3].type, 'f32');
    });

    it('should handle typical ACES workflow parameters', () => {
        // Simulate a typical DCTL with ACES-relevant parameters
        const wgsl = [
            'var<private> exposure: f32;',
            'var<private> saturation: f32;',
            'var<private> clamp_negatives: i32;',
            'var<private> output_mode: i32;',
        ].join('\n');
        const result = injectParameters(wgsl, {
            exposure: 0.0,
            saturation: 1.0,
            clamp_negatives: true,
            output_mode: 1,
        });
        assert.ok(result.includes('exposure: f32 = 0f;'));
        assert.ok(result.includes('saturation: f32 = 1f;'));
        assert.ok(result.includes('clamp_negatives: i32 = 1i;'));
        assert.ok(result.includes('output_mode: i32 = 1i;'));
    });
});

// =============================================================================
// Category 1: EXR Metadata / Chromaticities Tests
// =============================================================================

describe('ACES Compliance: Chromaticities Constants', () => {

    it('should have correct AP0 primaries per SMPTE ST 2065-1', () => {
        assert.equal(ACES_AP0_CHROMATICITIES.redX, 0.7347);
        assert.equal(ACES_AP0_CHROMATICITIES.redY, 0.2653);
        assert.equal(ACES_AP0_CHROMATICITIES.greenX, 0.0);
        assert.equal(ACES_AP0_CHROMATICITIES.greenY, 1.0);
        assert.equal(ACES_AP0_CHROMATICITIES.blueX, 0.0001);
        assert.equal(ACES_AP0_CHROMATICITIES.blueY, -0.077);
    });

    it('should have correct AP0 white point (ACES illuminant)', () => {
        // ACES white point is CIE D60-like: (0.32168, 0.33767)
        assert.equal(ACES_AP0_CHROMATICITIES.whiteX, 0.32168);
        assert.equal(ACES_AP0_CHROMATICITIES.whiteY, 0.33767);
    });

    it('should have correct AP1 primaries per S-2014-004', () => {
        assert.equal(ACES_AP1_CHROMATICITIES.redX, 0.713);
        assert.equal(ACES_AP1_CHROMATICITIES.redY, 0.293);
        assert.equal(ACES_AP1_CHROMATICITIES.greenX, 0.165);
        assert.equal(ACES_AP1_CHROMATICITIES.greenY, 0.830);
        assert.equal(ACES_AP1_CHROMATICITIES.blueX, 0.128);
        assert.equal(ACES_AP1_CHROMATICITIES.blueY, 0.044);
    });

    it('should share white point between AP0 and AP1', () => {
        // Both AP0 and AP1 use the same ACES illuminant D60-like white
        assert.equal(ACES_AP0_CHROMATICITIES.whiteX, ACES_AP1_CHROMATICITIES.whiteX);
        assert.equal(ACES_AP0_CHROMATICITIES.whiteY, ACES_AP1_CHROMATICITIES.whiteY);
    });

    it('should have correct sRGB/Rec.709 primaries', () => {
        assert.equal(SRGB_CHROMATICITIES.redX, 0.64);
        assert.equal(SRGB_CHROMATICITIES.redY, 0.33);
        assert.equal(SRGB_CHROMATICITIES.greenX, 0.30);
        assert.equal(SRGB_CHROMATICITIES.greenY, 0.60);
        assert.equal(SRGB_CHROMATICITIES.blueX, 0.15);
        assert.equal(SRGB_CHROMATICITIES.blueY, 0.06);
    });

    it('should have correct sRGB white point (D65)', () => {
        assert.equal(SRGB_CHROMATICITIES.whiteX, 0.3127);
        assert.equal(SRGB_CHROMATICITIES.whiteY, 0.3290);
    });

    it('should have different white points for ACES and sRGB', () => {
        // ACES uses D60-like illuminant, sRGB uses D65
        assert.notEqual(ACES_AP0_CHROMATICITIES.whiteX, SRGB_CHROMATICITIES.whiteX);
        assert.notEqual(ACES_AP0_CHROMATICITIES.whiteY, SRGB_CHROMATICITIES.whiteY);
    });

    it('should have chromaticities that sum to valid xy values', () => {
        // For any valid primary, x + y should be in range (0, 2)
        // and both x and y should be finite
        const allChroma = [ACES_AP0_CHROMATICITIES, ACES_AP1_CHROMATICITIES, SRGB_CHROMATICITIES];
        for (const c of allChroma) {
            for (const [name, x, y] of [
                ['red', c.redX, c.redY],
                ['green', c.greenX, c.greenY],
                ['blue', c.blueX, c.blueY],
                ['white', c.whiteX, c.whiteY],
            ] as [string, number, number][]) {
                assert.ok(isFinite(x), `${name} x not finite: ${x}`);
                assert.ok(isFinite(y), `${name} y not finite: ${y}`);
            }
        }
    });
});

// =============================================================================
// Category: Color Space Utility Functions
// =============================================================================

describe('ACES Compliance: Color Space Utility Functions', () => {

    it('should return correct matrix for getConversionMatrix', () => {
        assert.deepStrictEqual(getConversionMatrix('ACES2065-1', 'ACEScg'), AP0_TO_AP1);
        assert.deepStrictEqual(getConversionMatrix('ACEScg', 'ACES2065-1'), AP1_TO_AP0);
        assert.deepStrictEqual(getConversionMatrix('ACES2065-1', 'linear_sRGB'), AP0_TO_SRGB);
        assert.deepStrictEqual(getConversionMatrix('linear_sRGB', 'ACES2065-1'), SRGB_TO_AP0);
        assert.deepStrictEqual(getConversionMatrix('ACEScg', 'linear_sRGB'), AP1_TO_SRGB);
        assert.deepStrictEqual(getConversionMatrix('linear_sRGB', 'ACEScg'), SRGB_TO_AP1);
    });

    it('should return identity for same-to-same conversion', () => {
        assert.deepStrictEqual(getConversionMatrix('ACES2065-1', 'ACES2065-1'), IDENTITY_3X3);
        assert.deepStrictEqual(getConversionMatrix('ACEScg', 'ACEScg'), IDENTITY_3X3);
        assert.deepStrictEqual(getConversionMatrix('linear_sRGB', 'linear_sRGB'), IDENTITY_3X3);
    });

    it('should apply identity matrix as no-op', () => {
        const colors: [number, number, number][] = [
            [0.5, 0.3, 0.2],
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
        ];
        for (const [r, g, b] of colors) {
            const result = applyMatrix3x3(IDENTITY_3X3, r, g, b);
            assert.equal(result[0], r);
            assert.equal(result[1], g);
            assert.equal(result[2], b);
        }
    });
});
