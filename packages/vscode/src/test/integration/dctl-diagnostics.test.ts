/**
 * DCTL Diagnostics Integration Tests
 *
 * Verifies that the diagnostics provider reports errors at the correct
 * line/column positions within VS Code.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Helper: write a temp .dctl file, open it, wait for diagnostics, return them.
 *
 * Uses waitForStableDiagnostics to ensure the full diagnostic pipeline
 * (parser → semantic analysis → Naga validation) has completed.
 */
async function getDiagnosticsForSource(source: string): Promise<vscode.Diagnostic[]> {
    // Write temp file with .dctl extension
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dctl-test-'));
    const tmpFile = path.join(tmpDir, 'test.dctl');
    fs.writeFileSync(tmpFile, source, 'utf-8');

    const uri = vscode.Uri.file(tmpFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    console.log(`[diag-test] Opened doc: languageId=${doc.languageId}, uri=${doc.uri.fsPath}`);

    // Ensure the document has the dctl language ID
    if (doc.languageId !== 'dctl') {
        console.log(`[diag-test] Setting language to dctl (was: ${doc.languageId})`);
        await vscode.languages.setTextDocumentLanguage(doc, 'dctl');
    }

    await vscode.window.showTextDocument(doc);

    // Wait for diagnostics to stabilize (no changes for 2s, max 15s)
    // This ensures the full diagnostic pipeline has completed:
    // - Parser (sync, fast)
    // - Semantic analysis (sync, fast)
    // - Naga validation (async, may take 1-2s)
    const diagnostics = await waitForStableDiagnostics(uri, 2000, 15000);

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch { /* ignore */ }

    return diagnostics;
}

/**
 * Wait for diagnostics to appear on a URI, with timeout.
 *
 * Registers the onDidChangeDiagnostics listener BEFORE checking existing
 * diagnostics to avoid a race condition where diagnostics are set between
 * the check and the listener registration.
 */
function waitForDiagnostics(uri: vscode.Uri, timeoutMs: number): Promise<vscode.Diagnostic[]> {
    return new Promise((resolve) => {
        let resolved = false;
        const done = (diags: vscode.Diagnostic[]) => {
            if (resolved) return;
            resolved = true;
            disposable.dispose();
            clearTimeout(timer);
            resolve(diags);
        };

        // Step 1: Register listener FIRST (before checking existing)
        const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
            if (e.uris.some(u => u.toString() === uri.toString())) {
                const diags = vscode.languages.getDiagnostics(uri);
                if (diags.length > 0) {
                    done(diags);
                }
            }
        });

        const timer = setTimeout(() => {
            done(vscode.languages.getDiagnostics(uri));
        }, timeoutMs);

        // Step 2: Check existing diagnostics AFTER listener is registered
        const existing = vscode.languages.getDiagnostics(uri);
        if (existing.length > 0) {
            done(existing);
        }
    });
}

/**
 * Wait for diagnostics to stabilize (no changes for stabilizeMs).
 * Use this for tests that need to wait for the full diagnostic pipeline.
 */
function waitForStableDiagnostics(uri: vscode.Uri, stabilizeMs: number, timeoutMs: number): Promise<vscode.Diagnostic[]> {
    return new Promise((resolve) => {
        let resolved = false;
        let stabilizeTimer: NodeJS.Timeout | null = null;

        const done = (diags: vscode.Diagnostic[]) => {
            if (resolved) return;
            resolved = true;
            disposable.dispose();
            clearTimeout(overallTimer);
            if (stabilizeTimer) clearTimeout(stabilizeTimer);
            resolve(diags);
        };

        const resetStabilize = () => {
            if (stabilizeTimer) clearTimeout(stabilizeTimer);
            stabilizeTimer = setTimeout(() => {
                done(vscode.languages.getDiagnostics(uri));
            }, stabilizeMs);
        };

        const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
            if (e.uris.some(u => u.toString() === uri.toString())) {
                resetStabilize();
            }
        });

        const overallTimer = setTimeout(() => {
            done(vscode.languages.getDiagnostics(uri));
        }, timeoutMs);

        // Start stabilization timer immediately
        resetStabilize();
    });
}

suite('DCTL Diagnostics Tests', () => {

    test('missing semicolon error should be reported on the correct line', async function () {
        this.timeout(30000);

        // This is the sample2.dctl content: semicolon missing on line 4 (make_float3 line)
        const source =
`__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 out = make_float3(1.0f - p_R, 1.0f - p_G, 1.0f - p_B)

    return out;
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // Should have at least one diagnostic
        assert.ok(diagnostics.length > 0, 'Should report at least one diagnostic');

        // Find the semicolon error
        const semicolonDiag = diagnostics.find(d =>
            d.message.includes(';') || d.message.includes('semicolon')
        );
        assert.ok(semicolonDiag, `Should have a semicolon error. Got: ${diagnostics.map(d => d.message).join(', ')}`);

        // The error should be on line 3 (0-indexed: line 2) where make_float3(...) is,
        // NOT on line 5 (0-indexed: line 4) where 'return out;' is.
        const errorLine = semicolonDiag!.range.start.line; // 0-indexed
        assert.ok(
            errorLine <= 2,
            `Semicolon error should be on line 3 (0-indexed: 2) where make_float3() is, ` +
            `but was on line ${errorLine + 1} (0-indexed: ${errorLine}). ` +
            `The error should point to where the semicolon is missing, not the next statement.`
        );
    });

    test('DCTL with DEFINE_UI_PARAMS and syntax error should report correct line numbers', async function () {
        this.timeout(30000);

        // sample2.dctl content: line 17 has incomplete `rgb.y = _fmax` (missing `f(...)` and `;`)
        // The file has 22 lines. DEFINE_UI_PARAMS macros generate prepended declarations,
        // but error line numbers must refer to the ORIGINAL source lines.
        const source =
`DEFINE_UI_PARAMS(min_val, Minimum Value, DCTLUI_VALUE_BOX, 0.0f)
DEFINE_UI_PARAMS(max_val, Maximum Value, DCTLUI_VALUE_BOX, 1.0f)

DEFINE_UI_PARAMS(clamp_min, Clamp Min, DCTLUI_CHECK_BOX, 1)
DEFINE_UI_PARAMS(clamp_max, Clamp Max, DCTLUI_CHECK_BOX, 1)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 rgb = make_float3(p_R, p_G, p_B);
    rgb.x = _clampf(rgb.x, min_val, max_val);
    rgb.y = _clampf(rgb.y, min_val, max_val);
    rgb.z = _clampf(rgb.z, min_val, max_val);

    // If clamp_min is checked, then clamp the min
    if (clamp_min == 1) {
        rgb.x = _fmaxf(rgb.x, min_val);
        rgb.y = _fmax
    }

    // If clam_max is checked, then clamp the max
    return rgb;
}`;
        const totalLines = source.split('\n').length; // 22

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // 1. All error line numbers must be within the actual file range (1-based: 1..22)
        for (const d of diagnostics) {
            const line1Based = d.range.start.line + 1;
            assert.ok(
                line1Based >= 1 && line1Based <= totalLines,
                `Diagnostic line ${line1Based} is outside file range 1-${totalLines}: [${d.code}] ${d.message}`
            );
        }

        // 2. Should NOT have DCTL001 "Missing transform" - the transform function IS defined
        const dctl001 = diagnostics.find(d => d.code === 'DCTL001');
        assert.strictEqual(
            dctl001,
            undefined,
            `Should not report DCTL001 "Missing transform" when transform function exists. ` +
            `Got: ${diagnostics.map(d => `[${d.code}] line ${d.range.start.line + 1}: ${d.message}`).join('; ')}`
        );

        // 3. Should have a syntax error (Expected ;) near line 17 (the _fmax line)
        const syntaxErrors = diagnostics.filter(d => d.code === 'DCTL011');
        assert.ok(syntaxErrors.length > 0, 'Should report at least one syntax error (DCTL011)');

        const semicolonError = syntaxErrors.find(d => d.message.includes(';'));
        assert.ok(semicolonError, `Should have a semicolon error. Got: ${syntaxErrors.map(d => d.message).join(', ')}`);

        // The semicolon error should be on or near line 17 (0-indexed: 16), NOT shifted by preprocessor offset
        const errorLine = semicolonError!.range.start.line + 1; // 1-based
        assert.ok(
            errorLine >= 16 && errorLine <= 18,
            `Semicolon error should be near line 17 (the _fmax line), ` +
            `but was on line ${errorLine}. Preprocessor lineOffset may not be subtracted.`
        );

        // 4. Should NOT have "Expected }" at a non-existent line (line > 22)
        const braceErrors = syntaxErrors.filter(d => d.message.includes('}'));
        for (const d of braceErrors) {
            const bLine = d.range.start.line + 1;
            assert.ok(
                bLine <= totalLines,
                `"Expected }" error at line ${bLine} exceeds file length ${totalLines}`
            );
        }
    });

    test('incomplete assignment should not cause false DCTL001 or out-of-range errors', async function () {
        this.timeout(30000);

        // sample2.dctl: line 18 has `rgb.z = ` with missing expression and semicolon.
        // The file has 23 lines.
        const source =
`DEFINE_UI_PARAMS(min_val, Minimum Value, DCTLUI_VALUE_BOX, 0.0f)
DEFINE_UI_PARAMS(max_val, Maximum Value, DCTLUI_VALUE_BOX, 1.0f)

DEFINE_UI_PARAMS(clamp_min, Clamp Min, DCTLUI_CHECK_BOX, 1)
DEFINE_UI_PARAMS(clamp_max, Clamp Max, DCTLUI_CHECK_BOX, 1)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 rgb = make_float3(p_R, p_G, p_B);
    rgb.x = _clampf(rgb.x, min_val, max_val);
    rgb.y = _clampf(rgb.y, min_val, max_val);
    rgb.z = _clampf(rgb.z, min_val, max_val);

    // If clamp_min is checked, then clamp the min
    if (clamp_min == 1) {
        rgb.x = _fmaxf(rgb.x, min_val);
        rgb.y = _fmaxf(rgb.y, min_val);
        rgb.z =
    }

    // If clam_max is checked, then clamp the max
    return rgb;
}`;
        const totalLines = source.split('\n').length; // 23

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // 1. Should NOT have DCTL001 - transform function IS defined
        const dctl001 = diagnostics.find(d => d.code === 'DCTL001');
        assert.strictEqual(
            dctl001,
            undefined,
            `Should not report DCTL001 when transform exists. ` +
            `Got: ${diagnostics.map(d => `[${d.code}] line ${d.range.start.line + 1}: ${d.message}`).join('; ')}`
        );

        // 2. All error line numbers must be within file range (1..23)
        for (const d of diagnostics) {
            const line1Based = d.range.start.line + 1;
            assert.ok(
                line1Based >= 1 && line1Based <= totalLines,
                `Diagnostic line ${line1Based} is outside file range 1-${totalLines}: [${d.code}] ${d.message}`
            );
        }

        // 3. Should have at least one syntax error near line 18-19 (the incomplete `rgb.z = `)
        const syntaxErrors = diagnostics.filter(d => d.code === 'DCTL011');
        assert.ok(syntaxErrors.length > 0, 'Should report at least one syntax error');

        const hasErrorNearLine18 = syntaxErrors.some(d => {
            const line = d.range.start.line + 1;
            return line >= 17 && line <= 20;
        });
        assert.ok(
            hasErrorNearLine18,
            `Should have a syntax error near line 18-19 (incomplete assignment). ` +
            `Got errors at: ${syntaxErrors.map(d => `line ${d.range.start.line + 1}`).join(', ')}`
        );

        // 4. Should NOT have "Expected }" at the function closing brace (line 23)
        //    The function body is properly closed; the error is only inside the if block.
        const braceErrorAtEnd = syntaxErrors.find(d =>
            d.message.includes('}') && d.range.start.line + 1 === totalLines
        );
        assert.strictEqual(
            braceErrorAtEnd,
            undefined,
            `Should not report "Expected }" at file end (line ${totalLines}) - ` +
            `the function closing brace is correct`
        );
    });

    test('return without semicolon should report error at return line with minimal cascading', async function () {
        this.timeout(30000);

        // sample2.dctl: line 13 has `return ` without value or semicolon.
        // The remaining code (if blocks, return rgb;) is syntactically valid.
        // The parser should report an error near line 13 and recover gracefully
        // without cascading into dozens of errors.
        const source =
`DEFINE_UI_PARAMS(min_val, Minimum Value, DCTLUI_VALUE_BOX, 0.0f)
DEFINE_UI_PARAMS(max_val, Maximum Value, DCTLUI_VALUE_BOX, 1.0f)

DEFINE_UI_PARAMS(clamp_min, Clamp Min, DCTLUI_CHECK_BOX, 1)
DEFINE_UI_PARAMS(clamp_max, Clamp Max, DCTLUI_CHECK_BOX, 1)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 rgb = make_float3(p_R, p_G, p_B);
    rgb.x = _clampf(rgb.x, min_val, max_val);
    rgb.y = _clampf(rgb.y, min_val, max_val);
    rgb.z = _clampf(rgb.z, min_val, max_val);
    return

    // If clamp_min is checked, then clamp the min
    if (clamp_min == 1) {
        rgb.x = _fmaxf(rgb.x, min_val);
        rgb.y = _fmaxf(rgb.y, min_val);
        rgb.z = _fmaxf(rgb.z, min_val);
    }

    if (clamp_max == 1) {
        rgb.x = _fminf(rgb.x, max_val);
        rgb.y = _fminf(rgb.y, max_val);
        rgb.z = _fminf(rgb.z, max_val);
    }

    // If clam_max is checked, then clamp the max
    return rgb;
}`;
        const totalLines = source.split('\n').length; // 30

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // 1. Should NOT have DCTL001 - transform function IS defined
        const dctl001 = diagnostics.find(d => d.code === 'DCTL001');
        assert.strictEqual(
            dctl001,
            undefined,
            `Should not report DCTL001 when transform exists. ` +
            `Got: ${diagnostics.map(d => `[${d.code}] line ${d.range.start.line + 1}: ${d.message}`).join('; ')}`
        );

        // 2. All error line numbers must be within the actual file range (1-based: 1..30)
        for (const d of diagnostics) {
            const line1Based = d.range.start.line + 1;
            assert.ok(
                line1Based >= 1 && line1Based <= totalLines,
                `Diagnostic line ${line1Based} is outside file range 1-${totalLines}: [${d.code}] ${d.message}`
            );
        }

        // 3. Should have a syntax error on or near line 13 (the `return` line)
        //    NOT at line 16 (the `if` line) — `return` is where the error is
        const syntaxErrors = diagnostics.filter(d => d.code === 'DCTL011');
        assert.ok(syntaxErrors.length > 0, 'Should report at least one syntax error (DCTL011)');

        const hasErrorNearReturnLine = syntaxErrors.some(d => {
            const line = d.range.start.line + 1;
            return line >= 13 && line <= 14;
        });
        assert.ok(
            hasErrorNearReturnLine,
            `Should have a syntax error near line 13-14 (the incomplete return). ` +
            `Got errors at: ${syntaxErrors.map(d => `line ${d.range.start.line + 1}: ${d.message}`).join(', ')}`
        );

        // 4. Should have minimal cascading errors (≤ 3 syntax errors, not 10+)
        assert.ok(
            syntaxErrors.length <= 3,
            `Should have at most 3 syntax errors (minimal cascading), but got ${syntaxErrors.length}: ` +
            `${syntaxErrors.map(d => `line ${d.range.start.line + 1}: ${d.message}`).join('; ')}`
        );
    });

    test('valid DCTL should produce no syntax errors', async function () {
        this.timeout(30000);

        const source =
`__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float3 rgb = make_float3(p_R, p_G, p_B);
    return rgb;
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // Filter for syntax errors only (DCTL011)
        const syntaxErrors = diagnostics.filter(d => d.code === 'DCTL011');
        assert.strictEqual(syntaxErrors.length, 0, `Valid DCTL should have no syntax errors, got: ${syntaxErrors.map(d => d.message).join(', ')}`);
    });
});

suite('DCTL Semantic Warning Tests', () => {

    test('unused variable should produce SEM_W002 warning', async function () {
        this.timeout(30000);

        const source =
`__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float unused = 1.0f;
    return make_float3(p_R, p_G, p_B);
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message} (${d.severity})`);
        }

        // Should have SEM_W002 warning for unused variable
        const semWarnings = diagnostics.filter(d => d.code === 'SEM_W002');
        assert.ok(
            semWarnings.length > 0,
            `Should report SEM_W002 for unused variable 'unused'. ` +
            `Got: ${diagnostics.map(d => `[${d.code}] ${d.message}`).join('; ')}`
        );

        const unusedWarning = semWarnings.find(d => d.message.includes('unused'));
        assert.ok(unusedWarning, 'SEM_W002 should mention the variable name');

        // Should be a Warning severity (not Error)
        assert.strictEqual(
            unusedWarning!.severity,
            vscode.DiagnosticSeverity.Warning,
            'SEM_W002 should be Warning severity'
        );

        // Should be on line 3 (0-indexed: 2) where "float unused = 1.0f;" is
        assert.strictEqual(
            unusedWarning!.range.start.line,
            2,
            `SEM_W002 should be on line 3 (0-indexed: 2), got line ${unusedWarning!.range.start.line + 1}`
        );
    });

    test('unused function should produce SEM_W003 warning', async function () {
        this.timeout(30000);

        const source =
`__DEVICE__ float helper(float x) {
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message} (${d.severity})`);
        }

        // Should have SEM_W003 warning for unused function
        const semWarnings = diagnostics.filter(d => d.code === 'SEM_W003');
        assert.ok(
            semWarnings.length > 0,
            `Should report SEM_W003 for unused function 'helper'. ` +
            `Got: ${diagnostics.map(d => `[${d.code}] ${d.message}`).join('; ')}`
        );

        const helperWarning = semWarnings.find(d => d.message.includes('helper'));
        assert.ok(helperWarning, 'SEM_W003 should mention the function name');

        // Should be a Warning severity
        assert.strictEqual(
            helperWarning!.severity,
            vscode.DiagnosticSeverity.Warning,
            'SEM_W003 should be Warning severity'
        );

        // Should be on line 1 (0-indexed: 0) where "float helper(...)" is
        assert.strictEqual(
            helperWarning!.range.start.line,
            0,
            `SEM_W003 should be on line 1 (0-indexed: 0), got line ${helperWarning!.range.start.line + 1}`
        );
    });

    test('entry point parameters should not produce unused warnings', async function () {
        this.timeout(30000);

        // p_Width, p_Height, p_X, p_Y are not used but should NOT trigger SEM_W002
        const source =
`__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // Should NOT have SEM_W002 for any p_ prefixed parameters
        const paramWarnings = diagnostics.filter(d =>
            d.code === 'SEM_W002' && (
                d.message.includes('p_Width') ||
                d.message.includes('p_Height') ||
                d.message.includes('p_X') ||
                d.message.includes('p_Y')
            )
        );
        assert.strictEqual(
            paramWarnings.length,
            0,
            `Entry point parameters (p_Width, p_Height, etc.) should not trigger SEM_W002. ` +
            `Got: ${paramWarnings.map(d => d.message).join('; ')}`
        );
    });

    test('entry point function should not produce unused warning', async function () {
        this.timeout(30000);

        const source =
`__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    return make_float3(p_R, p_G, p_B);
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // Should NOT have SEM_W003 for transform
        const transformWarning = diagnostics.find(d =>
            d.code === 'SEM_W003' && d.message.includes('transform')
        );
        assert.strictEqual(
            transformWarning,
            undefined,
            `Entry point 'transform' should not trigger SEM_W003`
        );
    });

    test('semantic warning line numbers should be correct with DEFINE_UI_PARAMS', async function () {
        this.timeout(30000);

        // Line 1: DEFINE_UI_PARAMS(gain, ...)
        // Line 2: (empty)
        // Line 3: __DEVICE__ float3 transform(...) {
        // Line 4:     float unused = 1.0f;        <-- SEM_W002 expected here
        // Line 5:     return make_float3(...);
        // Line 6: }
        const source =
`DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float unused = 1.0f;
    return make_float3(p_R * gain, p_G, p_B);
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        const unusedWarning = diagnostics.find(d =>
            d.code === 'SEM_W002' && d.message.includes('unused')
        );
        assert.ok(unusedWarning, 'Should have SEM_W002 for unused variable');

        // Should be on line 5 (0-indexed: 4), NOT shifted by preprocessor header
        const warningLine = unusedWarning!.range.start.line + 1; // 1-based
        assert.strictEqual(
            warningLine,
            5,
            `SEM_W002 for 'unused' should be on line 5, but was on line ${warningLine}. ` +
            `Line number may be shifted by preprocessor header offset.`
        );
    });

    test('used helper function should not produce SEM_W003', async function () {
        this.timeout(30000);

        const source =
`__DEVICE__ float helper(float x) {
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float r = helper(p_R);
    return make_float3(r, p_G, p_B);
}`;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics:`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // helper IS used, so should NOT have SEM_W003 for it
        const helperWarning = diagnostics.find(d =>
            d.code === 'SEM_W003' && d.message.includes('helper')
        );
        assert.strictEqual(
            helperWarning,
            undefined,
            `Used function 'helper' should not trigger SEM_W003`
        );
    });

    test('all diagnostic line numbers should be within file range', async function () {
        this.timeout(30000);

        // DCTL with DEFINE_UI_PARAMS + unused variable + unused function
        // All diagnostics (errors and warnings) must have line numbers within the file
        const source =
`DEFINE_UI_PARAMS(gain, Gain, DCTLUI_SLIDER_FLOAT, 1.0, 0.0, 2.0, 0.01)
DEFINE_UI_PARAMS(offset, Offset, DCTLUI_SLIDER_FLOAT, 0.0, -1.0, 1.0, 0.01)

__DEVICE__ float unused_helper(float x) {
    return x * 2.0f;
}

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float unused_var = 1.0f;
    return make_float3(p_R * gain + offset, p_G, p_B);
}`;
        const totalLines = source.split('\n').length;

        const diagnostics = await getDiagnosticsForSource(source);

        console.log(`Got ${diagnostics.length} diagnostics (file has ${totalLines} lines):`);
        for (const d of diagnostics) {
            console.log(`  line ${d.range.start.line + 1}, col ${d.range.start.character + 1}: [${d.code}] ${d.message}`);
        }

        // ALL diagnostic line numbers must be within the file range
        for (const d of diagnostics) {
            const line1Based = d.range.start.line + 1;
            assert.ok(
                line1Based >= 1 && line1Based <= totalLines,
                `Diagnostic [${d.code}] line ${line1Based} is outside file range 1-${totalLines}: ${d.message}`
            );
        }

        // Should have warnings (SEM_W002 for unused_var, SEM_W003 for unused_helper)
        const semWarnings = diagnostics.filter(d =>
            d.code === 'SEM_W002' || d.code === 'SEM_W003'
        );
        assert.ok(
            semWarnings.length >= 2,
            `Should have at least 2 semantic warnings (unused var + unused function). ` +
            `Got ${semWarnings.length}: ${semWarnings.map(d => `[${d.code}] ${d.message}`).join('; ')}`
        );

        // Should NOT have syntax errors
        const syntaxErrors = diagnostics.filter(d => d.code === 'DCTL011');
        assert.strictEqual(syntaxErrors.length, 0, 'Valid DCTL should have no syntax errors');
    });
});

suite('DCTL Include File Diagnostics Tests', () => {

    test('syntax error in included header should be reported on header file URI', async function () {
        this.timeout(30000);

        // Create temp directory with main.dctl and header.h
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dctl-include-test-'));
        const headerFile = path.join(tmpDir, 'helpers.h');
        const mainFile = path.join(tmpDir, 'main.dctl');

        // Header has a syntax error: missing semicolon on the return statement
        fs.writeFileSync(headerFile, `__DEVICE__ float helper(float x) {
    return x * 2.0f
}
`, 'utf-8');

        // Main file includes the header and uses the helper
        fs.writeFileSync(mainFile, `#include "helpers.h"

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float r = helper(p_R);
    return make_float3(r, p_G, p_B);
}
`, 'utf-8');

        const mainUri = vscode.Uri.file(mainFile);
        const headerUri = vscode.Uri.file(headerFile);

        const doc = await vscode.workspace.openTextDocument(mainUri);
        if (doc.languageId !== 'dctl') {
            await vscode.languages.setTextDocumentLanguage(doc, 'dctl');
        }
        await vscode.window.showTextDocument(doc);

        // Wait for diagnostics to stabilize
        await waitForStableDiagnostics(mainUri, 2000, 15000);

        // Check diagnostics on the HEADER file URI
        const headerDiags = vscode.languages.getDiagnostics(headerUri);

        console.log(`Header diagnostics (${headerDiags.length}):`);
        for (const d of headerDiags) {
            console.log(`  line ${d.range.start.line + 1}: [${d.code}] ${d.message}`);
        }

        // The header file should have at least one diagnostic (syntax error)
        assert.ok(
            headerDiags.length > 0,
            `Syntax error in included header should be reported on header file URI. ` +
            `Got 0 diagnostics for ${headerFile}`
        );

        // Clean up
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        try {
            fs.unlinkSync(mainFile);
            fs.unlinkSync(headerFile);
            fs.rmdirSync(tmpDir);
        } catch { /* ignore */ }
    });

    test('valid included header should produce no diagnostics on header URI', async function () {
        this.timeout(30000);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dctl-include-test-'));
        const headerFile = path.join(tmpDir, 'helpers.h');
        const mainFile = path.join(tmpDir, 'main.dctl');

        // Valid header — no errors
        fs.writeFileSync(headerFile, `__DEVICE__ float helper(float x) {
    return x * 2.0f;
}
`, 'utf-8');

        fs.writeFileSync(mainFile, `#include "helpers.h"

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B)
{
    float r = helper(p_R);
    return make_float3(r, p_G, p_B);
}
`, 'utf-8');

        const mainUri = vscode.Uri.file(mainFile);
        const headerUri = vscode.Uri.file(headerFile);

        const doc = await vscode.workspace.openTextDocument(mainUri);
        if (doc.languageId !== 'dctl') {
            await vscode.languages.setTextDocumentLanguage(doc, 'dctl');
        }
        await vscode.window.showTextDocument(doc);

        await waitForStableDiagnostics(mainUri, 2000, 15000);

        const headerDiags = vscode.languages.getDiagnostics(headerUri);

        console.log(`Header diagnostics (${headerDiags.length}):`);
        for (const d of headerDiags) {
            console.log(`  line ${d.range.start.line + 1}: [${d.code}] ${d.message}`);
        }

        // Valid header should have no syntax errors
        const syntaxErrors = headerDiags.filter(d => d.code === 'DCTL011');
        assert.strictEqual(
            syntaxErrors.length, 0,
            `Valid header should have no syntax errors. Got: ${syntaxErrors.map(d => d.message).join(', ')}`
        );

        // Clean up
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        try {
            fs.unlinkSync(mainFile);
            fs.unlinkSync(headerFile);
            fs.rmdirSync(tmpDir);
        } catch { /* ignore */ }
    });
});
