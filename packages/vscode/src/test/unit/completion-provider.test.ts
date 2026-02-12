/**
 * Unit tests for DCTL Completion Provider logic
 *
 * Tests the document analysis and member completion logic
 * that powers auto-completion in the VS Code extension.
 * These are pure unit tests (no VS Code API needed).
 */

import * as assert from 'assert';
import { analyzeDocument, getMemberCompletions, SymbolTable } from '@dctl-workbench/core';

describe('DctlCompletionProvider logic', () => {
    describe('analyzeDocument for completion', () => {
        it('should provide user-defined variables for completion', () => {
            const source = `
DEFINE_UI_PARAMS(gain, "Gain", DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

float globalScale = 1.5f;

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain * globalScale, p_G, p_B);
}`;
            const result = analyzeDocument(source);
            const names = result.symbols.map(s => s.name);

            assert.ok(names.includes('gain'), 'UI param gain should be in symbols');
            assert.ok(names.includes('globalScale'), 'global variable should be in symbols');
            assert.ok(names.includes('transform'), 'user function should be in symbols');
        });

        it('should provide function signature details', () => {
            const source = `
__DEVICE__ float3 applyGain(float3 rgb, float g) {
    return make_float3(rgb.x * g, rgb.y * g, rgb.z * g);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return applyGain(make_float3(p_R, p_G, p_B), 1.0f);
}`;
            const result = analyzeDocument(source);
            const applyGain = result.symbols.find(s => s.name === 'applyGain');

            assert.ok(applyGain);
            assert.equal(applyGain.kind, 'function');
            assert.ok(applyGain.detail?.includes('float3 applyGain'));
            assert.ok(applyGain.detail?.includes('float3 rgb'));
            assert.ok(applyGain.detail?.includes('float g'));
        });

        it('should not include builtins in completion symbols', () => {
            const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const result = analyzeDocument(source);
            const names = result.symbols.map(s => s.name);

            // Builtin functions should NOT appear
            assert.ok(!names.includes('make_float3'), 'builtin make_float3 should not be in symbols');
            assert.ok(!names.includes('_fabs'), 'builtin _fabs should not be in symbols');
            assert.ok(!names.includes('_powf'), 'builtin _powf should not be in symbols');
        });
    });

    describe('getMemberCompletions for dot completion', () => {
        it('should return x,y,z for float3 type', () => {
            const symbolTable = new SymbolTable();
            const members = getMemberCompletions('float3', symbolTable);
            const names = members.map(m => m.name);

            assert.ok(names.includes('x'));
            assert.ok(names.includes('y'));
            assert.ok(names.includes('z'));
            assert.ok(!names.includes('w'));
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
            assert.ok(!names.includes('z'));
        });

        it('should return struct fields for user-defined struct', () => {
            const symbolTable = new SymbolTable();
            symbolTable.defineStruct({
                name: 'ColorTransform',
                fields: [
                    { name: 'matrix', type: { name: 'float3x3', isArray: false, isPointer: false, isConst: false, isVoid: false }, loc: { line: 1, column: 0 } },
                    { name: 'offset', type: { name: 'float3', isArray: false, isPointer: false, isConst: false, isVoid: false }, loc: { line: 2, column: 0 } },
                ],
                loc: { line: 1, column: 0 },
            });

            const members = getMemberCompletions('ColorTransform', symbolTable);
            assert.equal(members.length, 2);
            assert.equal(members[0].name, 'matrix');
            assert.equal(members[0].type, 'float3x3');
            assert.equal(members[1].name, 'offset');
            assert.equal(members[1].type, 'float3');
        });

        it('should return empty for scalar types', () => {
            const symbolTable = new SymbolTable();
            assert.equal(getMemberCompletions('float', symbolTable).length, 0);
            assert.equal(getMemberCompletions('int', symbolTable).length, 0);
        });

        it('should include r,g,b,a color components', () => {
            const symbolTable = new SymbolTable();
            const members = getMemberCompletions('float4', symbolTable);
            const names = members.map(m => m.name);

            assert.ok(names.includes('r'));
            assert.ok(names.includes('g'));
            assert.ok(names.includes('b'));
            assert.ok(names.includes('a'));
        });
    });

    describe('symbol type resolution for member completion', () => {
        it('should resolve global variable type for dot completion', () => {
            const source = `
float3 globalColor = make_float3(1.0f, 0.5f, 0.0f);

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return globalColor;
}`;
            const result = analyzeDocument(source);

            // Global variables remain accessible after analysis
            const sym = result.symbolTable.lookupGlobal('globalColor');
            assert.ok(sym, 'globalColor should be in symbol table');
            assert.equal(sym.type.name, 'float3');

            // Verify member completions work for the resolved type
            const members = getMemberCompletions(sym.type.name, result.symbolTable);
            const names = members.map(m => m.name);
            assert.ok(names.includes('x'), 'float3 should have x member');
            assert.ok(names.includes('y'), 'float3 should have y member');
            assert.ok(names.includes('z'), 'float3 should have z member');
        });
    });
});
