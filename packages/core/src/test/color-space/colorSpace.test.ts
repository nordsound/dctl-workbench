/**
 * Color Space Module Unit Tests
 */

import { strict as assert } from 'assert';
import {
    linToACEScct,
    ACEScctToLin,
    applyMatrix3x3,
    ap0ToAp1,
    ap1ToAp0,
    isLogColorSpace,
    isAp1ColorSpace,
    AP0_TO_AP1_MATRIX,
    AP1_TO_AP0_MATRIX,
    COLOR_SPACE_INFO,
    matrixToGlsl,
    matrixToWgsl,
    getConversionMatrix,
    getLinearBase,
    generateLinToACESccGlsl,
    generateACESccToLinGlsl,
    generateLinToACEScctGlsl,
    generateACEScctToLinGlsl,
    IDENTITY_3X3,
    AP0_TO_AP1,
    AP1_TO_AP0,
} from '../../color-space/index';

describe('ACEScct Encoding/Decoding', () => {
    it('should encode mid-gray (0.18) to ~0.4135', () => {
        const result = linToACEScct(0.18);
        assert.ok(Math.abs(result - 0.4135) < 0.001, `Expected ~0.4135, got ${result}`);
    });

    it('should decode 0.4135 to ~0.18', () => {
        const result = ACEScctToLin(0.4135);
        assert.ok(Math.abs(result - 0.18) < 0.001, `Expected ~0.18, got ${result}`);
    });

    it('should handle linear portion (below cut)', () => {
        const x = 0.001;
        const encoded = linToACEScct(x);
        const decoded = ACEScctToLin(encoded);
        assert.ok(Math.abs(decoded - x) < 0.0001, `Roundtrip failed for ${x}`);
    });

    it('should handle log portion (above cut)', () => {
        const x = 1.0;
        const encoded = linToACEScct(x);
        const decoded = ACEScctToLin(encoded);
        assert.ok(Math.abs(decoded - x) < 0.0001, `Roundtrip failed for ${x}`);
    });

    it('should be invertible (roundtrip)', () => {
        const testValues = [0.0001, 0.01, 0.18, 0.5, 1.0, 2.0, 10.0];
        for (const x of testValues) {
            const encoded = linToACEScct(x);
            const decoded = ACEScctToLin(encoded);
            assert.ok(Math.abs(decoded - x) < 0.0001, `Roundtrip failed for ${x}: got ${decoded}`);
        }
    });

    it('should handle zero correctly', () => {
        const encoded = linToACEScct(0);
        assert.ok(encoded > 0, 'Encoded zero should be positive (linear portion)');
    });
});

describe('Matrix Operations', () => {
    it('should apply 3x3 matrix correctly', () => {
        const identity = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ];
        const result = applyMatrix3x3(identity, 0.5, 0.3, 0.2);
        assert.ok(Math.abs(result[0] - 0.5) < 0.0001);
        assert.ok(Math.abs(result[1] - 0.3) < 0.0001);
        assert.ok(Math.abs(result[2] - 0.2) < 0.0001);
    });

    it('should convert AP0 to AP1', () => {
        // Test that conversion produces valid output
        const result = ap0ToAp1(0.5, 0.3, 0.2);
        assert.equal(result.length, 3);
        // All values should be finite numbers
        assert.ok(Number.isFinite(result[0]));
        assert.ok(Number.isFinite(result[1]));
        assert.ok(Number.isFinite(result[2]));
    });

    it('should convert AP1 to AP0', () => {
        const result = ap1ToAp0(0.5, 0.3, 0.2);
        assert.equal(result.length, 3);
        assert.ok(Number.isFinite(result[0]));
        assert.ok(Number.isFinite(result[1]));
        assert.ok(Number.isFinite(result[2]));
    });

    it('should be invertible (AP0->AP1->AP0)', () => {
        const original: [number, number, number] = [0.5, 0.3, 0.2];
        const ap1 = ap0ToAp1(...original);
        const back = ap1ToAp0(...ap1);
        assert.ok(Math.abs(back[0] - original[0]) < 0.0001);
        assert.ok(Math.abs(back[1] - original[1]) < 0.0001);
        assert.ok(Math.abs(back[2] - original[2]) < 0.0001);
    });
});

describe('Color Space Info', () => {
    it('should correctly identify log color spaces', () => {
        assert.equal(isLogColorSpace('ACEScct'), true);
        assert.equal(isLogColorSpace('ACEScc'), true);
        assert.equal(isLogColorSpace('ACES2065-1'), false);
        assert.equal(isLogColorSpace('ACEScg'), false);
        assert.equal(isLogColorSpace('linear_sRGB'), false);
    });

    it('should correctly identify AP1 primaries', () => {
        assert.equal(isAp1ColorSpace('ACEScg'), true);
        assert.equal(isAp1ColorSpace('ACEScct'), true);
        assert.equal(isAp1ColorSpace('ACEScc'), true);
        assert.equal(isAp1ColorSpace('ACES2065-1'), false);
        assert.equal(isAp1ColorSpace('linear_sRGB'), false);
    });

    it('should have correct info for ACES2065-1', () => {
        const info = COLOR_SPACE_INFO['ACES2065-1'];
        assert.equal(info.isLinear, true);
        assert.equal(info.isLog, false);
        assert.equal(info.primaries, 'AP0');
    });

    it('should have correct info for ACEScct', () => {
        const info = COLOR_SPACE_INFO['ACEScct'];
        assert.equal(info.isLinear, false);
        assert.equal(info.isLog, true);
        assert.equal(info.primaries, 'AP1');
    });
});

describe('Matrix Constants', () => {
    it('should have WGSL format for AP0_TO_AP1', () => {
        assert.ok(AP0_TO_AP1_MATRIX.wgsl.includes('mat3x3<f32>'));
        assert.ok(AP0_TO_AP1_MATRIX.wgsl.includes('dctl_ap0ToWorking'));
    });

    it('should have GLSL format for AP0_TO_AP1', () => {
        assert.ok(AP0_TO_AP1_MATRIX.glsl.includes('mat3'));
        assert.ok(AP0_TO_AP1_MATRIX.glsl.includes('dctl_ap0ToWorking'));
    });

    it('should have numeric values for AP0_TO_AP1', () => {
        assert.equal(AP0_TO_AP1_MATRIX.values.length, 3);
        assert.equal(AP0_TO_AP1_MATRIX.values[0].length, 3);
    });

    it('should have WGSL format for AP1_TO_AP0', () => {
        assert.ok(AP1_TO_AP0_MATRIX.wgsl.includes('mat3x3<f32>'));
        assert.ok(AP1_TO_AP0_MATRIX.wgsl.includes('dctl_workingToAp0'));
    });
});

describe('matrixToGlsl', () => {
    it('should format matrix as GLSL mat3', () => {
        const result = matrixToGlsl(IDENTITY_3X3);
        assert.ok(result.includes('mat3('));
    });

    it('should include name when provided', () => {
        const result = matrixToGlsl(IDENTITY_3X3, 'myMatrix');
        assert.ok(result.includes('const mat3 myMatrix'));
    });

    it('should output correct values for AP0_TO_AP1', () => {
        const result = matrixToGlsl(AP0_TO_AP1);
        assert.ok(result.includes('1.4514393161'));
    });
});

describe('matrixToWgsl', () => {
    it('should format matrix as WGSL mat3x3<f32>', () => {
        const result = matrixToWgsl(IDENTITY_3X3);
        assert.ok(result.includes('mat3x3<f32>('));
        assert.ok(result.includes('vec3<f32>('));
    });

    it('should include name when provided', () => {
        const result = matrixToWgsl(IDENTITY_3X3, 'myMatrix');
        assert.ok(result.includes('const myMatrix: mat3x3<f32>'));
    });

    it('should output correct values for AP0_TO_AP1', () => {
        const result = matrixToWgsl(AP0_TO_AP1);
        assert.ok(result.includes('1.4514393161'));
    });
});

describe('getConversionMatrix', () => {
    it('should return identity for same color space', () => {
        const result = getConversionMatrix('ACES2065-1', 'ACES2065-1');
        assert.deepEqual(result, IDENTITY_3X3);
    });

    it('should return AP0_TO_AP1 for ACES2065-1 to ACEScg', () => {
        const result = getConversionMatrix('ACES2065-1', 'ACEScg');
        assert.deepEqual(result, AP0_TO_AP1);
    });

    it('should return AP1_TO_AP0 for ACEScg to ACES2065-1', () => {
        const result = getConversionMatrix('ACEScg', 'ACES2065-1');
        assert.deepEqual(result, AP1_TO_AP0);
    });

    it('should return matrix for ACES2065-1 to linear_sRGB', () => {
        const result = getConversionMatrix('ACES2065-1', 'linear_sRGB');
        assert.equal(result.length, 3);
        assert.equal(result[0].length, 3);
    });

    it('should return matrix for linear_sRGB to ACES2065-1', () => {
        const result = getConversionMatrix('linear_sRGB', 'ACES2065-1');
        assert.equal(result.length, 3);
    });

    it('should return matrix for ACEScg to linear_sRGB', () => {
        const result = getConversionMatrix('ACEScg', 'linear_sRGB');
        assert.equal(result.length, 3);
    });

    it('should return matrix for linear_sRGB to ACEScg', () => {
        const result = getConversionMatrix('linear_sRGB', 'ACEScg');
        assert.equal(result.length, 3);
    });
});

describe('getLinearBase', () => {
    it('should return ACEScg for ACEScc', () => {
        const result = getLinearBase('ACEScc');
        assert.equal(result, 'ACEScg');
    });

    it('should return ACEScg for ACEScct', () => {
        const result = getLinearBase('ACEScct');
        assert.equal(result, 'ACEScg');
    });

    it('should return same for linear color spaces', () => {
        assert.equal(getLinearBase('ACEScg'), 'ACEScg');
        assert.equal(getLinearBase('ACES2065-1'), 'ACES2065-1');
        assert.equal(getLinearBase('linear_sRGB'), 'linear_sRGB');
    });
});

describe('GLSL Generation Functions', () => {
    it('should generate ACEScc to linear GLSL', () => {
        const result = generateACESccToLinGlsl();
        assert.ok(result.includes('ACEScc_to_lin'));
        assert.ok(result.includes('vec3'));
        assert.ok(result.includes('pow(2.0,'));
    });

    it('should generate linear to ACEScc GLSL', () => {
        const result = generateLinToACESccGlsl();
        assert.ok(result.includes('lin_to_ACEScc'));
        assert.ok(result.includes('log2('));
    });

    it('should generate ACEScct to linear GLSL', () => {
        const result = generateACEScctToLinGlsl();
        assert.ok(result.includes('ACEScct_to_lin'));
        assert.ok(result.includes('0.155251141552511'));
    });

    it('should generate linear to ACEScct GLSL', () => {
        const result = generateLinToACEScctGlsl();
        assert.ok(result.includes('lin_to_ACEScct'));
        assert.ok(result.includes('0.0078125'));
    });
});
