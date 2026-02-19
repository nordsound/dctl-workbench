/**
 * AST Converter Tests
 *
 * Tests for convertAstToRustFormat, particularly unsupported syntax warnings.
 */

import { strict as assert } from 'assert';
import { DctlParser } from '../../parser/dctlParser';
import { convertAstToRustFormat } from '../../compiler/astConverter';

describe('convertAstToRustFormat', () => {
    const parser = new DctlParser();

    describe('Unsupported syntax warnings', () => {
        it('should warn about GCC statement expressions ({ ... })', () => {
            // GCC statement expressions are used in some DCTL files (e.g. Pointer Test.dctl)
            // They can't be compiled to WGSL but may work in DaVinci Resolve (CUDA/Metal)
            const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float x = ({ float temp = 1.0f; temp; });
    return make_float3(x, x, x);
}`;
            const parseResult = parser.parse(source);
            assert.ok(parseResult.ast, 'Expected AST to be produced');
            assert.equal(parseResult.errors.length, 0, `Parse errors: ${JSON.stringify(parseResult.errors)}`);

            const result = convertAstToRustFormat(parseResult.ast);
            assert.ok(result.warnings.length > 0, 'Expected warnings for unsupported syntax');
            assert.ok(
                result.warnings[0].message.includes('GCC statement expressions'),
                `Expected message about GCC statement expressions, got: ${result.warnings[0].message}`
            );
            assert.ok(
                result.warnings[0].message.includes('DaVinci Resolve'),
                `Expected message to mention DaVinci Resolve, got: ${result.warnings[0].message}`
            );
            assert.ok(
                result.warnings[0].message.includes('WGSL'),
                `Expected message to mention WGSL, got: ${result.warnings[0].message}`
            );
        });

        it('should return valid JSON even with unsupported syntax', () => {
            const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float x = ({ float temp = 1.0f; temp; });
    return make_float3(x, x, x);
}`;
            const parseResult = parser.parse(source);
            assert.ok(parseResult.ast);

            const result = convertAstToRustFormat(parseResult.ast);
            // JSON should still be valid (with placeholder values)
            assert.doesNotThrow(() => JSON.parse(result.json), 'Expected valid JSON');
        });

        it('should not warn for supported syntax', () => {
            const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float x = p_R * 2.0f;
    return make_float3(x, x, x);
}`;
            const parseResult = parser.parse(source);
            assert.ok(parseResult.ast);
            assert.equal(parseResult.errors.length, 0);

            const result = convertAstToRustFormat(parseResult.ast);
            assert.equal(result.warnings.length, 0, `Unexpected warnings: ${JSON.stringify(result.warnings)}`);
        });
    });
});
