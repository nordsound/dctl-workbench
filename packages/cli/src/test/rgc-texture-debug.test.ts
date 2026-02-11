/**
 * RGC Texture and CPU Verification Tests
 *
 * Verifies RGC (Reference Gamut Compression) data pipeline:
 * 1. OCIO extraction produces valid texture data (CPU check)
 * 2. OCIO CPU RGC ground truth confirms expected behavior
 */

import { strict as assert } from 'assert';
import { describe, it, before } from 'mocha';
import * as path from 'path';
import * as fs from 'fs';
import { DctlRuntime, OCIOProcessor, initOCIO, isOCIOInitialized } from '@dctl-workbench/core';
import { buildRgcShader } from '../rgc-shader-builder.js';

const VSCODE_PKG_PATH = path.resolve(__dirname, '../../../vscode');

describe('RGC Texture Verification', function () {
    this.timeout(60000);

    let rgcResult: any;

    before(async function () {
        const wasmFile = path.join(VSCODE_PKG_PATH, 'out', 'wasm', 'dctl_compiler.wasm');
        if (!fs.existsSync(wasmFile)) {
            this.skip();
            return;
        }

        const runtime = new DctlRuntime();
        await runtime.init({ wasmPath: VSCODE_PKG_PATH });
        rgcResult = await buildRgcShader(runtime, VSCODE_PKG_PATH, 100);
        assert.ok(rgcResult.success, `RGC shader build failed: ${rgcResult.error}`);
    });

    it('should have valid texture data from OCIO extraction', function () {
        assert.ok(rgcResult.textures.length >= 2, `Expected at least 2 textures, got ${rgcResult.textures.length}`);

        for (const tex of rgcResult.textures) {
            const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
            const expectedSize = tex.width * tex.height * tex.channels;

            // Verify data size matches expected
            assert.equal(data.length, expectedSize, `Data size mismatch for ${tex.name}`);

            // Count non-zero elements
            let nonZero = 0;
            for (let i = 0; i < data.length; i++) {
                if (Math.abs(data[i]) > 1e-10) nonZero++;
            }

            // Texture data should be mostly non-zero
            assert.ok(nonZero > data.length * 0.9,
                `Texture ${tex.name}: only ${nonZero}/${data.length} non-zero (${(100 * nonZero / data.length).toFixed(1)}%)`);
        }
    });

    it('should compress blue-green AP1 colors via OCIO CPU RGC', async function () {
        if (!isOCIOInitialized()) {
            await initOCIO(VSCODE_PKG_PATH);
        }

        const processor = new OCIOProcessor();
        assert.ok(processor.init(), 'OCIO init failed');
        assert.ok(processor.setupACES2GamutCompress(100, false), 'RGC setup failed');

        // Blue-green AP1 [-0.3, 0.8, 1.5] is out of AP1 gamut and gets compressed
        const data = new Float32Array([-0.3, 0.8, 1.5]);
        assert.ok(processor.applyRGB(data), 'CPU RGC apply failed');

        const maxDiff = Math.max(
            Math.abs(data[0] - (-0.3)),
            Math.abs(data[1] - 0.8),
            Math.abs(data[2] - 1.5)
        );

        assert.ok(maxDiff > 0.1,
            `OCIO CPU RGC did not compress blue-green AP1: maxDiff=${maxDiff.toFixed(6)}`);
    });

    it('should preserve in-gamut mid-gray via OCIO CPU RGC', async function () {
        if (!isOCIOInitialized()) {
            await initOCIO(VSCODE_PKG_PATH);
        }

        const processor = new OCIOProcessor();
        assert.ok(processor.init(), 'OCIO init failed');
        assert.ok(processor.setupACES2GamutCompress(100, false), 'RGC setup failed');

        const data = new Float32Array([0.18, 0.18, 0.18]);
        assert.ok(processor.applyRGB(data), 'CPU RGC apply failed');

        const maxDiff = Math.max(
            Math.abs(data[0] - 0.18),
            Math.abs(data[1] - 0.18),
            Math.abs(data[2] - 0.18)
        );

        assert.ok(maxDiff < 0.001,
            `OCIO CPU RGC modified mid-gray too much: maxDiff=${maxDiff.toFixed(6)}`);
    });
});
