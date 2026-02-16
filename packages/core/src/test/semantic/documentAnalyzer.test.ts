/**
 * Document Analyzer Tests
 */

import { strict as assert } from 'assert';
import { analyzeDocument, getMemberCompletions } from '../../semantic/documentAnalyzer';
import { SymbolTable } from '../../semantic/symbolTable';

describe('analyzeDocument', () => {
    it('should extract UI parameter variables', () => {
        const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
DEFINE_UI_PARAMS(mode, "Mode", DCTLUI_SLIDER_INT, 0, 0, 3, 1)
DEFINE_UI_PARAMS(enabled, "Enable", DCTLUI_CHECK_BOX, 1)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = p_R * gain;
    return make_float3(r, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        const gainSym = result.symbols.find(s => s.name === 'gain');
        assert.ok(gainSym, 'gain symbol should exist');
        assert.equal(gainSym.kind, 'variable');
        assert.equal(gainSym.type, 'float');

        const modeSym = result.symbols.find(s => s.name === 'mode');
        assert.ok(modeSym, 'mode symbol should exist');
        assert.equal(modeSym.type, 'int');

        const enabledSym = result.symbols.find(s => s.name === 'enabled');
        assert.ok(enabledSym, 'enabled symbol should exist');
        assert.equal(enabledSym.type, 'int');
    });

    it('should extract user-defined functions', () => {
        const source = `
__DEVICE__ float3 applyGain(float3 rgb, float g) {
    return make_float3(rgb.x * g, rgb.y * g, rgb.z * g);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return applyGain(make_float3(p_R, p_G, p_B), 1.0f);
}`;
        const result = analyzeDocument(source);

        const applyGainSym = result.symbols.find(s => s.name === 'applyGain');
        assert.ok(applyGainSym, 'applyGain should be found');
        assert.equal(applyGainSym.kind, 'function');
        assert.equal(applyGainSym.type, 'float3');
        assert.ok(applyGainSym.detail?.includes('float3 rgb'));
        assert.ok(applyGainSym.detail?.includes('float g'));
    });

    it('should extract user-defined variables (global)', () => {
        const source = `
float globalGain = 1.5f;

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * globalGain, p_G * globalGain, p_B * globalGain);
}`;
        const result = analyzeDocument(source);

        const globalGainSym = result.symbols.find(s => s.name === 'globalGain');
        assert.ok(globalGainSym, 'globalGain should be found');
        assert.equal(globalGainSym.kind, 'variable');
        assert.equal(globalGainSym.type, 'float');
    });

    it('should extract struct definitions', () => {
        const source = `
struct MyColor {
    float r;
    float g;
    float b;
};

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        // Filter out header-generated structs (float2, float3, etc.)
        const userStructs = result.symbols.filter(s => s.kind === 'struct');
        const myColorStruct = userStructs.find(s => s.name === 'MyColor');
        assert.ok(myColorStruct, 'MyColor struct should exist');
        assert.ok(myColorStruct.detail?.includes('float r'), `expected 'float r' in detail: ${myColorStruct.detail}`);
        assert.ok(myColorStruct.detail?.includes('float g'));
        assert.ok(myColorStruct.detail?.includes('float b'));
    });

    it('should extract COMBO_BOX enum options as variables', () => {
        const source = `
DEFINE_UI_PARAMS(cs, "Color Space", DCTLUI_COMBO_BOX, 0, {ap0, ap1, p3d65}, {AP0, AP1, P3-D65})

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        // COMBO_BOX main variable
        const csSym = result.symbols.find(s => s.name === 'cs');
        assert.ok(csSym, 'cs variable should exist');
        assert.equal(csSym.type, 'int');

        // COMBO_BOX options are generated as int variables by the preprocessor
        const ap0Sym = result.symbols.find(s => s.name === 'ap0');
        assert.ok(ap0Sym, 'ap0 should exist');
        assert.equal(ap0Sym.type, 'int');

        const ap1Sym = result.symbols.find(s => s.name === 'ap1');
        assert.ok(ap1Sym, 'ap1 should exist');

        const p3d65Sym = result.symbols.find(s => s.name === 'p3d65');
        assert.ok(p3d65Sym, 'p3d65 should exist');
    });

    it('should not include builtin functions in user symbols', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = _fabs(p_R);
    float g = _powf(p_G, 2.2f);
    return make_float3(r, g, p_B);
}`;
        const result = analyzeDocument(source);

        const fabsSym = result.symbols.find(s => s.name === '_fabs');
        assert.ok(!fabsSym, '_fabs should NOT be in user symbols');

        const powfSym = result.symbols.find(s => s.name === '_powf');
        assert.ok(!powfSym, '_powf should NOT be in user symbols');

        const makeFloat3Sym = result.symbols.find(s => s.name === 'make_float3');
        assert.ok(!makeFloat3Sym, 'make_float3 should NOT be in user symbols');
    });

    it('should include function parameters in symbols list', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        const pWidth = result.symbols.find(s => s.name === 'p_Width');
        assert.ok(pWidth, 'p_Width should be in symbols');
        assert.equal(pWidth.kind, 'parameter');
        assert.equal(pWidth.type, 'int');

        const pR = result.symbols.find(s => s.name === 'p_R');
        assert.ok(pR, 'p_R should be in symbols');
        assert.equal(pR.kind, 'parameter');
        assert.equal(pR.type, 'float');
    });

    it('should include local variables in symbols list', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float3 color = make_float3(p_R, p_G, p_B);
    float luminance = 0.5f;
    return color;
}`;
        const result = analyzeDocument(source);

        const color = result.symbols.find(s => s.name === 'color');
        assert.ok(color, 'color should be in symbols');
        assert.equal(color.kind, 'variable');
        assert.equal(color.type, 'float3');

        const luminance = result.symbols.find(s => s.name === 'luminance');
        assert.ok(luminance, 'luminance should be in symbols');
        assert.equal(luminance.type, 'float');
    });

    it('should include function parameters in variableTypes', () => {
        const source = `
__DEVICE__ float3 applyGain(float3 rgb, float g) {
    return make_float3(rgb.x * g, rgb.y * g, rgb.z * g);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return applyGain(make_float3(p_R, p_G, p_B), 1.0f);
}`;
        const result = analyzeDocument(source);

        // Function parameters should be in variableTypes for member completion
        assert.equal(result.variableTypes.get('rgb'), 'float3');
        assert.equal(result.variableTypes.get('g'), 'float');
        assert.equal(result.variableTypes.get('p_R'), 'float');
        assert.equal(result.variableTypes.get('p_G'), 'float');
    });

    it('should include local variables in variableTypes', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float3 color = make_float3(p_R, p_G, p_B);
    float luminance = 0.5f;
    return color;
}`;
        const result = analyzeDocument(source);

        assert.equal(result.variableTypes.get('color'), 'float3');
        assert.equal(result.variableTypes.get('luminance'), 'float');
    });

    it('should include global variables in variableTypes', () => {
        const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
float3 globalColor = make_float3(1.0f, 0.5f, 0.0f);

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return globalColor;
}`;
        const result = analyzeDocument(source);

        assert.equal(result.variableTypes.get('globalColor'), 'float3');
        assert.equal(result.variableTypes.get('gain'), 'float');
    });

    it('should handle parse errors gracefully', () => {
        const source = `
this is not valid DCTL at all {{{
`;
        const result = analyzeDocument(source);

        // Should not throw, should return empty or partial results
        assert.ok(result);
        assert.ok(Array.isArray(result.symbols));
    });

    it('should handle empty source', () => {
        const result = analyzeDocument('');
        assert.ok(result);
        assert.ok(Array.isArray(result.symbols));
    });
});

describe('analyzeDocument warnings', () => {
    it('should warn about unused variables (SEM_W002)', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        assert.ok(result.warnings, 'warnings should exist on result');
        const unusedWarning = result.warnings.find(w => w.code === 'SEM_W002' && w.message.includes('unused'));
        assert.ok(unusedWarning, 'should have SEM_W002 warning for unused variable');
    });

    it('should warn about unused functions (SEM_W003)', () => {
        const source = `
__DEVICE__ float helper(float x) {
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        assert.ok(result.warnings, 'warnings should exist on result');
        const unusedFnWarning = result.warnings.find(w => w.code === 'SEM_W003' && w.message.includes('helper'));
        assert.ok(unusedFnWarning, 'should have SEM_W003 warning for unused function');
    });

    it('should not warn about p_ prefixed parameters', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        assert.ok(result.warnings, 'warnings should exist on result');
        const pWidthWarning = result.warnings.find(w => w.message.includes('p_Width'));
        assert.ok(!pWidthWarning, 'p_Width should not trigger unused warning');
        const pHeightWarning = result.warnings.find(w => w.message.includes('p_Height'));
        assert.ok(!pHeightWarning, 'p_Height should not trigger unused warning');
    });

    it('should not warn about entry point functions', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        assert.ok(result.warnings, 'warnings should exist on result');
        const transformWarning = result.warnings.find(w => w.message.includes('transform'));
        assert.ok(!transformWarning, 'transform should not trigger unused function warning');
    });

    it('should not warn about builtin symbols', () => {
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        assert.ok(result.warnings, 'warnings should exist on result');
        const builtinWarning = result.warnings.find(w => w.message.includes('make_float3'));
        assert.ok(!builtinWarning, 'builtin functions should not trigger warnings');
    });

    it('should map warning lines to original source', () => {
        const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R * gain, p_G, p_B);
}`;
        const result = analyzeDocument(source);

        assert.ok(result.warnings, 'warnings should exist on result');
        const unusedWarning = result.warnings.find(w => w.code === 'SEM_W002' && w.message.includes('unused'));
        assert.ok(unusedWarning, 'should have warning for unused variable');
        // Line 5 in original source (after DEFINE_UI_PARAMS line)
        assert.ok(unusedWarning.line > 0, 'warning line should be positive');
    });
});

describe('analyzeDocument warning line mapping', () => {
    it('should report correct line without macros', () => {
        // Line 1: '' (empty from template literal)
        // Line 2: __DEVICE__ float3 transform(...) {
        // Line 3:     float unused = 1.0f;    <-- expected warning
        // Line 4:     return make_float3(...);
        // Line 5: }
        const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.message.includes('unused'));
        assert.ok(w, 'should have warning for unused variable');
        assert.equal(w.line, 3, `unused should be at original line 3, got ${w.line}`);
    });

    it('should report correct line with single DEFINE_UI_PARAMS', () => {
        // Line 1: '' (empty)
        // Line 2: DEFINE_UI_PARAMS(gain, ...)
        // Line 3: '' (empty)
        // Line 4: __DEVICE__ float3 transform(...) {
        // Line 5:     float unused = 1.0f;    <-- expected warning
        // Line 6:     return make_float3(...);
        // Line 7: }
        const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R * gain, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.message.includes('unused'));
        assert.ok(w, 'should have warning for unused variable');
        assert.equal(w.line, 5, `unused should be at original line 5, got ${w.line}`);
    });

    it('should report correct line with multiple DEFINE_UI_PARAMS', () => {
        // Line 1: '' (empty)
        // Line 2: DEFINE_UI_PARAMS(gain, ...)
        // Line 3: DEFINE_UI_PARAMS(offset, ...)
        // Line 4: '' (empty)
        // Line 5: __DEVICE__ float3 transform(...) {
        // Line 6:     float unused = 1.0f;    <-- expected warning
        // Line 7:     return make_float3(...);
        // Line 8: }
        const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
DEFINE_UI_PARAMS(offset, "Offset", DCTLUI_SLIDER_FLOAT, 0.0, -1.0, 1.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R * gain + offset, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.message.includes('unused'));
        assert.ok(w, 'should have warning for unused variable');
        assert.equal(w.line, 6, `unused should be at original line 6, got ${w.line}`);
    });

    it('should report correct line with COMBO_BOX (extra generated lines)', () => {
        // Line 1: '' (empty)
        // Line 2: DEFINE_UI_PARAMS(mode, ..., COMBO_BOX, ...)  <-- generates 3 extra enum lines
        // Line 3: '' (empty)
        // Line 4: __DEVICE__ float3 transform(...) {
        // Line 5:     float unused = 1.0f;    <-- expected warning
        // Line 6:     return make_float3(...);
        // Line 7: }
        const source = `
DEFINE_UI_PARAMS(mode, "Mode", DCTLUI_COMBO_BOX, 0, {linear, log, gamma}, {Linear, Log, Gamma})

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.message.includes('unused'));
        assert.ok(w, 'should have warning for unused variable');
        assert.equal(w.line, 5, `unused should be at original line 5 (COMBO_BOX should not shift lines), got ${w.line}`);
    });

    it('should report correct line with #define macros', () => {
        // Line 1: '' (empty)
        // Line 2: #define MULTIPLIER 2.0f   <-- replaced with // comment, line count preserved
        // Line 3: '' (empty)
        // Line 4: __DEVICE__ float3 transform(...) {
        // Line 5:     float unused = 1.0f;    <-- expected warning
        // Line 6:     return make_float3(...);
        // Line 7: }
        const source = `
#define MULTIPLIER 2.0f

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R * MULTIPLIER, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.message.includes('unused'));
        assert.ok(w, 'should have warning for unused variable');
        assert.equal(w.line, 5, `unused should be at original line 5, got ${w.line}`);
    });

    it('should report correct line with #ifdef block', () => {
        // Line 1: '' (empty)
        // Line 2: #ifdef SOME_FLAG         <-- replaced with // comment
        // Line 3: int extra = 42;           <-- replaced with // [excluded]
        // Line 4: #endif                    <-- replaced with // comment
        // Line 5: '' (empty)
        // Line 6: __DEVICE__ float3 transform(...) {
        // Line 7:     float unused = 1.0f;    <-- expected warning
        // Line 8:     return make_float3(...);
        // Line 9: }
        const source = `
#ifdef SOME_FLAG
int extra = 42;
#endif

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.message.includes('unused'));
        assert.ok(w, 'should have warning for unused variable');
        assert.equal(w.line, 7, `unused should be at original line 7, got ${w.line}`);
    });

    it('should report correct line for unused function with DEFINE_UI_PARAMS', () => {
        // Line 1: '' (empty)
        // Line 2: DEFINE_UI_PARAMS(gain, ...)
        // Line 3: '' (empty)
        // Line 4: __DEVICE__ float helper(float x) {    <-- expected warning (SEM_W003)
        // Line 5:     return x * 2.0f;
        // Line 6: }
        // Line 7: '' (empty)
        // Line 8: __DEVICE__ float3 transform(...) {
        // Line 9:     return make_float3(...);
        // Line 10: }
        const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float helper(float x) {
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.code === 'SEM_W003' && w.message.includes('helper'));
        assert.ok(w, 'should have SEM_W003 warning for unused function');
        assert.equal(w.line, 4, `helper should be at original line 4, got ${w.line}`);
    });

    it('should report correct column for unused function with __DEVICE__', () => {
        // __DEVICE__ is stripped by preprocessor, shifting columns.
        // Warning column should match the ORIGINAL source position.
        //
        // Original line 15 of 05_random_noise.dctl:
        //   __DEVICE__ float sst(int x) {
        //   ^1        ^11  ^17 ^18
        //   __DEVICE__ = 10 chars, space = 1, float = 5, space = 1 → sst starts at column 18
        //
        // After preprocessing: "float sst(int x) {"
        //   sst starts at column 7 (wrong!)
        const source = `
__DEVICE__ float sst(int x) {
    int y = x + 1;
    return y;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.code === 'SEM_W003' && w.message.includes('sst'));
        assert.ok(w, 'should have SEM_W003 warning for unused function sst');
        // sst starts at column 18 in original source (after "__DEVICE__ float ")
        assert.equal(w.column, 18, `sst column should be 18 in original source, got ${w.column}`);
    });

    it('should report correct column for unused variable with __DEVICE__', () => {
        // In the function body, local variables are not affected by __DEVICE__ removal
        // because __DEVICE__ only appears on the function signature line.
        // But the variable declaration column should still be correct.
        //
        // Line: "    float unused = 1.0f;"
        //        ^1   ^5              → "unused" is at column 5 (indentation) + "float " = column 11
        //   Actually: 4 spaces + "float " = 4+6 = column 11 for "unused"
        //   Wait - the preprocessor doesn't affect lines without __DEVICE__.
        //   So columns of local variables should already be correct.
        //   Let's verify that and also check a function on a line with __DEVICE__.
        const source = `
DEFINE_UI_PARAMS(noise_amount, Noise Amount, DCTL_SLIDER_FLOAT, 0.5, 0.0, 1.0, 0.01)
DEFINE_UI_PARAMS(seed, Seed, DCTL_SLIDER_INT, 0, 0, 1000, 1)

__DEVICE__ float hash(int x, int y, int s) {
    int n = x + y * 57 + s * 131;
    n = (n << 13) ^ n;
    return (1.0f - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0f) * 0.5f + 0.5f;
}

__DEVICE__ float sst(int x) {
    int y = x + 1;
    return y;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    float noise = hash(p_X, p_Y, seed);
    float3 color = make_float3(r, g, b);
    float3 noisy = make_float3(
        r + (noise - 0.5f) * noise_amount,
        g + (noise - 0.5f) * noise_amount,
        b + (noise - 0.5f) * noise_amount
    );
    return noisy;
}`;
        const result = analyzeDocument(source);
        const w = result.warnings.find(w => w.code === 'SEM_W003' && w.message.includes('sst'));
        assert.ok(w, 'should have SEM_W003 warning for unused function sst');
        // "sst" at column 18 in original: "__DEVICE__ float sst(int x) {"
        assert.equal(w.column, 18, `sst column should be 18, got ${w.column}`);
    });

    it('should handle #include gracefully (line count preserved)', () => {
        // #include is NOT expanded by preprocessDctl, it passes through as-is.
        // The parser may or may not handle it, but line count should be preserved.
        // Line 1: '' (empty)
        // Line 2: #include "some_header.h"   <-- not expanded, passes through
        // Line 3: '' (empty)
        // Line 4: __DEVICE__ float3 transform(...) {
        // Line 5:     float unused = 1.0f;
        // Line 6:     return make_float3(...);
        // Line 7: }
        const source = `
#include "some_header.h"

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float unused = 1.0f;
    return make_float3(p_R, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        // analyzeDocument should not throw
        assert.ok(result, 'should return a result');
        // If warnings exist, verify line mapping is correct
        const w = result.warnings.find(w => w.message.includes('unused'));
        if (w) {
            assert.equal(w.line, 5, `unused should be at original line 5, got ${w.line}`);
        }
    });
});

describe('analyzeDocument UI param scope errors', () => {
    it('should error when UI param is used in a helper function (SEM018)', () => {
        const source = `
DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float applyGain(float x) {
    return x * gain;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(applyGain(p_R), p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const e = result.errors.find(e => e.code === 'SEM018' && e.message.includes('gain'));
        assert.ok(e, 'should have SEM018 error for UI param used in helper function');
        assert.ok(e.message.includes('applyGain'), 'error should mention the helper function name');
    });

    it('should NOT error when UI param is used in transform function', () => {
        const source = `
DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain, p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const e = result.errors.find(e => e.code === 'SEM018');
        assert.ok(!e, 'should NOT error about UI param used in transform');
    });

    it('should error for multiple UI params used in same helper function', () => {
        const source = `
DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
DEFINE_UI_PARAMS(offset, Offset, DCTLUI_SLIDER_FLOAT, 0.0, -1.0, 1.0, 0.01)

__DEVICE__ float adjustColor(float x) {
    return x * gain + offset;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(adjustColor(p_R), adjustColor(p_G), adjustColor(p_B));
}`;
        const result = analyzeDocument(source);
        const gainE = result.errors.find(e => e.code === 'SEM018' && e.message.includes('gain'));
        const offsetE = result.errors.find(e => e.code === 'SEM018' && e.message.includes('offset'));
        assert.ok(gainE, 'should error about gain in helper');
        assert.ok(offsetE, 'should error about offset in helper');
    });

    it('should NOT error about COMBO_BOX enum constants in helper functions', () => {
        const source = `
DEFINE_UI_PARAMS(mode, Mode, DCTLUI_COMBO_BOX, 0, {linear, log}, {Linear, Log})

__DEVICE__ float applyMode(float x, int m) {
    if (m == linear) return x;
    return _logf(x + 1.0f);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(applyMode(p_R, mode), p_G, p_B);
}`;
        const result = analyzeDocument(source);
        // 'linear' and 'log' are enum constants, not the UI param 'mode' itself
        const linearE = result.errors.find(e => e.code === 'SEM018' && e.message.includes("'linear'"));
        assert.ok(!linearE, 'should NOT error about COMBO_BOX enum constants in helper');
        // But 'mode' used in transform is fine
        const modeE = result.errors.find(e => e.code === 'SEM018' && e.message.includes("'mode'"));
        assert.ok(!modeE, 'mode is used in transform, not in helper');
    });

    it('should error about COMBO_BOX selector variable used in helper', () => {
        const source = `
DEFINE_UI_PARAMS(mode, Mode, DCTLUI_COMBO_BOX, 0, {linear, log}, {Linear, Log})

__DEVICE__ float applyMode(float x) {
    if (mode == linear) return x;
    return _logf(x + 1.0f);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(applyMode(p_R), p_G, p_B);
}`;
        const result = analyzeDocument(source);
        const modeE = result.errors.find(e => e.code === 'SEM018' && e.message.includes("'mode'"));
        assert.ok(modeE, 'should error about COMBO_BOX selector variable used in helper');
    });
});

describe('getMemberCompletions', () => {
    it('should return x,y,z for float3 type', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('float3', symbolTable);
        const names = members.map(m => m.name);

        assert.ok(names.includes('x'));
        assert.ok(names.includes('y'));
        assert.ok(names.includes('z'));
        assert.ok(!names.includes('w'), 'float3 should not have w');
    });

    it('should return x,y,z,w for float4 type', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('float4', symbolTable);
        const names = members.map(m => m.name);

        assert.ok(names.includes('x'));
        assert.ok(names.includes('y'));
        assert.ok(names.includes('z'));
        assert.ok(names.includes('w'));
    });

    it('should return x,y for float2 type', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('float2', symbolTable);
        const names = members.map(m => m.name);

        assert.ok(names.includes('x'));
        assert.ok(names.includes('y'));
        assert.ok(!names.includes('z'), 'float2 should not have z');
    });

    it('should include r,g,b color components for float3', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('float3', symbolTable);
        const names = members.map(m => m.name);

        assert.ok(names.includes('r'));
        assert.ok(names.includes('g'));
        assert.ok(names.includes('b'));
        assert.ok(!names.includes('a'), 'float3 should not have a');
    });

    it('should return correct element type for int3', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('int3', symbolTable);

        const xMember = members.find(m => m.name === 'x');
        assert.ok(xMember);
        assert.equal(xMember.type, 'int');
    });

    it('should return struct fields for struct type', () => {
        const symbolTable = new SymbolTable();
        symbolTable.defineStruct({
            name: 'MyColor',
            fields: [
                { name: 'r', type: { name: 'float', isArray: false, isPointer: false, isConst: false, isVoid: false }, loc: { line: 1, column: 0 } },
                { name: 'g', type: { name: 'float', isArray: false, isPointer: false, isConst: false, isVoid: false }, loc: { line: 2, column: 0 } },
                { name: 'b', type: { name: 'float', isArray: false, isPointer: false, isConst: false, isVoid: false }, loc: { line: 3, column: 0 } },
            ],
            loc: { line: 1, column: 0 },
        });

        const members = getMemberCompletions('MyColor', symbolTable);
        assert.equal(members.length, 3);
        assert.equal(members[0].name, 'r');
        assert.equal(members[0].type, 'float');
        assert.equal(members[1].name, 'g');
        assert.equal(members[2].name, 'b');
    });

    it('should return empty for scalar type', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('float', symbolTable);
        assert.equal(members.length, 0);
    });

    it('should return empty for unknown type', () => {
        const symbolTable = new SymbolTable();
        const members = getMemberCompletions('unknown_type', symbolTable);
        assert.equal(members.length, 0);
    });
});
