/**
 * ACES 2.0 RGC Shader Builder Tests
 *
 * Verifies that extractRgcGlslFunction returns valid texture data
 * and correct GLSL for gamut compression.
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { extractRgcGlslFunction } from '../../shader/aces-rgc-shader-builder';
import { initOCIO, isOCIOInitialized } from '../../ocio/index';

const VSCODE_PKG_PATH = path.resolve(__dirname, '../../../../vscode');

describe('extractRgcGlslFunction', function () {
    this.timeout(30000);

    before(async function () {
        const wasmFile = path.join(VSCODE_PKG_PATH, 'out', 'wasm', 'dctl_compiler.wasm');
        if (!fs.existsSync(wasmFile)) {
            this.skip();
            return;
        }

        if (!isOCIOInitialized()) {
            await initOCIO(VSCODE_PKG_PATH);
        }
    });

    it('should return valid non-zero texture data', function () {
        const result = extractRgcGlslFunction(100);
        assert.ok(result, 'extractRgcGlslFunction returned null');
        assert.ok(result.textures.length >= 2, `Expected at least 2 textures, got ${result.textures.length}`);

        for (const tex of result.textures) {
            const data = new Float32Array(tex.data);
            // channel: 0 = TEXTURE_RED_CHANNEL (1 component), 1 = TEXTURE_RGB_CHANNEL (3 components)
            const channels = tex.channel === 0 ? 1 : 3;
            const expectedSize = tex.width * tex.height * channels;

            assert.equal(data.length, expectedSize,
                `Texture ${tex.samplerName}: data size ${data.length} != expected ${expectedSize}`);

            let nonZero = 0;
            for (let i = 0; i < data.length; i++) {
                if (Math.abs(data[i]) > 1e-10) nonZero++;
            }

            assert.ok(nonZero > data.length * 0.9,
                `Texture ${tex.samplerName}: only ${nonZero}/${data.length} non-zero ` +
                `(${(100 * nonZero / data.length).toFixed(1)}%)`);
        }
    });

    it('should return valid GLSL with OCIODisplay function', function () {
        const result = extractRgcGlslFunction(100);
        assert.ok(result, 'extractRgcGlslFunction returned null');
        assert.ok(result.glsl.length > 0, 'GLSL text is empty');
        assert.ok(result.glsl.includes('OCIODisplay'), 'GLSL does not contain OCIODisplay function');
    });

    it('should produce different textures for different peak luminances', function () {
        const result100 = extractRgcGlslFunction(100);
        const result1000 = extractRgcGlslFunction(1000);
        assert.ok(result100 && result1000, 'extractRgcGlslFunction returned null');

        const data100 = new Float32Array(result100.textures[0].data);
        const data1000 = new Float32Array(result1000.textures[0].data);

        let maxDiff = 0;
        for (let i = 0; i < Math.min(data100.length, data1000.length); i++) {
            maxDiff = Math.max(maxDiff, Math.abs(data100[i] - data1000[i]));
        }

        assert.ok(maxDiff > 0.01,
            `100 nit and 1000 nit textures should differ, maxDiff=${maxDiff.toFixed(6)}`);
    });
});
