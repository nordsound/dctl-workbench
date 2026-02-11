/**
 * RGC GPU Comparison Test
 *
 * Verifies that RGC (Reference Gamut Compression) actually modifies output
 * by comparing GPU-executed shader results with and without RGC enabled.
 *
 * Uses out-of-gamut AP0 colors as input — these colors are outside the AP1
 * gamut and MUST be modified by RGC. If RGC-on output equals RGC-off output,
 * the RGC pipeline is broken.
 */

import { strict as assert } from 'assert';
import { describe, it, before } from 'mocha';
import * as path from 'path';
import { existsSync } from 'fs';
import { DctlRuntime, isCompileError } from '@dctl-workbench/core';
import { SubprocessRenderer } from '../subprocess-renderer.js';
import { buildBufferComputeShader, buildBufferComputeShaderWithRgc } from '../shader-builder.js';
import { buildRgcShader } from '../rgc-shader-builder.js';

const VSCODE_PKG_PATH = path.resolve(__dirname, '../../../vscode');

// Simple gain DCTL — applies p_R * gain etc. in working color space
const GAIN_DCTL = `
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain, p_G * gain, p_B * gain);
}
`;

/**
 * Generate test image with out-of-gamut AP0 colors.
 *
 * Uses blue-green region which is known to be compressed by ACES 2.0 RGC
 * at 100 nits. Not all hue regions are compressed — the red/orange region
 * may pass through unchanged at SDR luminance levels.
 *
 * AP0 [0.15, 0.82, 1.51] maps to AP1 ≈ [-0.3, 0.8, 1.5] which is
 * strongly out of AP1 gamut in the blue-green region.
 */
function generateOutOfGamutInput(width: number, height: number): Float32Array {
    const pixels = new Float32Array(width * height * 3);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;
            // Blue-green AP0 color: maps to AP1 [-0.3, 0.8, 1.5]
            // OCIO CPU RGC confirms compression: AP1→[0.002, 0.666, 1.023]
            pixels[idx + 0] = 0.15;
            pixels[idx + 1] = 0.82;
            pixels[idx + 2] = 1.51;
        }
    }

    return pixels;
}

/**
 * Compute max absolute difference between two Float32Arrays
 */
function maxAbsDiff(a: Float32Array, b: Float32Array): number {
    let maxDiff = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    }
    return maxDiff;
}

/**
 * Compute mean absolute difference between two Float32Arrays
 */
function meanAbsDiff(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        sum += Math.abs(a[i] - b[i]);
    }
    return sum / len;
}

describe('RGC GPU Comparison', function () {
    // GPU tests need longer timeout
    this.timeout(60000);

    let runtime: DctlRuntime;
    let compileResult: any;

    before(async function () {
        // Check WASM exists
        const wasmFile = path.join(VSCODE_PKG_PATH, 'out', 'wasm', 'dctl_compiler.wasm');
        if (!existsSync(wasmFile)) {
            this.skip();
            return;
        }

        runtime = new DctlRuntime();
        await runtime.init({ wasmPath: VSCODE_PKG_PATH });

        compileResult = runtime.compile(GAIN_DCTL);
        if (isCompileError(compileResult)) {
            throw new Error(`DCTL compile failed: ${compileResult.message}`);
        }
    });

    it('should produce different output with RGC on vs off for out-of-gamut colors', async function () {
        const width = 16;
        const height = 16;
        const input = generateOutOfGamutInput(width, height);

        // 1. Build and execute WITHOUT RGC
        const shaderNoRgc = buildBufferComputeShader(compileResult, {
            width,
            height,
            paramValues: { gain: 1.0 },
            workingColorSpace: 'ACEScct',
        });

        const rendererNoRgc = new SubprocessRenderer();
        const outputNoRgc = await rendererNoRgc.render(shaderNoRgc, input, width, height);

        // 2. Build and execute WITH RGC
        const rgcResult = await buildRgcShader(runtime, VSCODE_PKG_PATH, 100);
        assert.ok(rgcResult.success, `RGC shader build failed: ${rgcResult.error}`);

        const shaderWithRgc = buildBufferComputeShaderWithRgc(compileResult, {
            width,
            height,
            paramValues: { gain: 1.0 },
            workingColorSpace: 'ACEScct',
            rgcWgslFunctions: rgcResult.wgslFunctions,
            rgcMainFunctionName: rgcResult.mainFunctionName,
            rgcTextureBindings: rgcResult.textureBindings,
        });

        const rendererWithRgc = new SubprocessRenderer();
        const outputWithRgc = await rendererWithRgc.renderWithTextures(
            shaderWithRgc, input, width, height, rgcResult.textures,
        );

        // 3. Verify both outputs are valid (not all zeros)
        const hasNonZeroNoRgc = outputNoRgc.some(v => Math.abs(v) > 0.0001);
        const hasNonZeroWithRgc = outputWithRgc.some(v => Math.abs(v) > 0.0001);
        assert.ok(hasNonZeroNoRgc, 'RGC-off output is all zeros (rendering failed)');
        assert.ok(hasNonZeroWithRgc, 'RGC-on output is all zeros (rendering failed)');

        // 4. Compare: outputs MUST differ for out-of-gamut colors
        const maxDiff = maxAbsDiff(outputNoRgc, outputWithRgc);
        const meanDiff = meanAbsDiff(outputNoRgc, outputWithRgc);

        console.log(`\n  RGC comparison (out-of-gamut AP0 input):`);
        console.log(`    No-RGC sample: R=${outputNoRgc[0].toFixed(6)}, G=${outputNoRgc[1].toFixed(6)}, B=${outputNoRgc[2].toFixed(6)}`);
        console.log(`    With-RGC sample: R=${outputWithRgc[0].toFixed(6)}, G=${outputWithRgc[1].toFixed(6)}, B=${outputWithRgc[2].toFixed(6)}`);
        console.log(`    Max diff: ${maxDiff.toFixed(6)}, Mean diff: ${meanDiff.toFixed(6)}`);

        // RGC must make a visible difference for out-of-gamut colors
        assert.ok(
            maxDiff > 0.001,
            `RGC did NOT modify out-of-gamut colors! maxDiff=${maxDiff.toFixed(6)}. ` +
            `This means RGC is not being applied in the export pipeline.`,
        );
    });

    it('should produce similar output with RGC on vs off for in-gamut colors', async function () {
        const width = 16;
        const height = 16;

        // In-gamut colors: AP0 mid-gray [0.18, 0.18, 0.18] is well within AP1
        const input = new Float32Array(width * height * 3);
        for (let i = 0; i < input.length; i += 3) {
            input[i] = 0.18;
            input[i + 1] = 0.18;
            input[i + 2] = 0.18;
        }

        // Build WITHOUT RGC
        const shaderNoRgc = buildBufferComputeShader(compileResult, {
            width,
            height,
            paramValues: { gain: 1.0 },
            workingColorSpace: 'ACEScct',
        });

        const rendererNoRgc = new SubprocessRenderer();
        const outputNoRgc = await rendererNoRgc.render(shaderNoRgc, input, width, height);

        // Build WITH RGC
        const rgcResult = await buildRgcShader(runtime, VSCODE_PKG_PATH, 100);
        assert.ok(rgcResult.success, `RGC shader build failed: ${rgcResult.error}`);

        const shaderWithRgc = buildBufferComputeShaderWithRgc(compileResult, {
            width,
            height,
            paramValues: { gain: 1.0 },
            workingColorSpace: 'ACEScct',
            rgcWgslFunctions: rgcResult.wgslFunctions,
            rgcMainFunctionName: rgcResult.mainFunctionName,
            rgcTextureBindings: rgcResult.textureBindings,
        });

        const rendererWithRgc = new SubprocessRenderer();
        const outputWithRgc = await rendererWithRgc.renderWithTextures(
            shaderWithRgc, input, width, height, rgcResult.textures,
        );

        // For in-gamut colors, RGC should NOT change values significantly
        const maxDiff = maxAbsDiff(outputNoRgc, outputWithRgc);

        console.log(`\n  RGC comparison (in-gamut AP0 mid-gray):`);
        console.log(`    No-RGC sample: R=${outputNoRgc[0].toFixed(6)}, G=${outputNoRgc[1].toFixed(6)}, B=${outputNoRgc[2].toFixed(6)}`);
        console.log(`    With-RGC sample: R=${outputWithRgc[0].toFixed(6)}, G=${outputWithRgc[1].toFixed(6)}, B=${outputWithRgc[2].toFixed(6)}`);
        console.log(`    Max diff: ${maxDiff.toFixed(6)}`);

        // In-gamut colors should pass through RGC nearly unchanged
        // Allow small tolerance for floating-point precision differences
        assert.ok(
            maxDiff < 0.01,
            `RGC modified in-gamut colors too much! maxDiff=${maxDiff.toFixed(6)}. ` +
            `Expected near-zero difference for in-gamut mid-gray.`,
        );
    });
});
