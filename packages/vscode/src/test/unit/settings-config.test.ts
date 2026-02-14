import * as assert from 'assert';
import { parseCompressionSetting, parseWorkingColorSpace, VALID_COLOR_SPACES } from '../../editor/settings-helpers';

describe('Settings Configuration', () => {
    describe('parseCompressionSetting', () => {
        it('should map NONE to Compression.NONE (0)', () => {
            assert.strictEqual(parseCompressionSetting('NONE'), 0);
        });

        it('should map RLE to Compression.RLE (1)', () => {
            assert.strictEqual(parseCompressionSetting('RLE'), 1);
        });

        it('should map ZIPS to Compression.ZIPS (2)', () => {
            assert.strictEqual(parseCompressionSetting('ZIPS'), 2);
        });

        it('should map ZIP to Compression.ZIP (3)', () => {
            assert.strictEqual(parseCompressionSetting('ZIP'), 3);
        });

        it('should map PIZ to Compression.PIZ (4)', () => {
            assert.strictEqual(parseCompressionSetting('PIZ'), 4);
        });

        it('should map PXR24 to Compression.PXR24 (5)', () => {
            assert.strictEqual(parseCompressionSetting('PXR24'), 5);
        });

        it('should map B44 to Compression.B44 (6)', () => {
            assert.strictEqual(parseCompressionSetting('B44'), 6);
        });

        it('should map B44A to Compression.B44A (7)', () => {
            assert.strictEqual(parseCompressionSetting('B44A'), 7);
        });

        it('should map DWAA to Compression.DWAA (8)', () => {
            assert.strictEqual(parseCompressionSetting('DWAA'), 8);
        });

        it('should map DWAB to Compression.DWAB (9)', () => {
            assert.strictEqual(parseCompressionSetting('DWAB'), 9);
        });

        it('should fall back to PIZ for invalid input', () => {
            assert.strictEqual(parseCompressionSetting('INVALID'), 4);
        });

        it('should fall back to PIZ for empty string', () => {
            assert.strictEqual(parseCompressionSetting(''), 4);
        });
    });

    describe('parseWorkingColorSpace', () => {
        it('should return ACES2065-1 as-is', () => {
            assert.strictEqual(parseWorkingColorSpace('ACES2065-1'), 'ACES2065-1');
        });

        it('should return ACEScg as-is', () => {
            assert.strictEqual(parseWorkingColorSpace('ACEScg'), 'ACEScg');
        });

        it('should return ACEScc as-is', () => {
            assert.strictEqual(parseWorkingColorSpace('ACEScc'), 'ACEScc');
        });

        it('should return ACEScct as-is', () => {
            assert.strictEqual(parseWorkingColorSpace('ACEScct'), 'ACEScct');
        });

        it('should return linear_sRGB as-is', () => {
            assert.strictEqual(parseWorkingColorSpace('linear_sRGB'), 'linear_sRGB');
        });

        it('should fall back to ACEScct for invalid input', () => {
            assert.strictEqual(parseWorkingColorSpace('invalid'), 'ACEScct');
        });

        it('should fall back to ACEScct for empty string', () => {
            assert.strictEqual(parseWorkingColorSpace(''), 'ACEScct');
        });
    });

    describe('VALID_COLOR_SPACES', () => {
        it('should contain all 5 DctlColorSpace values', () => {
            assert.strictEqual(VALID_COLOR_SPACES.length, 5);
            assert.ok(VALID_COLOR_SPACES.includes('ACES2065-1'));
            assert.ok(VALID_COLOR_SPACES.includes('ACEScg'));
            assert.ok(VALID_COLOR_SPACES.includes('ACEScc'));
            assert.ok(VALID_COLOR_SPACES.includes('ACEScct'));
            assert.ok(VALID_COLOR_SPACES.includes('linear_sRGB'));
        });
    });
});
