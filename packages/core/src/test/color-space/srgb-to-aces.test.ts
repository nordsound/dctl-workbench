/**
 * Tests for linear-sRGB (D65) ↔ ACES2065-1 conversion helpers.
 *
 * The matrices themselves (SRGB_TO_AP0 / AP0_TO_SRGB) live in the
 * existing color-space module. This file tests the in-place RGB /
 * RGBA helpers added for plugin-side color pipeline work.
 */

import { strict as assert } from 'assert';
import {
    M_SRGB_TO_AP0,
    M_AP0_TO_SRGB,
    applyMatrix3x3InPlaceSrgb,
    applyMatrix3x3RGBAInPlaceSrgb,
    srgbToAces,
    acesToSrgb,
    srgbToAcesRGBA,
    acesToSrgbRGBA,
} from '../../color-space/srgb-to-aces';

// sRGB ↔ AP0 matrices were pre-computed with 10 significant digits which
// yields inverse-product residuals up to ~1.5e-3 on the off-diagonals.
const EPS_MATRIX = 2e-3;
const EPS_ROUND_TRIP = 1e-3;

function approx(a: number, b: number, eps: number): boolean {
    return Math.abs(a - b) < eps;
}

describe('srgb-to-aces — matrix shape', () => {
    it('M_SRGB_TO_AP0 is a 3×3 tuple', () => {
        assert.equal(M_SRGB_TO_AP0.length, 3);
        for (const row of M_SRGB_TO_AP0) assert.equal(row.length, 3);
    });

    it('M_AP0_TO_SRGB is a 3×3 tuple', () => {
        assert.equal(M_AP0_TO_SRGB.length, 3);
        for (const row of M_AP0_TO_SRGB) assert.equal(row.length, 3);
    });
});

describe('srgb-to-aces — inverse identity', () => {
    it('M_SRGB_TO_AP0 × M_AP0_TO_SRGB ≈ I', () => {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                let sum = 0;
                for (let k = 0; k < 3; k++) {
                    sum += M_SRGB_TO_AP0[i][k] * M_AP0_TO_SRGB[k][j];
                }
                const expected = i === j ? 1 : 0;
                assert.ok(approx(sum, expected, EPS_MATRIX),
                    `product[${i}][${j}] = ${sum}, expected ${expected}`);
            }
        }
    });
});

describe('srgb-to-aces — white point mapping', () => {
    it('sRGB white (1, 1, 1) → ACES near (1, 1, 1)', () => {
        // Linear sRGB white D65 ≈ ACES white D60; round-trip through Bradford CAT
        // lands very close to (1, 1, 1) but not exactly (CAT is approximate).
        const data = new Float32Array([1, 1, 1]);
        srgbToAces(data);
        assert.ok(approx(data[0], 1, 0.02), `R=${data[0]}`);
        assert.ok(approx(data[1], 1, 0.02), `G=${data[1]}`);
        assert.ok(approx(data[2], 1, 0.02), `B=${data[2]}`);
    });

    it('sRGB (1, 1, 1) round-trip preserves value within 1e-3', () => {
        const data = new Float32Array([1, 1, 1]);
        srgbToAces(data);
        acesToSrgb(data);
        assert.ok(approx(data[0], 1, EPS_ROUND_TRIP));
        assert.ok(approx(data[1], 1, EPS_ROUND_TRIP));
        assert.ok(approx(data[2], 1, EPS_ROUND_TRIP));
    });
});

describe('srgb-to-aces — applyMatrix length validation', () => {
    it('applyMatrix3x3InPlaceSrgb throws when length is not divisible by 3', () => {
        const bad = new Float32Array([1, 2]);
        assert.throws(() => applyMatrix3x3InPlaceSrgb(bad, M_SRGB_TO_AP0));
    });

    it('applyMatrix3x3RGBAInPlaceSrgb throws when length is not divisible by 4', () => {
        const bad = new Float32Array([1, 2, 3]);
        assert.throws(() => applyMatrix3x3RGBAInPlaceSrgb(bad, M_SRGB_TO_AP0));
    });
});

describe('srgb-to-aces — alpha preservation', () => {
    it('srgbToAcesRGBA preserves alpha (Float32 precision)', () => {
        const data = new Float32Array([0.5, 0.5, 0.5, 0.42]);
        srgbToAcesRGBA(data);
        // Float32 cannot store 0.42 exactly — tolerance ~1 ULP.
        assert.ok(approx(data[3], 0.42, 1e-6));
    });

    it('RGBA round-trip preserves alpha within 1e-6', () => {
        const data = new Float32Array([0.3, 0.4, 0.5, 0.7]);
        srgbToAcesRGBA(data);
        acesToSrgbRGBA(data);
        assert.ok(approx(data[3], 0.7, 1e-6));
    });
});

describe('srgb-to-aces — row-major semantics', () => {
    it('applyMatrix3x3InPlaceSrgb scales independently per channel', () => {
        const data = new Float32Array([1, 1, 1]);
        applyMatrix3x3InPlaceSrgb(data, [[1, 0, 0], [0, 2, 0], [0, 0, 3]]);
        assert.deepEqual(Array.from(data), [1, 2, 3]);
    });
});
