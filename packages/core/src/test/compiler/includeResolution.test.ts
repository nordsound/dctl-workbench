/**
 * Include Resolution Tests
 *
 * Bug: DCTL files with #include directives fail to compile in EXR Viewer
 * because DctlCompiler.compile() does not resolve #include directives,
 * and the shader builder calls compile() with raw source.
 *
 * Fix: Add optional mainFilePath to compile() so it resolves #include
 * directives before compilation.
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DctlCompiler, isCompileError } from '../../compiler/index';
import type { CompileResult } from '../../types/index';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const WASM_PATH = REPO_ROOT;
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

describe('Include resolution for Rust compiler', function () {
    this.timeout(30000);

    let compiler: DctlCompiler;

    before(async () => {
        compiler = new DctlCompiler();
        await compiler.init(WASM_PATH);
    });

    it('should compile DCTL with #include when mainFilePath is provided to compile()', () => {
        const source = fs.readFileSync(path.join(FIXTURES_DIR, 'test_include.dctl'), 'utf-8');
        const mainFilePath = path.join(FIXTURES_DIR, 'test_include.dctl');

        // compile() should resolve #include when given a file path
        const result = compiler.compile(source, { mainFilePath });
        assert.ok(!isCompileError(result), `Expected success but got: ${isCompileError(result) ? result.message : ''}`);

        const compileResult = result as CompileResult;
        assert.ok(compileResult.wgsl.length > 0, 'Expected non-empty WGSL');
        assert.ok(compileResult.wgsl.includes('apply_gain'), 'WGSL should contain included function');
    });

    it('should fail when compile() is called without file path on #include source', () => {
        const source = fs.readFileSync(path.join(FIXTURES_DIR, 'test_include.dctl'), 'utf-8');

        // Without file path, #include cannot be resolved
        const result = compiler.compile(source);
        assert.ok(isCompileError(result), 'compile() without mainFilePath should fail for #include source');
    });

    it('should compile normally when source has no #include', () => {
        const source = fs.readFileSync(path.join(FIXTURES_DIR, 'test_gain.dctl'), 'utf-8');

        // No #include, should work without file path
        const result = compiler.compile(source);
        assert.ok(!isCompileError(result), `Expected success but got: ${isCompileError(result) ? result.message : ''}`);
    });
});
