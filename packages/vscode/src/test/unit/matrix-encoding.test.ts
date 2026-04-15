/**
 * L5.b — tests for encoding a row-major 3×3 matrix into the layout that
 * a WGSL `mat3x3<f32>` uniform expects: column-major, each column padded
 * to 16 bytes (vec4 alignment). That's 12 f32 slots, not 9 — the 4th
 * element of each column is the padding byte group.
 *
 * Getting this wrong produces transposed or shifted colors downstream,
 * so the encoding needs to be covered in isolation before the GPU even
 * runs.
 */

import { strict as assert } from 'assert';
import {
    encodeMat3ForWgslUniform,
    encodeMat3ForGlslUniform,
} from '../../webview/shared/matrix-encoding';

describe('encodeMat3ForWgslUniform — layout', () => {
    it('produces a Float32Array of length 12 (3 columns × 4-slot stride)', () => {
        const out = encodeMat3ForWgslUniform([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
        ]);
        assert.ok(out instanceof Float32Array);
        assert.equal(out.length, 12);
    });

    it('writes the row-major input into column-major slots with padding', () => {
        // Row-major input:    [[1,2,3],[4,5,6],[7,8,9]]
        // Column-major output: col0=(1,4,7), col1=(2,5,8), col2=(3,6,9)
        // With 16-byte stride: [1,4,7,_, 2,5,8,_, 3,6,9,_]
        const out = encodeMat3ForWgslUniform([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
        ]);
        assert.equal(out[0], 1); assert.equal(out[1], 4); assert.equal(out[2], 7);
        assert.equal(out[4], 2); assert.equal(out[5], 5); assert.equal(out[6], 8);
        assert.equal(out[8], 3); assert.equal(out[9], 6); assert.equal(out[10], 9);
    });

    it('encodes identity as (1,0,0,_, 0,1,0,_, 0,0,1,_)', () => {
        const out = encodeMat3ForWgslUniform([
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ]);
        // Column 0 = (1, 0, 0)
        assert.equal(out[0], 1); assert.equal(out[1], 0); assert.equal(out[2], 0);
        // Column 1 = (0, 1, 0)
        assert.equal(out[4], 0); assert.equal(out[5], 1); assert.equal(out[6], 0);
        // Column 2 = (0, 0, 1)
        assert.equal(out[8], 0); assert.equal(out[9], 0); assert.equal(out[10], 1);
    });
});

describe('encodeMat3ForGlslUniform — layout', () => {
    // GLSL's `mat3` is column-major like WGSL, but tightly packed (no
    // vec4 padding). `uniformMatrix3fv(loc, false, encoded)` expects
    // exactly 9 floats in the order (col0.x,col0.y,col0.z, col1.x,...,col2.z).
    it('produces a Float32Array of length 9 (tight column-major, no padding)', () => {
        const out = encodeMat3ForGlslUniform([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
        ]);
        assert.ok(out instanceof Float32Array);
        assert.equal(out.length, 9);
    });

    it('writes the row-major input into column-major slots without padding', () => {
        // Row-major input:    [[1,2,3],[4,5,6],[7,8,9]]
        // Column-major output: col0=(1,4,7), col1=(2,5,8), col2=(3,6,9)
        const out = encodeMat3ForGlslUniform([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
        ]);
        assert.equal(out[0], 1); assert.equal(out[1], 4); assert.equal(out[2], 7);
        assert.equal(out[3], 2); assert.equal(out[4], 5); assert.equal(out[5], 8);
        assert.equal(out[6], 3); assert.equal(out[7], 6); assert.equal(out[8], 9);
    });

    it('encodes identity as (1,0,0, 0,1,0, 0,0,1)', () => {
        const out = encodeMat3ForGlslUniform([
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ]);
        const expected = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
        for (let i = 0; i < 9; i++) {
            assert.equal(out[i], expected[i], `slot ${i}: got ${out[i]} expected ${expected[i]}`);
        }
    });

    it('is exactly the WGSL encoding with padding slots (3, 7, 11) stripped', () => {
        // Invariant: GLSL and WGSL encode the same matrix identically
        // modulo padding. This pins down that both paths deliver the
        // same per-pixel transform to the shader.
        const matrix: readonly [
            readonly [number, number, number],
            readonly [number, number, number],
            readonly [number, number, number]
        ] = [
            [0.4395722998, 0.3839185441, 0.1765091561],
            [0.0895766616, 0.8150065542, 0.0954167842],
            [0.0173096404, 0.1095964685, 0.8730938911],
        ];
        const glsl = encodeMat3ForGlslUniform(matrix);
        const wgsl = encodeMat3ForWgslUniform(matrix);

        // Column 0: glsl[0..3] === wgsl[0..3]
        assert.equal(glsl[0], wgsl[0]);
        assert.equal(glsl[1], wgsl[1]);
        assert.equal(glsl[2], wgsl[2]);
        // Column 1: glsl[3..6] === wgsl[4..7]
        assert.equal(glsl[3], wgsl[4]);
        assert.equal(glsl[4], wgsl[5]);
        assert.equal(glsl[5], wgsl[6]);
        // Column 2: glsl[6..9] === wgsl[8..11]
        assert.equal(glsl[6], wgsl[8]);
        assert.equal(glsl[7], wgsl[9]);
        assert.equal(glsl[8], wgsl[10]);
    });
});
