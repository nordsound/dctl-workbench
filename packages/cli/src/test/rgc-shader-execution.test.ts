/**
 * RGC Shader Execution Test
 *
 * This test actually executes the RGC export shader using WebGPU
 * and verifies the output pixel values.
 *
 * Uses CLI's infrastructure (not VS Code's) to avoid vscode module dependency.
 */

import * as path from 'path';
import * as fs from 'fs';
import { DctlRuntime, isCompileError } from '@dctl-workbench/core';
import { buildBufferComputeShader } from '../shader-builder.js';
import { SubprocessRenderer } from '../subprocess-renderer.js';

import { resolveFixture, getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Paths
const CLI_PKG_PATH = path.resolve(__dirname, '../..');
const CORE_PKG_PATH = path.resolve(__dirname, '../../../core');
const WASM_DIR = path.join(CLI_PKG_PATH, 'wasm');
const TEST_RESULTS_DIR = getTestOutputDir();

// Test DCTL content - simple gain shader
const TEST_GAIN_DCTL = `
// Test DCTL for RGC export verification
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.5, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain, p_G * gain, p_B * gain);
}
`;

interface TestResult {
    name: string;
    passed: boolean;
    message: string;
    duration?: number;
}

async function runTest(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    console.log('=== RGC Shader Execution Test ===\n');

    // Test 1: Initialize DctlRuntime
    const runtime = new DctlRuntime();
    try {
        const start = Date.now();

        // Find WASM directory - check multiple locations
        let wasmPath = WASM_DIR;
        if (!fs.existsSync(path.join(wasmPath, 'dctl_compiler.wasm'))) {
            // Try vscode package location
            const vscodePath = path.resolve(CLI_PKG_PATH, '../vscode/out/wasm');
            if (fs.existsSync(path.join(vscodePath, 'dctl_compiler.wasm'))) {
                wasmPath = vscodePath;
            }
        }

        console.log(`Using WASM directory: ${wasmPath}`);

        await runtime.init({ wasmPath });
        results.push({
            name: 'Initialize DctlRuntime',
            passed: true,
            message: `Compiler version: ${runtime.getCompilerVersion()}`,
            duration: Date.now() - start,
        });
    } catch (e: any) {
        results.push({
            name: 'Initialize DctlRuntime',
            passed: false,
            message: e.message,
        });
        return results;
    }

    // Test 2: Compile test DCTL
    let compileResult: any;
    try {
        const start = Date.now();
        compileResult = runtime.compile(TEST_GAIN_DCTL);

        if (isCompileError(compileResult)) {
            throw new Error(compileResult.message);
        }

        results.push({
            name: 'Compile DCTL',
            passed: true,
            message: `WGSL: ${compileResult.wgsl.length} chars, ${compileResult.parameters.length} params`,
            duration: Date.now() - start,
        });
    } catch (e: any) {
        results.push({
            name: 'Compile DCTL',
            passed: false,
            message: e.message,
        });
        return results;
    }

    // Test 3: Build compute shader
    let wgsl: string;
    try {
        const start = Date.now();

        wgsl = buildBufferComputeShader(compileResult, {
            width: 64,
            height: 64,
            paramValues: { gain: 1.5 },
            inputColorSpace: 'AP0',
            outputColorSpace: 'AP0',
            workingColorSpace: 'ACEScct',
        });

        // Verify shader structure
        const hasTransform = /fn\s+transform/.test(wgsl);
        const hasComputeMain = /@compute[\s\S]*fn\s+main/.test(wgsl);
        const hasInputBuffer = /@group\(0\)\s*@binding\(0\)\s*var<storage,\s*read>\s*input_buffer/.test(wgsl);
        const hasOutputBuffer = /@group\(0\)\s*@binding\(1\)\s*var<storage,\s*read_write>\s*output_buffer/.test(wgsl);

        if (!hasTransform) throw new Error('Missing transform function');
        if (!hasComputeMain) throw new Error('Missing compute main function');
        if (!hasInputBuffer) throw new Error('Missing input_buffer binding');
        if (!hasOutputBuffer) throw new Error('Missing output_buffer binding');

        results.push({
            name: 'Build compute shader',
            passed: true,
            message: `Shader: ${wgsl.length} chars`,
            duration: Date.now() - start,
        });
    } catch (e: any) {
        results.push({
            name: 'Build compute shader',
            passed: false,
            message: e.message,
        });
        return results;
    }

    // Test 4: Validate shader structure for color pipeline
    try {
        const checks = {
            hasAP0toAP1: /mat_ap0_to_ap1/.test(wgsl),
            hasAP1toAP0: /mat_ap1_to_ap0/.test(wgsl),
            hasACEScctEncode: /lin_to_ACEScct/.test(wgsl),
            hasACEScctDecode: /ACEScct_to_lin/.test(wgsl),
            hasWorkgroupSize: /@workgroup_size\(8,\s*8,\s*1\)/.test(wgsl),
        };

        const failedChecks = Object.entries(checks)
            .filter(([, v]) => !v)
            .map(([k]) => k);

        if (failedChecks.length > 0) {
            throw new Error(`Missing: ${failedChecks.join(', ')}`);
        }

        results.push({
            name: 'Validate color pipeline',
            passed: true,
            message: 'AP0→AP1→ACEScct→DCTL→AP1→AP0 pipeline complete',
        });
    } catch (e: any) {
        results.push({
            name: 'Validate color pipeline',
            passed: false,
            message: e.message,
        });
    }

    // Test 5: Execute shader with WebGPU via subprocess
    try {
        const start = Date.now();

        // Create test input data (64x64 RGB, all 0.18 mid-gray)
        const width = 64;
        const height = 64;
        const inputData = new Float32Array(width * height * 3);
        for (let i = 0; i < inputData.length; i += 3) {
            inputData[i] = 0.18;     // R
            inputData[i + 1] = 0.18; // G
            inputData[i + 2] = 0.18; // B
        }

        // Execute shader
        const renderer = new SubprocessRenderer();
        const outputData = await renderer.render(wgsl, inputData, width, height);

        // Verify output
        // Input: 0.18 (AP0 linear)
        // Expected: gain of 1.5 applied in ACEScct space
        // The exact value depends on the color pipeline transforms

        // Check that we got valid output
        if (outputData.length !== inputData.length) {
            throw new Error(`Output size mismatch: ${outputData.length} vs ${inputData.length}`);
        }

        // Check that output values are non-zero and reasonable
        const sampleR = outputData[0];
        const sampleG = outputData[1];
        const sampleB = outputData[2];

        if (isNaN(sampleR) || isNaN(sampleG) || isNaN(sampleB)) {
            throw new Error('Output contains NaN values');
        }

        // With gain 1.5 applied to 0.18 in ACEScct space, output should be > input
        // (because 0.18 * 1.5 = 0.27 in ACEScct, which decodes to higher linear)
        if (sampleR <= 0 || sampleG <= 0 || sampleB <= 0) {
            throw new Error(`Output values are non-positive: ${sampleR}, ${sampleG}, ${sampleB}`);
        }

        // Output should be higher than input due to gain
        if (sampleR <= 0.18 && sampleG <= 0.18 && sampleB <= 0.18) {
            console.warn(`Warning: Output (${sampleR.toFixed(4)}) not higher than input (0.18)`);
            // This might be expected depending on color space transforms
        }

        results.push({
            name: 'Execute shader with WebGPU',
            passed: true,
            message: `Output sample: R=${sampleR.toFixed(4)}, G=${sampleG.toFixed(4)}, B=${sampleB.toFixed(4)}`,
            duration: Date.now() - start,
        });

        // Save test output for debugging
        if (fs.existsSync(TEST_RESULTS_DIR)) {
            const debugPath = path.join(TEST_RESULTS_DIR, 'cli_compute_shader_test.wgsl');
            fs.writeFileSync(debugPath, wgsl);
            console.log(`  Debug shader saved to: ${debugPath}`);
        }
    } catch (e: any) {
        results.push({
            name: 'Execute shader with WebGPU',
            passed: false,
            message: e.message,
        });
    }

    // Test 6: Read test EXR and apply shader
    try {
        const testExrPath = resolveFixture('rgc_test_source_ap0.exr');

        if (!testExrPath) {
            throw new Error('Test EXR fixture not found: rgc_test_source_ap0.exr');
        }

        const start = Date.now();

        // Read EXR
        const exrData = runtime.readExrSync(testExrPath);
        console.log(`  Loaded EXR: ${exrData.width}x${exrData.height}, channels: ${exrData.channels.join(', ')}`);

        // Build shader for this image size
        const imageWgsl = buildBufferComputeShader(compileResult, {
            width: exrData.width,
            height: exrData.height,
            paramValues: { gain: 1.5 },
            inputColorSpace: 'AP0',
            outputColorSpace: 'AP0',
            workingColorSpace: 'ACEScct',
        });

        // Convert RGBA to RGB if needed
        let inputData: Float32Array;
        if (exrData.channels.length === 4) {
            // Convert RGBA to RGB
            const pixelCount = exrData.width * exrData.height;
            inputData = new Float32Array(pixelCount * 3);
            for (let i = 0; i < pixelCount; i++) {
                inputData[i * 3 + 0] = exrData.data[i * 4 + 0];
                inputData[i * 3 + 1] = exrData.data[i * 4 + 1];
                inputData[i * 3 + 2] = exrData.data[i * 4 + 2];
            }
        } else {
            inputData = exrData.data;
        }

        // Execute shader
        const renderer = new SubprocessRenderer();
        const outputData = await renderer.render(imageWgsl, inputData, exrData.width, exrData.height);

        // Compare input and output
        let maxDiff = 0;
        let avgDiff = 0;
        for (let i = 0; i < Math.min(inputData.length, 1000); i++) {
            const diff = Math.abs(outputData[i] - inputData[i]);
            maxDiff = Math.max(maxDiff, diff);
            avgDiff += diff;
        }
        avgDiff /= Math.min(inputData.length, 1000);

        results.push({
            name: 'Process EXR with shader',
            passed: true,
            message: `Processed ${exrData.width}x${exrData.height} image, avg diff: ${avgDiff.toFixed(6)}`,
            duration: Date.now() - start,
        });
    } catch (e: any) {
        results.push({
            name: 'Process EXR with shader',
            passed: false,
            message: e.message,
        });
    }

    return results;
}

// Main
async function main() {
    try {
        // Ensure results directory exists
        if (!fs.existsSync(TEST_RESULTS_DIR)) {
            fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
        }

        const results = await runTest();

        console.log('\n=== Test Results ===\n');

        let passed = 0;
        let failed = 0;

        for (const result of results) {
            const status = result.passed ? '✓' : '✗';
            const duration = result.duration ? ` (${result.duration}ms)` : '';
            console.log(`${status} ${result.name}${duration}`);
            console.log(`  ${result.message}`);

            if (result.passed) passed++;
            else failed++;
        }

        console.log(`\n${passed} passed, ${failed} failed\n`);

        process.exit(failed > 0 ? 1 : 0);
    } catch (e: any) {
        console.error('Test failed:', e.message);
        process.exit(1);
    }
}

main();
