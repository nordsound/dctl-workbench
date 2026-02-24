/**
 * Real-World DCTL Failure Test Suite
 *
 * Tests derived from 323 real-world DCTL files collected from GitHub.
 * 19 files failed compilation — this suite captures each root cause.
 *
 * Bug tests (TDD RED — assert correct behavior, currently failing):
 *   1. typedef enum breaks codegen — should compile but doesn't
 *   2. WGSL array→float validation — codegen type corruption, should compile
 *   3. Undefined built-in TIMELINE_FRAME_INDEX — should be defined
 *
 * WGSL limitation tests (characterization — assert current error behavior):
 *   4. Unsupported cast: Struct — WGSL constraint
 *   5. Unsupported cast: Pointer — WGSL constraint
 *   6. Double pointer (float**) — WGSL constraint
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DctlCompiler, isCompileError } from '../../compiler/index';
import type { CompileResult, CompileError } from '../../types/index';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WASM_PATH = REPO_ROOT;
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

/** Helper to format compile error message for assertion output. */
function errorMsg(result: CompileResult | CompileError): string {
    if (isCompileError(result)) {
        return (result as CompileError).message;
    }
    const r = result as CompileResult;
    if (r.wgsl.length === 0) {
        return `0 bytes WGSL, diagnostics: ${JSON.stringify(r.diagnostics)}`;
    }
    return '';
}

describe('Real-world DCTL failures', function () {
    this.timeout(30000);

    let compiler: DctlCompiler;

    before(async () => {
        compiler = new DctlCompiler();
        await compiler.init(WASM_PATH);
    });

    /** Compile a fixture file and return the result. */
    function compileFixture(filename: string): CompileResult | CompileError {
        const source = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
        return compiler.compile(source);
    }

    /** Compile inline source and return the result. */
    function compileSource(source: string): CompileResult | CompileError {
        return compiler.compile(source);
    }

    // ===================================================================
    // § Bug 1. typedef enum breaks codegen (TDD RED)
    //
    // Root cause: The Rust codegen fails to resolve ANY function when a
    // `typedef enum { ... } Name;` is present. The compile "succeeds"
    // but produces 0 bytes WGSL with "No transform function found" warning.
    //
    // Affected files (12):
    //   - Greyson-Sawyer--CST_full.dctl
    //   - Greyson-Sawyer--CST_simple.dctl
    //   + any file using typedef enum (including 8 ACES files via headers)
    // ===================================================================

    describe('Bug: typedef enum should compile', () => {
        it('should compile DCTL with typedef enum', () => {
            const result = compileFixture('limitation_typedef_enum.dctl');
            assert.ok(
                !isCompileError(result) && (result as CompileResult).wgsl.length > 0,
                `typedef enum DCTL should compile successfully, got: ${errorMsg(result)}`
            );
        });

        it('should resolve enum values as constants in function calls', () => {
            const source = `
typedef enum {
    Mode_A,
    Mode_B
} ProcessMode;

__DEVICE__ float process(float x, ProcessMode mode) {
    if (mode == Mode_A) return x * 2.0f;
    return x;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = process(p_R, Mode_A);
    return make_float3(r, p_G, p_B);
}`;
            const result = compileSource(source);
            assert.ok(
                !isCompileError(result) && (result as CompileResult).wgsl.length > 0,
                `typedef enum with function calls should compile, got: ${errorMsg(result)}`
            );
        });

        it('should compile typedef enum with switch statement', () => {
            const source = `
typedef enum { Type_A, Type_B, Type_C } MyType;

__DEVICE__ float process(float x, MyType t) {
    switch (t) {
        case Type_A: return x * 1.0f;
        case Type_B: return x * 2.0f;
        case Type_C: return x * 3.0f;
        default: return x;
    }
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = process(p_R, Type_B);
    return make_float3(r, p_G, p_B);
}`;
            const result = compileSource(source);
            assert.ok(
                !isCompileError(result) && (result as CompileResult).wgsl.length > 0,
                `typedef enum with switch should compile, got: ${errorMsg(result)}`
            );
        });
    });

    // ===================================================================
    // § Bug 2. WGSL array→float codegen type corruption (TDD RED)
    //
    // Root cause: When a function using float[3][3] 2D arrays (mult_f33_f33)
    // coexists with a function using float[3] + float[4][4] (mult_f3_f44),
    // the codegen corrupts type information, causing Naga to reject the
    // latter with "Array as Float" error. Each function compiles fine
    // in isolation — the bug is in cross-function type state.
    //
    // Affected files (8):
    //   - baldavenger--Inverse_Rec709_to_ACES.dctl
    //   - baldavenger-ACES--ACES_ADX_REC709_OFX.dctl
    //   - baldavenger-ACES--ACES_COMBO_OFX.dctl (via ACES_LIB.h)
    //   - baldavenger-ACES--ACES_CSC_OFX.dctl
    //   - baldavenger-ACES--ACES_IDT_OFX.dctl
    //   - baldavenger-ACES--ACES_LMT_OFX.dctl
    //   - baldavenger-ACES--ACES_ODT_OFX.dctl
    //   - baldavenger-ACES--ACES_RRTODT_OFX.dctl
    // ===================================================================

    describe('Bug: mult_f33_f33 + mult_f3_f44 should coexist', () => {
        it('should compile when 2D array function precedes 1D+2D array function', () => {
            const result = compileFixture('limitation_array_as_float.dctl');
            assert.ok(
                !isCompileError(result),
                `mult_f33_f33 + mult_f3_f44 should compile, got: ${errorMsg(result)}`
            );
        });

        it('should compile mult_f3_f44 in isolation (baseline)', () => {
            // Verify each function compiles alone — only the combination fails
            const source = `
typedef struct { float4 c0, c1, c2, c3; } mat4;

__DEVICE__ float3 mult_f3_f44(float3 X, mat4 A) {
    float r[3];
    float x[3] = {X.x, X.y, X.z};
    float a[4][4] = {{A.c0.x, A.c0.y, A.c0.z, A.c0.w}, {A.c1.x, A.c1.y, A.c1.z, A.c1.w},
                     {A.c2.x, A.c2.y, A.c2.z, A.c2.w}, {A.c3.x, A.c3.y, A.c3.z, A.c3.w}};
    for (int i = 0; i < 3; ++i) {
        r[i] = 0.0f;
        for (int j = 0; j < 3; ++j) {
            r[i] = r[i] + x[j] * a[j][i];
        }
        r[i] = r[i] + a[3][i];
    }
    float s = 1.0f / (x[0] * a[0][3] + x[1] * a[1][3] + x[2] * a[2][3] + a[3][3]);
    for (int k = 0; k < 3; ++k) {
        r[k] = r[k] * s;
    }
    return make_float3(r[0], r[1], r[2]);
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const result = compileSource(source);
            assert.ok(
                !isCompileError(result),
                `mult_f3_f44 alone should compile: ${errorMsg(result)}`
            );
        });

        it('should compile mult_f33_f33 in isolation (baseline)', () => {
            const source = `
typedef struct { float3 c0, c1, c2; } mat3;

__DEVICE__ mat3 make_mat3(float3 A, float3 B, float3 C) {
    mat3 D; D.c0 = A; D.c1 = B; D.c2 = C; return D;
}

__DEVICE__ mat3 mult_f33_f33(mat3 A, mat3 B) {
    float r[3][3];
    float a[3][3] = {{A.c0.x, A.c0.y, A.c0.z}, {A.c1.x, A.c1.y, A.c1.z}, {A.c2.x, A.c2.y, A.c2.z}};
    float b[3][3] = {{B.c0.x, B.c0.y, B.c0.z}, {B.c1.x, B.c1.y, B.c1.z}, {B.c2.x, B.c2.y, B.c2.z}};
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            r[i][j] = 0.0f;
            for (int k = 0; k < 3; ++k) {
                r[i][j] = r[i][j] + a[i][k] * b[k][j];
            }
        }
    }
    return make_mat3(make_float3(r[0][0], r[0][1], r[0][2]),
                     make_float3(r[1][0], r[1][1], r[1][2]),
                     make_float3(r[2][0], r[2][1], r[2][2]));
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R, p_G, p_B);
}`;
            const result = compileSource(source);
            assert.ok(
                !isCompileError(result),
                `mult_f33_f33 alone should compile: ${errorMsg(result)}`
            );
        });
    });

    // ===================================================================
    // § Bug 3. Undefined built-in: TIMELINE_FRAME_INDEX (TDD RED)
    //
    // Root cause: TIMELINE_FRAME_INDEX is a DaVinci Resolve built-in
    // variable injected at runtime. The DCTL Workbench compiler should
    // define it (e.g., as a constant 0) so files using it can compile.
    //
    // Affected files (2):
    //   - thatcherfreeman--Timecode Display.dctl
    //   - thatcherfreeman--Timing Shift Streaks.dctl
    // ===================================================================

    describe('Bug: TIMELINE_FRAME_INDEX should be defined', () => {
        it('should compile DCTL using TIMELINE_FRAME_INDEX', () => {
            const result = compileFixture('limitation_timeline_frame_index.dctl');
            assert.ok(
                !isCompileError(result),
                `TIMELINE_FRAME_INDEX should be a known built-in, got: ${errorMsg(result)}`
            );
        });
    });

    // ===================================================================
    // § WGSL Limitations (characterization tests — assert current errors)
    // ===================================================================

    describe('WGSL limitation: Unsupported cast to Struct', () => {
        it('should reject cast to struct typedef alias with user-friendly message', () => {
            const result = compileFixture('limitation_struct_cast.dctl');
            assert.ok(isCompileError(result), 'Expected compile error for struct cast');
            const error = result as CompileError;
            assert.ok(
                error.message.includes('not supported in WGSL'),
                `Expected WGSL limitation message, got: ${error.message}`
            );
            assert.ok(
                error.message.includes('Cast to struct type'),
                `Expected struct cast description, got: ${error.message}`
            );
            assert.ok(
                error.message.includes('DaVinci Resolve'),
                `Expected DaVinci Resolve mention, got: ${error.message}`
            );
        });
    });

    describe('WGSL limitation: Unsupported cast to Pointer', () => {
        it('should reject cast to pointer type with user-friendly message', () => {
            const result = compileFixture('limitation_pointer_cast.dctl');
            assert.ok(isCompileError(result), 'Expected compile error for pointer cast');
            const error = result as CompileError;
            assert.ok(
                error.message.includes('not supported in WGSL'),
                `Expected WGSL limitation message, got: ${error.message}`
            );
            assert.ok(
                error.message.includes('Cast to pointer type'),
                `Expected pointer cast description, got: ${error.message}`
            );
        });
    });

    describe('WGSL limitation: Double pointer (float**)', () => {
        it('should reject double pointer access with user-friendly message', () => {
            const result = compileFixture('limitation_double_pointer.dctl');
            assert.ok(isCompileError(result), 'Expected compile error for double pointer');
            const error = result as CompileError;
            assert.ok(
                error.message.includes('not supported in WGSL'),
                `Expected WGSL limitation message, got: ${error.message}`
            );
            assert.ok(
                error.message.includes('Double pointer') || error.message.includes('pointer-to-pointer'),
                `Expected double pointer description, got: ${error.message}`
            );
            // Should NOT contain raw Naga debug output
            assert.ok(
                !error.message.includes('WithSpan'),
                `Should not contain raw Naga internals, got: ${error.message}`
            );
        });
    });
});
