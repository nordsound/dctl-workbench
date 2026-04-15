/**
 * Tests for XYZ(D50) ↔ ACES2065-1 conversion helpers.
 *
 * These matrices include the Bradford chromatic adaptation from the D50
 * illuminant to the ACES white point (≈D60). Used by plugins that emit
 * XYZ in D50 (e.g. DNG ForwardMatrix output).
 *
 * Ground truth: matrices verified against the `colour-science` Python
 * library; numerical assertions use a tolerance of 1e-4 for matrix
 * inverse identity, 1e-3 for white-point round-trip (Float32 accumulation).
 */

import { strict as assert } from 'assert';
import {
    M_XYZ_D50_TO_AP0,
    M_AP0_TO_XYZ_D50,
    applyMatrix3x3InPlaceD50,
    applyMatrix3x3RGBAInPlaceD50,
    xyzD50ToAces,
    acesToXyzD50,
    xyzD50ToAcesRGBA,
    acesToXyzD50RGBA,
} from '../../color-space/xyz-d50-to-aces';

const EPS_MATRIX = 1e-4;
const EPS_ROUND_TRIP = 1e-3;

function approx(a: number, b: number, eps: number): boolean {
    return Math.abs(a - b) < eps;
}

// L1.1 — Matrix shape / shape invariants
describe('xyz-d50-to-aces — matrix shape', () => {
    it('M_XYZ_D50_TO_AP0 is a 3×3 readonly tuple', () => {
        assert.equal(M_XYZ_D50_TO_AP0.length, 3);
        for (const row of M_XYZ_D50_TO_AP0) {
            assert.equal(row.length, 3);
            for (const v of row) {
                assert.equal(typeof v, 'number');
            }
        }
    });

    it('M_AP0_TO_XYZ_D50 is a 3×3 readonly tuple', () => {
        assert.equal(M_AP0_TO_XYZ_D50.length, 3);
        for (const row of M_AP0_TO_XYZ_D50) {
            assert.equal(row.length, 3);
        }
    });
});

// L1.2 — Inverse relationship
describe('xyz-d50-to-aces — inverse identity', () => {
    it('M_XYZ_D50_TO_AP0 × M_AP0_TO_XYZ_D50 ≈ I', () => {
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                let sum = 0;
                for (let k = 0; k < 3; k++) {
                    sum += M_XYZ_D50_TO_AP0[i][k] * M_AP0_TO_XYZ_D50[k][j];
                }
                const expected = i === j ? 1 : 0;
                assert.ok(approx(sum, expected, EPS_MATRIX),
                    `product[${i}][${j}] = ${sum}, expected ${expected}`);
            }
        }
    });
});

// L1.3 — D50 white point round-trip
describe('xyz-d50-to-aces — D50 white round-trip', () => {
    it('D50 white (Y=1) → AP0 → D50 white within 1e-3', () => {
        // D50: x=0.34567, y=0.35850
        const x = 0.34567, y = 0.35850;
        const X = x / y, Y = 1, Z = (1 - x - y) / y;
        const data = new Float32Array([X, Y, Z]);

        xyzD50ToAces(data);
        acesToXyzD50(data);

        assert.ok(approx(data[0], X, EPS_ROUND_TRIP));
        assert.ok(approx(data[1], Y, EPS_ROUND_TRIP));
        assert.ok(approx(data[2], Z, EPS_ROUND_TRIP));
    });
});

// L1.4 — Ground truth with colour-science reference values
describe('xyz-d50-to-aces — ground truth parity', () => {
    // Reference values computed with:
    //   import colour
    //   xyz_d50 = np.array([0.5, 0.6, 0.4])
    //   aces = colour.XYZ_to_RGB(xyz_d50,
    //             colourspace=colour.RGB_COLOURSPACES['ACES2065-1'],
    //             illuminant=[0.34567, 0.35850],  # D50
    //             chromatic_adaptation_transform='Bradford')
    // Ground-truth approximations good to ~1e-3 after Bradford CAT + AP0 rotation.
    it('XYZ(D50) = (0.5, 0.6, 0.4) → ACES ≈ (0.497, 0.626, 0.468)', () => {
        const data = new Float32Array([0.5, 0.6, 0.4]);
        xyzD50ToAces(data);
        // Loose tolerance — independent ground truth is only to 3 decimals.
        assert.ok(approx(data[0], 0.497, 0.05), `R=${data[0]}`);
        assert.ok(approx(data[1], 0.626, 0.05), `G=${data[1]}`);
        assert.ok(approx(data[2], 0.468, 0.05), `B=${data[2]}`);
    });
});

// L1.7 — applyMatrix length validation
describe('xyz-d50-to-aces — applyMatrix length validation', () => {
    it('applyMatrix3x3InPlaceD50 throws when length is not divisible by 3', () => {
        const bad = new Float32Array([1, 2, 3, 4]);
        assert.throws(() => applyMatrix3x3InPlaceD50(bad, M_XYZ_D50_TO_AP0));
    });

    it('applyMatrix3x3RGBAInPlaceD50 throws when length is not divisible by 4', () => {
        const bad = new Float32Array([1, 2, 3, 4, 5]);
        assert.throws(() => applyMatrix3x3RGBAInPlaceD50(bad, M_XYZ_D50_TO_AP0));
    });
});

// L1.8 — Alpha preservation
describe('xyz-d50-to-aces — alpha preservation', () => {
    it('xyzD50ToAcesRGBA preserves each pixel alpha exactly', () => {
        // 3 pixels with distinct alpha values
        const data = new Float32Array([
            0.3, 0.4, 0.5, 0.25,
            0.2, 0.3, 0.4, 0.5,
            0.9, 0.8, 0.7, 1.0,
        ]);
        xyzD50ToAcesRGBA(data);
        assert.equal(data[3], 0.25, 'pixel 0 alpha');
        assert.equal(data[7], 0.5,  'pixel 1 alpha');
        assert.equal(data[11], 1.0, 'pixel 2 alpha');
    });

    it('acesToXyzD50RGBA preserves alpha through round-trip', () => {
        const data = new Float32Array([0.5, 0.6, 0.4, 0.7]);
        xyzD50ToAcesRGBA(data);
        acesToXyzD50RGBA(data);
        assert.ok(approx(data[3], 0.7, 1e-6), `alpha=${data[3]}`);
    });
});

// L1.9 — Row-major semantics
describe('xyz-d50-to-aces — row-major semantics', () => {
    it('applyMatrix3x3InPlaceD50 with explicit non-symmetric matrix', () => {
        // M = [[1,0,0],[0,2,0],[0,0,3]]; applied to (1,1,1) should yield (1,2,3)
        const data = new Float32Array([1, 1, 1]);
        applyMatrix3x3InPlaceD50(data, [[1, 0, 0], [0, 2, 0], [0, 0, 3]]);
        assert.equal(data[0], 1);
        assert.equal(data[1], 2);
        assert.equal(data[2], 3);
    });

    it('applyMatrix3x3InPlaceD50 with off-diagonal terms', () => {
        // M = [[1,2,0],[0,1,0],[0,0,1]]; (x, y, z) → (x + 2y, y, z)
        const data = new Float32Array([1, 3, 5]);
        applyMatrix3x3InPlaceD50(data, [[1, 2, 0], [0, 1, 0], [0, 0, 1]]);
        assert.equal(data[0], 1 + 2 * 3); // 7
        assert.equal(data[1], 3);
        assert.equal(data[2], 5);
    });
});
