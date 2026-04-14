/**
 * Tests for XYZ(D65) ↔ ACES2065-1 conversion helpers.
 * Ported from vscode-raw-viewer to support RAW input plugins (A7.5).
 */

import { strict as assert } from 'assert';
import {
    M_XYZ_D65_TO_AP0,
    M_AP0_TO_XYZ_D65,
    applyMatrix3x3InPlace,
    applyMatrix3x3RGBAInPlace,
    xyzD65ToAces,
    acesToXyzD65,
    xyzD65ToAcesRGBA,
    acesToXyzD65RGBA,
} from '../../color-space/xyz-to-aces';

const EPS = 1e-4;

function approx(a: number, b: number, eps = EPS): boolean {
    return Math.abs(a - b) < eps;
}

describe('xyz-to-aces', () => {
    describe('matrix inverse relationship', () => {
        it('M_XYZ_D65_TO_AP0 × M_AP0_TO_XYZ_D65 ≈ identity', () => {
            // Matrix product in row-major form
            const product: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    let sum = 0;
                    for (let k = 0; k < 3; k++) {
                        sum += M_XYZ_D65_TO_AP0[i][k] * M_AP0_TO_XYZ_D65[k][j];
                    }
                    product[i][j] = sum;
                }
            }
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    const expected = i === j ? 1 : 0;
                    assert.ok(approx(product[i][j], expected),
                        `product[${i}][${j}] = ${product[i][j]}, expected ≈ ${expected}`);
                }
            }
        });
    });

    describe('D65 white point round-trip', () => {
        it('XYZ(D65 white) → AP0 → XYZ(D65 white) ≈ original', () => {
            // D65 white point in XYZ (normalized Y=1)
            // x=0.31272, y=0.32903 → X = x/y, Y = 1, Z = (1-x-y)/y
            const x = 0.31272, y = 0.32903;
            const X = x / y;
            const Z = (1 - x - y) / y;
            const data = new Float32Array([X, 1, Z]);

            xyzD65ToAces(data);
            acesToXyzD65(data);

            assert.ok(approx(data[0], X, 1e-3), `round-trip X: ${data[0]} vs ${X}`);
            assert.ok(approx(data[1], 1, 1e-3), `round-trip Y: ${data[1]} vs 1`);
            assert.ok(approx(data[2], Z, 1e-3), `round-trip Z: ${data[2]} vs ${Z}`);
        });
    });

    describe('applyMatrix3x3InPlace', () => {
        it('handles an RGB buffer without touching the interleave', () => {
            const data = new Float32Array([
                1, 0, 0,
                0, 1, 0,
                0, 0, 1,
            ]);
            const identity: [
                [number, number, number],
                [number, number, number],
                [number, number, number]
            ] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            applyMatrix3x3InPlace(data, identity);
            assert.deepEqual(Array.from(data), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        });

        it('throws when the length is not divisible by 3', () => {
            const bad = new Float32Array([1, 2, 3, 4]);
            assert.throws(() => applyMatrix3x3InPlace(bad, M_XYZ_D65_TO_AP0));
        });
    });

    describe('applyMatrix3x3RGBAInPlace', () => {
        it('preserves alpha and transforms RGB', () => {
            // 2 pixels: red with alpha=0.5, blue with alpha=1.0
            const data = new Float32Array([1, 0, 0, 0.5, 0, 0, 1, 1.0]);
            const identity: [
                [number, number, number],
                [number, number, number],
                [number, number, number]
            ] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            applyMatrix3x3RGBAInPlace(data, identity);
            assert.equal(data[3], 0.5, 'alpha of pixel 0 preserved');
            assert.equal(data[7], 1.0, 'alpha of pixel 1 preserved');
        });

        it('throws when the length is not divisible by 4', () => {
            const bad = new Float32Array([1, 2, 3, 4, 5]);
            assert.throws(() => applyMatrix3x3RGBAInPlace(bad, M_XYZ_D65_TO_AP0));
        });
    });

    describe('xyzD65ToAcesRGBA / acesToXyzD65RGBA', () => {
        it('round-trip preserves alpha and ≈ original RGB', () => {
            const x = 0.31272, y = 0.32903;
            const X = x / y, Y = 1, Z = (1 - x - y) / y;
            const data = new Float32Array([X, Y, Z, 0.7]);

            xyzD65ToAcesRGBA(data);
            acesToXyzD65RGBA(data);

            assert.ok(approx(data[0], X, 1e-3));
            assert.ok(approx(data[1], Y, 1e-3));
            assert.ok(approx(data[2], Z, 1e-3));
            assert.ok(approx(data[3], 0.7, 1e-6), 'alpha preserved through round-trip');
        });
    });
});
