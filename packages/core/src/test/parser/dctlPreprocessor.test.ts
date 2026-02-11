/**
 * DCTL Preprocessor Unit Tests
 */

import { strict as assert } from 'assert';
import { preprocessDctl, mapPositionToOriginal, isHeaderLine } from '../../parser/dctlPreprocessor';

describe('preprocessDctl', () => {
    describe('Macro Processing', () => {
        it('should expand object-like macros (#define NAME value)', () => {
            const source = `
#define PI 3.14159
float x = PI;
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('float x = 3.14159;'));
        });

        it('should expand function-like macros (#define NAME(x) x*2)', () => {
            const source = `
#define DOUBLE(x) x * 2
int y = DOUBLE(5);
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int y = 5 * 2;'));
        });

        it('should handle nested macro expansion', () => {
            const source = `
#define A 1
#define B A + 1
int x = B;
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int x = 1 + 1;'));
        });

        it('should handle #ifdef/#endif', () => {
            const source = `
#define FEATURE_ENABLED
#ifdef FEATURE_ENABLED
int feature = 1;
#endif
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int feature = 1;'));
            assert.ok(!result.code.includes('[excluded]'));
        });

        it('should handle #ifndef/#endif', () => {
            const source = `
#ifndef UNDEFINED_MACRO
int fallback = 1;
#endif
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int fallback = 1;'));
        });

        it('should handle #if 0/#if 1', () => {
            const source = `
#if 0
int disabled = 1;
#endif
#if 1
int enabled = 1;
#endif
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('[excluded] int disabled = 1;'));
            assert.ok(result.code.includes('int enabled = 1;'));
        });

        it('should handle #else', () => {
            const source = `
#ifdef UNDEFINED
int notThis = 1;
#else
int thisOne = 1;
#endif
`;
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('[excluded] int notThis = 1;'));
            assert.ok(result.code.includes('int thisOne = 1;'));
        });

        it('should handle line continuation (backslash)', () => {
            const source = `
#define MULTILINE x + \\
    y + \\
    z
int result = MULTILINE;
`;
            const result = preprocessDctl(source);
            // Line continuation joins with single space, verify expansion occurs
            assert.ok(result.code.includes('int result = x +'));
        });
    });

    describe('DCTL Transform', () => {
        it('should convert DEFINE_UI_PARAMS to variable declaration', () => {
            const source = 'DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('float gain;'));
            assert.ok(result.code.includes('[DCTL_MACRO] DEFINE_UI_PARAMS'));
        });

        it('should handle DCTL_SLIDER_INT', () => {
            const source = 'DEFINE_UI_PARAMS(iterations, Iterations, DCTL_SLIDER_INT, 5, 1, 20, 1)';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int iterations;'));
        });

        it('should handle DCTL_CHECK_BOX', () => {
            const source = 'DEFINE_UI_PARAMS(enable, Enable, DCTL_CHECK_BOX, 1)';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int enable;'));
        });

        it('should handle COMBO_BOX enum extraction', () => {
            const source = 'DEFINE_UI_PARAMS(mode, Mode, DCTL_COMBO_BOX, 0, {Linear, Cubic, Smooth})';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('int mode;'));
            assert.ok(result.code.includes('int Linear = 0;'));
            assert.ok(result.code.includes('int Cubic = 1;'));
            assert.ok(result.code.includes('int Smooth = 2;'));
        });

        it('should handle DCTL_COLOR_PICKER', () => {
            const source = 'DEFINE_UI_PARAMS(tint, Tint, DCTL_COLOR_PICKER, 1.0, 0.5, 0.25)';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('float3 tint;'));
        });

        it('should remove __DEVICE__ modifier', () => {
            const source = '__DEVICE__ float3 transform() { return make_float3(0,0,0); }';
            const result = preprocessDctl(source);
            assert.ok(!result.code.includes('__DEVICE__'));
            assert.ok(result.code.includes('float3 transform()'));
        });

        it('should convert __CONSTANT__ to const', () => {
            const source = '__CONSTANT__ float PI = 3.14159;';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('const float PI'));
        });

        it('should comment out DEFINE_UI_TOOLTIP', () => {
            const source = 'DEFINE_UI_TOOLTIP(gain, "Adjust the gain value")';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('// [DCTL_MACRO] DEFINE_UI_TOOLTIP'));
        });

        it('should comment out DEFINE_DCTL_ALPHA_MODE', () => {
            const source = 'DEFINE_DCTL_ALPHA_MODE_STRAIGHT';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('// [DCTL_MACRO] DEFINE_DCTL_ALPHA_MODE'));
        });
    });

    describe('Type Definitions', () => {
        it('should prepend type definitions header', () => {
            const source = 'float x = 1.0;';
            const result = preprocessDctl(source);
            assert.ok(result.code.includes('typedef struct { float x, y; } float2;'));
            assert.ok(result.code.includes('typedef struct { float x, y, z; } float3;'));
            assert.ok(result.code.includes('float3 make_float3(float x, float y, float z);'));
        });

        it('should have correct header line count', () => {
            const source = 'float x = 1.0;';
            const result = preprocessDctl(source);
            assert.ok(result.headerLineCount > 0);
        });

        it('should preserve original source', () => {
            const source = 'float x = 1.0;';
            const result = preprocessDctl(source);
            assert.equal(result.originalSource, source);
        });
    });
});

describe('mapPositionToOriginal', () => {
    it('should map preprocessed line to original line', () => {
        const source = 'float x = 1.0;';
        const result = preprocessDctl(source);

        const mapped = mapPositionToOriginal(result.headerLineCount + 1, 5, result);
        assert.equal(mapped.line, 1);
        assert.equal(mapped.column, 5);
    });

    it('should return line 0 for positions in header', () => {
        const source = 'float x = 1.0;';
        const result = preprocessDctl(source);

        const mapped = mapPositionToOriginal(5, 1, result);
        assert.equal(mapped.line, 0);
    });
});

describe('isHeaderLine', () => {
    it('should return true for lines in header', () => {
        const source = 'float x = 1.0;';
        const result = preprocessDctl(source);

        assert.equal(isHeaderLine(0, result), true);
        assert.equal(isHeaderLine(5, result), true);
    });

    it('should return false for lines after header', () => {
        const source = 'float x = 1.0;';
        const result = preprocessDctl(source);

        assert.equal(isHeaderLine(result.headerLineCount + 10, result), false);
    });
});
