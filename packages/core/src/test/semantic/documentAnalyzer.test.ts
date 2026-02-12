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
