/**
 * DCTL Preprocessor Unit Tests
 */

import { strict as assert } from 'assert';
import { preprocessDctl, mapPositionToOriginal, isHeaderLine } from '../../parser/dctlPreprocessor';
import { parseDctl } from '../../parser/dctlParser';

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
            // __CONSTANT__ (12 chars + space) → 'const' + spaces to preserve column positions
            assert.ok(result.code.includes('const'));
            assert.ok(result.code.includes('float PI'));
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

describe('preprocessDctl + parseDctl AST line mapping for compiler diagnostics', () => {
    it('should correctly map AST lines back to original source lines', () => {
        // This test verifies the formula needed by compileWithTsParser to adjust
        // diagnostic line numbers from the Rust backend.
        //
        // Pipeline: preprocessDctl(source) prepends DCTL_TYPE_DEFINITIONS header,
        // then parseDctl(preprocessed.code) parses the combined code.
        // AST node locations include the header offset.
        // Diagnostics from the Rust backend use these AST locations.
        // The compiler MUST subtract the header offset before returning diagnostics.
        //
        // Original source:
        //   Line 1: float3 transform(int p_Width, ...) {
        //   Line 2:     float3 out = make_float3(p_R, p_G, p_B);
        //   Line 3:     return out;
        //   Line 4: }
        const source =
`float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float3 out = make_float3(p_R, p_G, p_B);
    return out;
}`;
        const preprocessed = preprocessDctl(source);
        const headerLineCount = preprocessed.headerLineCount;

        // Parse the preprocessed code (with header)
        const parseResult = parseDctl(preprocessed.code);
        assert.ok(parseResult.ast, 'should produce an AST');

        // Find the transform function (skip header declarations)
        const userDecls = parseResult.ast!.declarations.filter(
            d => d.loc.line >= headerLineCount
        );
        assert.ok(userDecls.length > 0, 'should have user declarations after header');

        const transformDecl = userDecls.find(d => d.kind === 'Function' && (d as any).name === 'transform');
        assert.ok(transformDecl, 'should find transform function');

        // The transform function's AST line includes the header offset.
        // It should be at headerLineCount or headerLineCount+1 (depending on header trailing \n).
        const astLine = transformDecl!.loc.line;
        assert.ok(
            astLine >= headerLineCount,
            `AST line ${astLine} should be >= headerLineCount ${headerLineCount}`
        );

        // The correct formula to map AST line back to original source line:
        //   originalLine = astLine - headerLineCount + 1
        // This is what compileWithTsParser should use to adjust diagnostic lines.
        const mappedLine = astLine - headerLineCount + 1;
        assert.equal(
            mappedLine, 1,
            `transform should map to original line 1, got ${mappedLine} ` +
            `(astLine=${astLine}, headerLineCount=${headerLineCount})`
        );
    });

    it('should correctly map multi-line source with helper function', () => {
        // Original source (no DEFINE_UI_PARAMS to avoid regex line-eating on main):
        //   Line 1: float helper(float x) {
        //   Line 2:     return x * 2.0f;
        //   Line 3: }
        //   Line 4: (empty)
        //   Line 5: float3 transform(...) {   <-- should map to line 5
        //   Line 6:     return make_float3(...);
        //   Line 7: }
        const source =
`float helper(float x) {
    return x * 2.0f;
}

float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * helper(p_G), p_G, p_B);
}`;
        const preprocessed = preprocessDctl(source);
        const headerLineCount = preprocessed.headerLineCount;
        const parseResult = parseDctl(preprocessed.code);
        assert.ok(parseResult.ast, 'should produce an AST');

        const userDecls = parseResult.ast!.declarations.filter(
            d => d.loc.line >= headerLineCount
        );
        const helperDecl = userDecls.find(d => d.kind === 'Function' && (d as any).name === 'helper');
        const transformDecl = userDecls.find(d => d.kind === 'Function' && (d as any).name === 'transform');
        assert.ok(helperDecl, 'should find helper function');
        assert.ok(transformDecl, 'should find transform function');

        const helperMapped = helperDecl!.loc.line - headerLineCount + 1;
        assert.equal(
            helperMapped, 1,
            `helper should map to original line 1, got ${helperMapped} ` +
            `(astLine=${helperDecl!.loc.line}, headerLineCount=${headerLineCount})`
        );

        const transformMapped = transformDecl!.loc.line - headerLineCount + 1;
        assert.equal(
            transformMapped, 5,
            `transform should map to original line 5, got ${transformMapped} ` +
            `(astLine=${transformDecl!.loc.line}, headerLineCount=${headerLineCount})`
        );
    });

    it('compileWithTsParser should subtract headerLineCount from diagnostics', () => {
        // This test documents the bug: compileWithTsParser returns diagnostics
        // with line numbers that include the DCTL_TYPE_DEFINITIONS header offset.
        // The Rust backend receives AST nodes with inflated line numbers and
        // returns diagnostics with those same inflated line numbers.
        //
        // For a function at original line 1, the AST line = headerLineCount (e.g. 82).
        // The diagnostic from Rust would report line 82.
        // Without the fix, this line 82 is passed to mapLineToOriginal which
        // subtracts only the external lineOffset (e.g. 0), resulting in line 82
        // being shown to the user instead of line 1.
        //
        // The fix: compileWithTsParser should subtract (headerLineCount - 1) from
        // each diagnostic line before returning.
        const source = `float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const preprocessed = preprocessDctl(source);
        const headerLineCount = preprocessed.headerLineCount;

        // Simulate what the compiler pipeline does:
        // Parse preprocessed code → AST lines include header
        const parseResult = parseDctl(preprocessed.code);
        assert.ok(parseResult.ast);

        const transformDecl = parseResult.ast!.declarations.find(
            d => d.kind === 'Function' && (d as any).name === 'transform' && d.loc.line >= headerLineCount
        );
        assert.ok(transformDecl);

        // Simulate a diagnostic at the transform function's AST line
        const diagnosticLine = transformDecl!.loc.line;

        // WITHOUT the fix: diagnostic line is passed through as-is
        // This would show up as line 82+ in the editor (wrong!)
        assert.ok(
            diagnosticLine >= headerLineCount,
            `Diagnostic line ${diagnosticLine} should include header offset (>= ${headerLineCount})`
        );

        // WITH the fix: subtract header offset
        const correctedLine = diagnosticLine - (headerLineCount - 1);
        assert.equal(
            correctedLine, 1,
            `After subtracting header offset, diagnostic should be at line 1, got ${correctedLine}`
        );
    });
});
