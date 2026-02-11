/**
 * EXR Export Integration Test
 *
 * Tests the complete export pipeline including:
 * 1. Both DCTL types (Direct RGB and Texture Sampling)
 * 2. RGC enabled and disabled
 * 3. Actual WebGPU rendering via SubprocessRenderer
 * 4. Image analysis to verify output is not black
 */

import * as path from 'path';
import * as fs from 'fs';
import { DctlRuntime, isCompileError } from '@dctl-workbench/core';
import { SubprocessRenderer } from '../subprocess-renderer.js';
import { buildBufferComputeShader, buildBufferComputeShaderWithRgc } from '../shader-builder.js';
import { buildRgcShader } from '../rgc-shader-builder.js';

import { getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Paths
const VSCODE_PKG_PATH = path.resolve(__dirname, '../../../vscode');
const WASM_DIR = path.join(VSCODE_PKG_PATH, 'out', 'wasm');
const TEST_RESULTS_DIR = getTestOutputDir();

// Test DCTLs - Two types
const DCTL_DIRECT_RGB = `
// Direct RGB type - uses p_R, p_G, p_B directly
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.5, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain, p_G * gain, p_B * gain);
}
`;

const DCTL_TEXTURE_SAMPLING = `
// Texture Sampling type - uses _tex2D() internally
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.5, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    return make_float3(r * gain, g * gain, b * gain);
}
`;

interface TestResult {
    name: string;
    passed: boolean;
    message: string;
    duration?: number;
    stats?: ImageStats;
}

interface ImageStats {
    min: number;
    max: number;
    mean: number;
    nonZeroPixels: number;
    totalPixels: number;
}

/**
 * Analyze image data to check if it's valid (not black)
 * @param channels Number of channels per pixel (3 for RGB, 4 for RGBA)
 */
function analyzeImage(pixels: Float32Array, width: number, height: number, channels: number = 4): ImageStats {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let nonZeroPixels = 0;
    const totalPixels = width * height;

    for (let i = 0; i < pixels.length; i += channels) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        min = Math.min(min, luminance);
        max = Math.max(max, luminance);
        sum += luminance;

        if (Math.abs(r) > 0.0001 || Math.abs(g) > 0.0001 || Math.abs(b) > 0.0001) {
            nonZeroPixels++;
        }
    }

    return {
        min,
        max,
        mean: sum / totalPixels,
        nonZeroPixels,
        totalPixels,
    };
}

/**
 * Generate a simple test image (gradient pattern) - RGB only
 * The CLI shader uses 3-channel (RGB) buffers
 */
function generateTestImage(width: number, height: number): Float32Array {
    const pixels = new Float32Array(width * height * 3);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;
            // Create a gradient pattern in AP0 linear
            // Values are in reasonable range for ACES (0-1 for SDR)
            pixels[idx + 0] = x / width * 0.8 + 0.1;      // R
            pixels[idx + 1] = y / height * 0.8 + 0.1;    // G
            pixels[idx + 2] = 0.3;                         // B
        }
    }

    return pixels;
}

async function initRuntime(): Promise<DctlRuntime> {
    const runtime = new DctlRuntime();
    await runtime.init({ wasmPath: VSCODE_PKG_PATH });
    return runtime;
}

async function runExportTest(
    runtime: DctlRuntime,
    dctlSource: string,
    dctlName: string,
    enableRgc: boolean,
    inputPixels: Float32Array,
    width: number,
    height: number
): Promise<{ success: boolean; stats?: ImageStats; error?: string; wgsl?: string }> {
    try {
        // 1. Compile DCTL
        const compileResult = runtime.compile(dctlSource);
        if (isCompileError(compileResult)) {
            return { success: false, error: `Compilation failed: ${compileResult.message}` };
        }

        // 2. Build shader
        let wgslShader: string;
        let rgcTextures: any[] = [];

        if (enableRgc) {
            // Build with RGC
            const rgcResult = await buildRgcShader(runtime, VSCODE_PKG_PATH, 100);
            if (!rgcResult.success) {
                return { success: false, error: `RGC shader build failed: ${rgcResult.error}` };
            }

            wgslShader = buildBufferComputeShaderWithRgc(compileResult, {
                width,
                height,
                paramValues: { gain: 1.5 },
                workingColorSpace: 'ACEScct',
                rgcWgslFunctions: rgcResult.wgslFunctions,
                rgcMainFunctionName: rgcResult.mainFunctionName,
                rgcTextureBindings: rgcResult.textureBindings,
            });
            rgcTextures = rgcResult.textures || [];
        } else {
            // Build without RGC
            wgslShader = buildBufferComputeShader(compileResult, {
                width,
                height,
                paramValues: { gain: 1.5 },
                workingColorSpace: 'ACEScct',
            });
        }

        // Save shader for debugging
        const debugPath = path.join(TEST_RESULTS_DIR, `test_${dctlName}_rgc_${enableRgc}.wgsl`);
        fs.writeFileSync(debugPath, wgslShader);

        // 3. Render using SubprocessRenderer
        const renderer = new SubprocessRenderer();

        let outputPixels: Float32Array;
        if (enableRgc && rgcTextures.length > 0) {
            outputPixels = await renderer.renderWithTextures(
                wgslShader,
                inputPixels,
                width,
                height,
                rgcTextures
            );
        } else {
            outputPixels = await renderer.render(wgslShader, inputPixels, width, height);
        }

        // 4. Analyze output (3 channels - RGB)
        const stats = analyzeImage(outputPixels, width, height, 3);

        // 5. Write output EXR for visual inspection
        const outputPath = path.join(TEST_RESULTS_DIR, `test_${dctlName}_rgc_${enableRgc}.exr`);
        await runtime.writeExr(outputPath, {
            width,
            height,
            channels: 3,
            data: outputPixels,
        });

        return { success: true, stats, wgsl: wgslShader };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

async function runTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    console.log('=== EXR Export Integration Test ===\n');

    // Ensure results directory exists
    if (!fs.existsSync(TEST_RESULTS_DIR)) {
        fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
    }

    // Initialize runtime
    let runtime: DctlRuntime;
    try {
        const start = Date.now();
        runtime = await initRuntime();
        results.push({
            name: 'Initialize DctlRuntime',
            passed: true,
            message: 'Runtime initialized successfully',
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

    // Generate test image
    const width = 64;
    const height = 64;
    const inputPixels = generateTestImage(width, height);
    const inputStats = analyzeImage(inputPixels, width, height, 3);
    console.log(`Input image stats: min=${inputStats.min.toFixed(4)}, max=${inputStats.max.toFixed(4)}, mean=${inputStats.mean.toFixed(4)}`);

    // Test configurations
    const testConfigs = [
        { dctl: DCTL_DIRECT_RGB, name: 'direct_rgb', rgc: false },
        { dctl: DCTL_DIRECT_RGB, name: 'direct_rgb', rgc: true },
        { dctl: DCTL_TEXTURE_SAMPLING, name: 'texture_sampling', rgc: false },
        { dctl: DCTL_TEXTURE_SAMPLING, name: 'texture_sampling', rgc: true },
    ];

    for (const config of testConfigs) {
        const testName = `Export ${config.name} (RGC=${config.rgc})`;
        console.log(`\nRunning: ${testName}`);

        const start = Date.now();
        const result = await runExportTest(
            runtime,
            config.dctl,
            config.name,
            config.rgc,
            inputPixels,
            width,
            height
        );

        if (result.success && result.stats) {
            const stats = result.stats;
            const isBlack = stats.nonZeroPixels === 0 || stats.max < 0.001;

            if (isBlack) {
                results.push({
                    name: testName,
                    passed: false,
                    message: `Output is BLACK! nonZero=${stats.nonZeroPixels}/${stats.totalPixels}, max=${stats.max.toFixed(6)}`,
                    duration: Date.now() - start,
                    stats,
                });
            } else {
                results.push({
                    name: testName,
                    passed: true,
                    message: `OK: nonZero=${stats.nonZeroPixels}/${stats.totalPixels}, range=[${stats.min.toFixed(4)}, ${stats.max.toFixed(4)}], mean=${stats.mean.toFixed(4)}`,
                    duration: Date.now() - start,
                    stats,
                });
            }

            // Additional check: output should be brighter than input (gain=1.5)
            if (stats.mean < inputStats.mean * 1.3) {
                console.log(`  WARNING: Output mean (${stats.mean.toFixed(4)}) is not significantly brighter than input (${inputStats.mean.toFixed(4)})`);
            }
        } else {
            results.push({
                name: testName,
                passed: false,
                message: result.error || 'Unknown error',
                duration: Date.now() - start,
            });
        }
    }

    return results;
}

async function main() {
    try {
        const results = await runTests();

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

        if (failed > 0) {
            console.log('=== EXPORT TEST FAILED ===');
            console.log('Check the generated WGSL files and EXR outputs in:');
            console.log(TEST_RESULTS_DIR);
        } else {
            console.log('=== ALL EXPORT TESTS PASSED ===');
            console.log('All DCTL types and RGC configurations work correctly.');
        }

        process.exit(failed > 0 ? 1 : 0);
    } catch (e: any) {
        console.error('Test failed:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
}

main();
