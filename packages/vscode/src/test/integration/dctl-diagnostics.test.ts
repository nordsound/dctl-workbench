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

    // Wait for diagnostics to be computed (debounce + processing)
    const diagnostics = await waitForDiagnostics(uri, 10000);

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch { /* ignore */ }

    return diagnostics;
}

/**
 * Wait for diagnostics to appear on a URI, with timeout.
 */
function waitForDiagnostics(uri: vscode.Uri, timeoutMs: number): Promise<vscode.Diagnostic[]> {
    return new Promise((resolve) => {
        // Check if diagnostics are already available
        const existing = vscode.languages.getDiagnostics(uri);
        if (existing.length > 0) {
            resolve(existing);
            return;
        }

        const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
            if (e.uris.some(u => u.toString() === uri.toString())) {
                const diags = vscode.languages.getDiagnostics(uri);
                if (diags.length > 0) {
                    disposable.dispose();
                    clearTimeout(timer);
                    resolve(diags);
                }
            }
        });

        const timer = setTimeout(() => {
            disposable.dispose();
            // Return whatever is available (may be empty)
            resolve(vscode.languages.getDiagnostics(uri));
        }, timeoutMs);
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
