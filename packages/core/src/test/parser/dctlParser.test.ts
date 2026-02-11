/**
 * DCTL Parser Unit Tests
 */

import { strict as assert } from 'assert';
import { DctlParser } from '../../parser/dctlParser';

describe('DctlParser', () => {
    const parser = new DctlParser();

    describe('Function Parsing', () => {
        it('should parse simple function', () => {
            const source = `
float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0, 'Expected no parse errors');
            assert.ok(result.ast);
            assert.equal(result.ast.kind, 'Module');
            assert.ok(result.ast.declarations.length > 0);
        });

        it('should parse function with __DEVICE__ modifier', () => {
            const source = `
__DEVICE__ float3 transform(int x) {
    return make_float3(0, 0, 0);
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
            const func = result.ast?.declarations[0];
            assert.equal(func?.kind, 'Function');
            if (func?.kind === 'Function') {
                assert.ok(func.modifiers.some(m => m.modifier === '__DEVICE__'));
            }
        });

        it('should parse function with multiple parameters', () => {
            const source = `
float add(float a, float b, float c) {
    return a + b + c;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
            const func = result.ast?.declarations[0];
            if (func?.kind === 'Function') {
                assert.equal(func.parameters.length, 3);
            }
        });

        it('should parse function with array parameters', () => {
            const source = `
void process(float arr[10]) {
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse texture-based transform signature', () => {
            const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    return make_float3(0, 0, 0);
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
            const func = result.ast?.declarations[0];
            if (func?.kind === 'Function') {
                assert.ok(func.parameters.some((p: { type: { name: string } }) => p.type.name === '__TEXTURE__'));
            }
        });
    });

    describe('Type Parsing', () => {
        it('should parse primitive types', () => {
            const source = `
void foo() {
    int a;
    float b;
    bool c;
    char d;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse vector types (float2, float3, float4)', () => {
            const source = `
void foo() {
    float2 a;
    float3 b;
    float4 c;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse pointer types', () => {
            const source = `
void foo(float *ptr) {
    *ptr = 1.0;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse const modifier', () => {
            const source = `
void foo(const float x) {
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse unsigned types', () => {
            const source = `
void foo() {
    unsigned int a;
    unsigned char b;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });
    });

    describe('Statement Parsing', () => {
        it('should parse variable declarations', () => {
            const source = `
void foo() {
    int x = 5;
    float y = 3.14;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse if statements', () => {
            const source = `
void foo() {
    if (x > 0) {
        y = 1;
    } else {
        y = 0;
    }
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse for loops', () => {
            const source = `
void foo() {
    for (int i = 0; i < 10; i++) {
        sum += i;
    }
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse while loops', () => {
            const source = `
void foo() {
    while (x > 0) {
        x--;
    }
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse switch statements', () => {
            const source = `
void foo() {
    switch (mode) {
        case 0:
            x = 1;
            break;
        case 1:
            x = 2;
            break;
        default:
            x = 0;
    }
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse return statements', () => {
            const source = `
int foo() {
    return 42;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });
    });

    describe('Expression Parsing', () => {
        it('should parse binary expressions with correct precedence', () => {
            const source = `
void foo() {
    int x = 1 + 2 * 3;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse unary expressions', () => {
            const source = `
void foo() {
    int x = -5;
    bool y = !true;
    int z = ~0xFF;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse ternary expressions', () => {
            const source = `
void foo() {
    int x = a > b ? a : b;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse function calls', () => {
            const source = `
void foo() {
    float3 v = make_float3(1.0, 2.0, 3.0);
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse member access (.x, .y, .z)', () => {
            const source = `
void foo() {
    float3 v;
    float r = v.x;
    float g = v.y;
    float b = v.z;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse array indexing', () => {
            const source = `
void foo() {
    float arr[10];
    float x = arr[5];
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse cast expressions', () => {
            const source = `
void foo() {
    float x = (float)intValue;
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse initializer lists', () => {
            const source = `
void foo() {
    float3 v = {1.0, 2.0, 3.0};
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });
    });

    describe('Struct/Typedef Parsing', () => {
        it('should parse struct definitions', () => {
            const source = `
struct Point {
    float x;
    float y;
};`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse typedef statements', () => {
            const source = `
typedef float real;`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });

        it('should parse typedef struct', () => {
            const source = `
typedef struct {
    float x;
    float y;
} Point;`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
        });
    });

    describe('DCTL Macro Parsing', () => {
        it('should parse DEFINE_UI_PARAMS', () => {
            const source = `
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
            assert.ok((result.ast?.macros?.length ?? 0) > 0);
        });

        it('should parse multiple UI params', () => {
            const source = `
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)
DEFINE_UI_PARAMS(enable, Enable, DCTL_CHECK_BOX, 1)`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0);
            assert.equal(result.ast?.macros.length, 2);
        });
    });

    describe('Error Recovery', () => {
        it('should report missing semicolon', () => {
            const source = `
void foo() {
    int x = 5
}`;
            const result = parser.parse(source);
            assert.ok(result.errors.length > 0);
        });

        it('should report missing semicolon on the line where it is missing, not on the next statement', () => {
            // Reproduces the bug: sample2.dctl has a missing semicolon on line 4
            // but the error was reported on line 8 (return out;)
            const source =
`__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 out = make_float3(1.0f - p_R, 1.0f - p_G, 1.0f - p_B)

    return out;
}`;
            const result = parser.parse(source);
            assert.ok(result.errors.length > 0, 'Should report at least one error');

            // The error should be on line 3 (the make_float3 line), not line 5 (return out)
            const semicolonError = result.errors.find(e => e.message.includes(';'));
            assert.ok(semicolonError, 'Should have a semicolon error');
            // make_float3(...) is on line 3 (0-indexed in source, 1-indexed in parser)
            // The error must NOT be on the 'return' line (line 5)
            assert.ok(
                semicolonError!.line <= 3,
                `Semicolon error should be on line 3 (the make_float3 line) ` +
                `but was on line ${semicolonError!.line}. ` +
                `Error should point to where the semicolon is missing, not the next statement.`
            );
        });

        it('should report missing closing brace', () => {
            const source = `
void foo() {
    int x = 5;
`;
            const result = parser.parse(source);
            assert.ok(result.errors.length > 0);
        });

        it('should recover and continue parsing after error', () => {
            const source = `
void foo() {
    int x =
}
void bar() {
    return 1;
}`;
            const result = parser.parse(source);
            // Should have errors but still produce some AST
            assert.ok(result.errors.length > 0);
        });
    });

    describe('Complex DCTL Examples', () => {
        it('should parse a complete DCTL file', () => {
            const source = `
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)
DEFINE_UI_PARAMS(gamma, Gamma, DCTL_SLIDER_FLOAT, 1.0, 0.1, 3.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = p_R * gain;
    float g = p_G * gain;
    float b = p_B * gain;

    r = _powf(r, 1.0 / gamma);
    g = _powf(g, 1.0 / gamma);
    b = _powf(b, 1.0 / gamma);

    return make_float3(r, g, b);
}`;
            const result = parser.parse(source);
            assert.equal(result.errors.length, 0, `Errors: ${JSON.stringify(result.errors)}`);
            assert.ok(result.ast);
            assert.equal(result.ast.macros?.length ?? 0, 2);
            assert.ok(result.ast.declarations.length > 0);
        });
    });
});
