/**
 * DCTL Workbench — Known Limitations Test Suite
 *
 * Documents and verifies current WGSL compilation limitations.
 * Each test corresponds to a limitation listed in README.md § Known Limitations.
 *
 * When a limitation is resolved:
 *   1. Flip the assertion (expect success instead of error/warning)
 *   2. Move the test to the appropriate feature test file
 *   3. Update README.md accordingly
 */

import { strict as assert } from 'assert';
import { DctlParser } from '../../parser/dctlParser';
import { preprocessDctl } from '../../parser/dctlPreprocessor';
import { convertAstToRustFormat } from '../../compiler/astConverter';
import type { ModuleNode } from '../../parser/ast';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parser = new DctlParser();

/** Parse source with the standard float-based transform wrapper. */
function parse(body: string): { ast: ModuleNode | null; errors: unknown[] } {
    const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
${body}
}`;
    return parser.parse(source);
}

/** Parse raw source (no transform wrapper). */
function parseRaw(source: string): { ast: ModuleNode | null; errors: unknown[] } {
    return parser.parse(source);
}

/** Convert AST through the full TS→Rust-JSON pipeline and return warnings. */
function convert(ast: ModuleNode) {
    return convertAstToRustFormat(ast);
}

/** Expect the source to parse and convert, then return conversion result. */
function parseAndConvert(body: string) {
    const { ast, errors } = parse(body);
    assert.ok(ast, `Expected AST, got parse errors: ${JSON.stringify(errors)}`);
    return convert(ast);
}

// ===========================================================================
// § Unsupported DCTL Syntax (WGSL Constraints)
// ===========================================================================

describe('Known Limitations', () => {

    // -----------------------------------------------------------------------
    // 1. GCC Statement Expressions  ({ ... })
    // -----------------------------------------------------------------------
    describe('GCC statement expressions', () => {
        it('should parse but produce a conversion warning', () => {
            const result = parseAndConvert(`
    float x = ({ float temp = p_R; temp; });
    return make_float3(x, x, x);
`);
            assert.ok(result.warnings.length > 0, 'Expected conversion warning');
            assert.ok(
                result.warnings.some(w => w.message.includes('GCC statement expressions')),
                `Expected GCC statement expression warning, got: ${result.warnings.map(w => w.message)}`
            );
            assert.ok(
                result.warnings.some(w => w.message.includes('DaVinci Resolve')),
                'Warning should mention DaVinci Resolve compatibility'
            );
        });
    });

    // -----------------------------------------------------------------------
    // 2. Double Pointers (float**)
    // -----------------------------------------------------------------------
    describe('Double pointers', () => {
        it('should parse but WGSL codegen rejects double-pointer access', () => {
            const source = `
__DEVICE__ void matrix_multiply(__PRIVATE__ float** C, __PRIVATE__ float** A, int A_rows, int A_cols) {
    C[0][0] = A[0][0];
}
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const { ast, errors } = parseRaw(source);
            // Parser handles double-pointer syntax
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);

            // AST converter produces valid JSON — the error occurs in Rust/WGSL
            // codegen (InvalidSubAccess) which requires WASM to test.
            const result = convert(ast);
            assert.doesNotThrow(() => JSON.parse(result.json));
        });
    });

    // -----------------------------------------------------------------------
    // 4. Function Pointers
    // -----------------------------------------------------------------------
    describe('Function pointers', () => {
        it('should parse as regular expression (not true function pointer)', () => {
            // The DCTL parser treats `float (*funcPtr)(float) = 0;` as a
            // parenthesized expression `(*funcPtr)` followed by a call `(float)`.
            // It does NOT create a function pointer declaration node.
            // This means function pointers are "silently misinterpreted" rather
            // than explicitly rejected.  WGSL has no function pointer support.
            const source = `
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float (*funcPtr)(float) = 0;
    return make_float3(p_R, p_G, p_B);
}`;
            const { ast } = parseRaw(source);
            // Parser doesn't crash — it misparses the declaration
            assert.ok(ast, 'Parser should produce some AST');
        });
    });

    // -----------------------------------------------------------------------
    // 6. Pointer-Returning Functions
    // -----------------------------------------------------------------------
    describe('Pointer-returning functions', () => {
        it('should parse and mark return type with is_pointer=true', () => {
            const source = `
__DEVICE__ float* get_ptr(__PRIVATE__ float* arr, int idx) {
    return &arr[idx];
}
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const { ast, errors } = parseRaw(source);
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);

            const result = convert(ast);
            const rustAst = JSON.parse(result.json);

            // Declarations are flat objects with kind/name fields
            const getPtr = rustAst.declarations.find(
                (d: any) => d.name === 'get_ptr'
            );
            assert.ok(getPtr, 'get_ptr function should be in AST');
            // Return type is_pointer=true — Rust codegen converts to void
            assert.equal(
                getPtr.return_type.is_pointer, true,
                'Return type should be marked as pointer (Rust backend converts to void)'
            );
        });
    });

    // -----------------------------------------------------------------------
    // 7. Dynamic Array Sizes
    // -----------------------------------------------------------------------
    describe('Dynamic array sizes', () => {
        it('should parse but array size may not be statically resolved', () => {
            // Static array sizes work fine
            const staticResult = parseAndConvert(`
    float arr[10];
    arr[0] = p_R;
    return make_float3(arr[0], arr[0], arr[0]);
`);
            assert.equal(staticResult.warnings.length, 0);

            // Dynamic sizes (variable-based) — parser accepts them but the size
            // expression may not be evaluatable by the WGSL backend.
            const dynamicResult = parseAndConvert(`
    int n = 10;
    float arr[n];
    arr[0] = p_R;
    return make_float3(arr[0], arr[0], arr[0]);
`);
            assert.doesNotThrow(() => JSON.parse(dynamicResult.json));
        });
    });

    // ===================================================================
    // § Type System Limitations
    // ===================================================================

    describe('Type system — precision loss', () => {
        it('double is mapped to Double base type (becomes f32 in WGSL)', () => {
            const result = parseAndConvert(`
    double x = (double)p_R;
    return make_float3((float)x, (float)x, (float)x);
`);
            const rustAst = JSON.parse(result.json);
            const transformFn = rustAst.declarations.find(
                (d: any) => d.name === 'transform'
            );
            assert.ok(transformFn);
            const varDecl = transformFn.body.statements.find(
                (s: any) => s.kind === 'Variable' && s.name === 'x'
            );
            assert.ok(varDecl, 'Expected variable declaration for x');
            // double → Double in Rust AST → f32 in WGSL (precision loss)
            assert.equal(varDecl.var_type.base, 'Double');
        });

        it('half is mapped to Half base type (promoted to f32 in WGSL)', () => {
            const result = parseAndConvert(`
    half x = (half)p_R;
    return make_float3((float)x, (float)x, (float)x);
`);
            const rustAst = JSON.parse(result.json);
            const transformFn = rustAst.declarations.find(
                (d: any) => d.name === 'transform'
            );
            assert.ok(transformFn);
            const varDecl = transformFn.body.statements.find(
                (s: any) => s.kind === 'Variable' && s.name === 'x'
            );
            assert.ok(varDecl);
            // half → Half in Rust AST → f32 in WGSL
            assert.equal(varDecl.var_type.base, 'Half');
        });

        it('char is mapped to Char base type (becomes i32 in WGSL)', () => {
            const result = parseAndConvert(`
    char c = 65;
    float val = (float)c;
    return make_float3(val, val, val);
`);
            const rustAst = JSON.parse(result.json);
            const transformFn = rustAst.declarations.find(
                (d: any) => d.name === 'transform'
            );
            assert.ok(transformFn);
            const varDecl = transformFn.body.statements.find(
                (s: any) => s.kind === 'Variable' && s.name === 'c'
            );
            assert.ok(varDecl);
            // char → Char in Rust AST → i32 in WGSL
            assert.equal(varDecl.var_type.base, 'Char');
        });

        it('long is mapped to Int base type (no 64-bit support in WGSL)', () => {
            const result = parseAndConvert(`
    long x = 100;
    return make_float3((float)x, (float)x, (float)x);
`);
            const rustAst = JSON.parse(result.json);
            const transformFn = rustAst.declarations.find(
                (d: any) => d.name === 'transform'
            );
            assert.ok(transformFn);
            const varDecl = transformFn.body.statements.find(
                (s: any) => s.kind === 'Variable' && s.name === 'x'
            );
            assert.ok(varDecl);
            // long → Int in Rust AST → i32 in WGSL
            assert.equal(varDecl.var_type.base, 'Int');
        });
    });

    // ===================================================================
    // § Array Handling
    // ===================================================================

    describe('Array handling', () => {
        it('multi-dimensional arrays produce array_dims with multiple entries', () => {
            const result = parseAndConvert(`
    float mat[3][3];
    mat[0][0] = 1.0f;
    mat[1][1] = 1.0f;
    mat[2][2] = 1.0f;
    return make_float3(mat[0][0], mat[1][1], mat[2][2]);
`);
            const rustAst = JSON.parse(result.json);
            const transformFn = rustAst.declarations.find(
                (d: any) => d.name === 'transform'
            );
            assert.ok(transformFn);
            const varDecl = transformFn.body.statements.find(
                (s: any) => s.kind === 'Variable' && s.name === 'mat'
            );
            assert.ok(varDecl, 'Expected variable declaration for mat');
            // Multi-dim arrays have multiple array_dims entries.
            // The Rust codegen flattens to 1D (array<f32, 9>).
            const arrayDims = varDecl.var_type.array_dims;
            assert.ok(arrayDims.length >= 2, `Expected >=2 array dims, got ${arrayDims.length}`);
        });

        it('unsized array parameters produce Unspecified dimension', () => {
            const source = `
__DEVICE__ float sum(__PRIVATE__ float arr[], int count) {
    float s = 0.0f;
    for (int i = 0; i < count; i++) {
        s += arr[i];
    }
    return s;
}
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const { ast, errors } = parseRaw(source);
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);

            const result = convert(ast);
            const rustAst = JSON.parse(result.json);

            // Find the sum function (flat declaration with name field)
            const sumFn = rustAst.declarations.find(
                (d: any) => d.name === 'sum'
            );
            assert.ok(sumFn, 'sum function should be in AST');
            const arrParam = sumFn.params.find(
                (p: any) => p.name === 'arr'
            );
            assert.ok(arrParam, 'arr parameter should exist');
            assert.ok(
                arrParam.param_type.array_dims.length > 0,
                'arr should have array dimensions'
            );
            // Unsized array → Unspecified (Rust codegen expands to 256)
            assert.equal(
                arrParam.param_type.array_dims[0], 'Unspecified',
                'Unsized array should be marked as Unspecified (Rust codegen expands to 256)'
            );
        });
    });

    // ===================================================================
    // § Preprocessor Limitations (Core compiler)
    // ===================================================================

    describe('Preprocessor — core compiler', () => {
        it('#if only evaluates literal 0 and 1 (other conditions assume true)', () => {
            // The core preprocessor comments out excluded code with "// [excluded]"
            // but keeps the text in the output.  We check by looking for the
            // actual variable declaration (not commented out).
            const source = [
                '#if 0',
                'float dead_code = 1.0f;',
                '#endif',
                '#if 1',
                'float live_code = 2.0f;',
                '#endif',
                '#if SOME_MACRO',
                'float assumed_true = 3.0f;',
                '#endif',
            ].join('\n');

            const result = preprocessDctl(source);
            const lines = result.code.split('\n');
            const userLines = lines.slice(result.headerLineCount);
            const userCode = userLines.join('\n');

            // #if 0 block should be excluded (commented out as "// [excluded]")
            const deadLine = userLines.find(l => l.includes('dead_code'));
            assert.ok(
                !deadLine || deadLine.trimStart().startsWith('//'),
                '#if 0 block should be excluded (commented out)'
            );

            // #if 1 block should be included (not commented out)
            const liveLine = userLines.find(l => l.includes('live_code') && !l.trimStart().startsWith('//'));
            assert.ok(liveLine, '#if 1 block should be included');

            // #if SOME_MACRO — core preprocessor assumes true (not commented out)
            const assumedLine = userLines.find(l => l.includes('assumed_true') && !l.trimStart().startsWith('//'));
            assert.ok(
                assumedLine,
                '#if SOME_MACRO should be included (core preprocessor assumes true for non-0/1)'
            );
        });
    });

    // ===================================================================
    // § Baseline — supported features should work without warnings
    // ===================================================================

    describe('Baseline — supported features', () => {
        it('standard DCTL with basic types, control flow, and math compiles cleanly', () => {
            const source = `
__DEVICE__ float clampf(float x, float lo, float hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = clampf(p_R * 2.0f, 0.0f, 1.0f);
    float g = clampf(p_G * 2.0f, 0.0f, 1.0f);
    float b = clampf(p_B * 2.0f, 0.0f, 1.0f);

    for (int i = 0; i < 3; i++) {
        r = _powf(r, 0.4545f);
    }

    float luma = r * 0.2126f + g * 0.7152f + b * 0.0722f;
    bool is_bright = luma > 0.5f;

    if (is_bright) {
        return make_float3(r, g, b);
    } else {
        return make_float3(r * 0.5f, g * 0.5f, b * 0.5f);
    }
}`;
            const { ast, errors } = parseRaw(source);
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);
            assert.equal(errors.length, 0, `Unexpected parse errors: ${JSON.stringify(errors)}`);

            const result = convert(ast);
            assert.equal(
                result.warnings.length, 0,
                `Standard DCTL should produce no warnings: ${JSON.stringify(result.warnings)}`
            );
            assert.doesNotThrow(() => JSON.parse(result.json));
        });

        it('1D arrays with constant sizes compile cleanly', () => {
            const result = parseAndConvert(`
    float arr[10];
    for (int i = 0; i < 10; i++) {
        arr[i] = (float)i * 0.1f;
    }
    return make_float3(arr[0], arr[5], arr[9]);
`);
            assert.equal(result.warnings.length, 0);
            assert.doesNotThrow(() => JSON.parse(result.json));
        });

        it('pointer dereference (*ptr) and address-of (&var) compile cleanly', () => {
            // Pointer dereference is supported: Rust codegen converts
            // *ptr reads to NagaExpr::Load and *ptr writes to store targets.
            const source = `
__DEVICE__ void set_value(__PRIVATE__ float* ptr) {
    *ptr = 1.0f;
}
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float val = 0.0f;
    set_value(&val);
    return make_float3(val, val, val);
}`;
            const { ast, errors } = parseRaw(source);
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);
            assert.equal(errors.length, 0);
            const result = convert(ast);
            assert.equal(result.warnings.length, 0);
        });

        it('compound literals compile as type constructors', () => {
            // (Type){expr1, expr2, ...} → Cast(Type, InitializerList) → Compose in WGSL
            const source = `
typedef struct { float r; float g; float b; } Color;
__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    Color c = (Color){p_R, p_G, p_B};
    float3 v = (float3){1.0f, 2.0f, 3.0f};
    return make_float3(c.r + v.x, c.g + v.y, c.b + v.z);
}`;
            const { ast, errors } = parseRaw(source);
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);
            assert.equal(errors.length, 0);
            const result = convert(ast);
            assert.equal(result.warnings.length, 0);
        });

        it('struct definitions and member access compile cleanly', () => {
            const source = `
typedef struct {
    float r;
    float g;
    float b;
} Color;

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    Color c;
    c.r = p_R;
    c.g = p_G;
    c.b = p_B;
    return make_float3(c.r, c.g, c.b);
}`;
            const { ast, errors } = parseRaw(source);
            assert.ok(ast, `Parse failed: ${JSON.stringify(errors)}`);
            const result = convert(ast);
            assert.equal(result.warnings.length, 0);
        });
    });
});
