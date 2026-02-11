# Testing Guide

Comprehensive guide for testing DCTL Workbench.

## Test Strategy

### Principles

1. **Core-centric Testing**: Business logic in `packages/core` is tested independently
2. **Thin Wrapper Testing**: CLI and VS Code tests focus on integration, not logic
3. **Coverage Target**: Maintain **80% or higher** test coverage
4. **Automated Testing**: All features must have automated tests

### Test Pyramid

```text
        ┌───────────────┐
        │   VS Code     │  ← UI/Integration tests (slow)
        │  Integration  │
        ├───────────────┤
        │     CLI       │  ← End-to-end tests (medium)
        │  Integration  │
        ├───────────────┤
        │     Core      │  ← Unit tests (fast)
        │     Unit      │
        └───────────────┘
```

## Test Frameworks

| Package  | Framework                      | Runner         | Coverage |
|----------|--------------------------------|----------------|----------|
| core     | Mocha                          | mocha          | c8       |
| cli      | Mocha                          | mocha          | c8       |
| vscode   | Mocha + @vscode/test-electron  | mocha/vscode   | -        |

## Running Tests

### All Tests

```bash
# Run all package tests
npm test

# Run with coverage
npm run test:coverage
```

### Package-specific Tests

```bash
# Core tests (fast, no dependencies)
cd packages/core
npm test              # Run with coverage
npm run test:unit     # Run without coverage

# CLI tests
cd packages/cli
npm test              # Run with coverage
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests only

# VS Code extension tests
cd packages/vscode
npm test              # Unit tests via ts-node (no VS Code)
npm run test:unit     # Same as above
npm run test:integration  # Compile + launch VS Code for integration tests
```

## Test Structure

### packages/core

```text
packages/core/src/test/
├── parser/
│   ├── lexer.test.ts                    # Tokenizer tests
│   ├── dctlParser.test.ts              # Parser tests
│   ├── dctlPreprocessor.test.ts        # Preprocessor tests
│   └── uiParamExtractor.test.ts        # UI parameter extraction
├── shader/
│   ├── shader.test.ts                   # Shader builder tests
│   ├── glsl-utils.test.ts              # GLSL utility tests
│   ├── aces-rgc-shader-builder.test.ts  # RGC shader builder tests
│   ├── exportLinearWorkingSpace.test.ts # Export linear space tests
│   └── rgc-cpu-verification.test.ts     # RGC CPU verification (WASM)
└── color-space/
    ├── colorSpace.test.ts               # Color space conversion tests
    ├── aces-compliance.test.ts          # ACES compliance test suite
    └── bandingInvestigation.test.ts     # Banding investigation tests
```

### packages/cli

```text
packages/cli/src/test/
├── shader-builder.test.ts        # Shader building tests
├── rgc-shader-builder.test.ts    # RGC shader tests
├── rgc-shader-execution.test.ts  # RGC execution tests
├── exr-export-integration.test.ts # EXR export tests
├── rgc-gpu-comparison.test.ts    # RGC GPU vs CPU comparison
└── rgc-texture-debug.test.ts     # RGC texture debugging
```

### packages/vscode

```text
packages/vscode/src/test/
├── mocks/                          # Test mocks
│   └── webgpu-mock.ts
├── unit/                           # Unit tests (no VS Code required)
│   ├── dctl-export-function.test.ts
│   ├── dctl-export-integration.test.ts
│   ├── dctl-export-rgc.test.ts
│   ├── dctl-export-shader.test.ts
│   ├── dctl-param-buffer.test.ts
│   ├── export-float32-filterable.test.ts
│   ├── pan-controller.test.ts
│   ├── rgc-export-pipeline.test.ts
│   ├── rgc-source-verification.test.ts
│   └── rgc-wgsl-processing.test.ts
└── integration/                    # Integration tests (requires VS Code)
    ├── basic.test.ts
    ├── extension-activation.test.ts
    ├── module-availability.test.ts
    ├── dctl-diagnostics.test.ts
    ├── working-colorspace-change.test.ts
    ├── compute-shader-rgc.test.ts
    ├── rgc-export-verification.test.ts
    ├── rgc-reference-compare.test.ts
    ├── webgpu-real-rgc.test.ts
    ├── webview-rgc-*.test.ts       # Multiple RGC E2E tests
    └── _disabled/                  # Temporarily disabled tests
```

## Writing Tests

### Unit Test Example (Core)

```typescript
import * as assert from 'assert';
import { DctlParser } from '../../parser/dctlParser';

describe('DctlParser', () => {
    describe('parse()', () => {
        it('should parse simple DCTL function', () => {
            const source = `
                __DEVICE__ float3 transform(int p_Width, int p_Height,
                    int p_X, int p_Y, float p_R, float p_G, float p_B) {
                    return make_float3(p_R, p_G, p_B);
                }
            `;
            const parser = new DctlParser();
            const result = parser.parse(source);

            assert.ok(result.ast, 'AST should be generated');
            assert.strictEqual(result.errors.length, 0, 'No errors expected');
        });

        it('should report syntax errors', () => {
            const source = 'invalid syntax {{{';
            const parser = new DctlParser();
            const result = parser.parse(source);

            assert.ok(result.errors.length > 0, 'Errors expected');
        });
    });
});
```

### Integration Test Example (CLI)

```typescript
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { applyDctl } from '../applyDctl';

describe('DCTL Apply Integration', () => {
    const testDir = path.join(__dirname, 'fixtures');
    const inputExr = path.join(testDir, 'input.exr');
    const outputExr = path.join(testDir, 'output.exr');

    afterEach(() => {
        if (fs.existsSync(outputExr)) {
            fs.unlinkSync(outputExr);
        }
    });

    it('should apply DCTL effect to EXR', async () => {
        const dctlSource = `
            __DEVICE__ float3 transform(int p_Width, int p_Height,
                int p_X, int p_Y, float p_R, float p_G, float p_B) {
                return make_float3(p_R * 2.0, p_G * 2.0, p_B * 2.0);
            }
        `;

        await applyDctl({
            dctlSource,
            inputPath: inputExr,
            outputPath: outputExr,
        });

        assert.ok(fs.existsSync(outputExr), 'Output EXR should be created');
    });
});
```

### VS Code Integration Test Example

```typescript
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Activation', () => {
    test('Extension should activate', async () => {
        const ext = vscode.extensions.getExtension('your-publisher.dctl-workbench');
        assert.ok(ext, 'Extension should be present');

        await ext.activate();
        assert.ok(ext.isActive, 'Extension should be active');
    });

    test('DCTL language should be registered', async () => {
        const languages = await vscode.languages.getLanguages();
        assert.ok(languages.includes('dctl'), 'DCTL language should be registered');
    });
});
```

## Test Guidelines

### Do

- Test one thing per test case
- Use descriptive test names
- Test edge cases and error conditions
- Clean up test artifacts (files, state)
- Mock external dependencies when appropriate

### Don't

- Test implementation details
- Write tests that depend on execution order
- Skip tests without explanation
- Commit failing tests

## Coverage Requirements

### Thresholds

| Metric     | Minimum |
|------------|---------|
| Lines      | 80%     |
| Functions  | 80%     |
| Branches   | 75%     |
| Statements | 80%     |

### Checking Coverage

```bash
# Run tests with coverage
npm test

# Generate HTML report
npm run coverage

# View report
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
```

### Coverage Reports

Coverage reports are generated in:
- `packages/core/coverage/`
- `packages/cli/coverage/`

## Test Configuration

### tsconfig.test.json

Each package has a separate test TypeScript configuration:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "out"
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

### Mocha Configuration

Tests use inline configuration in package.json scripts:

```bash
mocha 'out/test/**/*.test.js'
```

For VS Code tests with ts-node:

```bash
TS_NODE_PROJECT=tsconfig.test.json mocha --require ts-node/register 'src/test/unit/**/*.test.ts'
```

## CI/CD Integration

Tests run automatically on:
- Pull request creation
- Push to main branch

### GitHub Actions Workflow

```yaml
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
    - run: npm ci
    - run: npm run build
    - run: npm test
```

## Debugging Tests

### VS Code Launch Configuration

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Core Tests",
  "program": "${workspaceFolder}/node_modules/mocha/bin/_mocha",
  "args": [
    "${workspaceFolder}/packages/core/out/test/**/*.test.js"
  ],
  "cwd": "${workspaceFolder}/packages/core",
  "console": "integratedTerminal"
}
```

### Running Single Test

```bash
# Run specific test file
npx mocha 'out/test/parser/lexer.test.js'

# Run tests matching pattern
npx mocha --grep "should parse" 'out/test/**/*.test.js'
```

## Troubleshooting

### Tests Not Found

- Ensure TypeScript is compiled: `npm run build`
- Check glob pattern matches file locations

### WASM Module Errors

- Build WASM modules first: `npm run build:wasm`
- Check WASM files exist in `wasm/` directory

### VS Code Integration Tests Fail

- Ensure no other VS Code instance is running
- Check display is available (use `xvfb-run` on headless Linux)
- Verify extension builds successfully: `npm run build:vscode`

### Extension Host Shutdown Crash (exit code 6)

The Extension Host process crashes with SIGABRT (exit code 6) during shutdown after all integration tests have passed. This is caused by `webgpu-real-rgc.test.ts` which uses the `webgpu` npm module (Dawn backend). The Dawn native GPU instance created by `webgpu.create([])` has no destroy/cleanup API, so native resources are not properly released before the Extension Host exits.

**Error pattern:**

```text
Extension host with pid XXXX exited with code: 6, signal: unknown.
[UtilityProcess id: 1, type: extensionHost, pid: XXXX]: crashed with code 6 and reason 'crashed'
```

**Confirmed:** Excluding `webgpu-real-rgc.test.ts` results in clean exit (code 0). The crash does not affect test results.

**Workaround:** The `scripts/run-integration-tests.sh` wrapper detects exit code 6 and treats it as success when no test failures are reported.

### Coverage Not Collected

- Use `c8` with correct include/exclude patterns
- Ensure source maps are generated
- Check compiled JS files are in expected locations
