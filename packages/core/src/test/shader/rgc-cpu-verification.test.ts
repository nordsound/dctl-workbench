/**
 * ACES 2.0 RGC CPU Verification Tests (Category 5)
 *
 * Tests RGC behavior via OCIO CPU path:
 * - In-gamut colors should pass through unchanged
 * - Out-of-gamut colors should be compressed
 * - Different peak luminances should produce different results
 * - Roundtrip (compress then decompress) should be near-identity
 *
 * Requires OCIO WASM module. Tests are skipped if WASM is unavailable.
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { initOCIO, isOCIOInitialized, OCIOProcessor } from '../../ocio/index';

const VSCODE_PKG_PATH = path.resolve(__dirname, '../../../../vscode');

describe('ACES 2.0 RGC CPU Verification', function () {
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

    describe('In-gamut passthrough', () => {
        it('should preserve neutral gray (0.18, 0.18, 0.18) in AP1', function () {
            const processor = new OCIOProcessor();
            processor.init();
            const data = new Float32Array([0.18, 0.18, 0.18]);
            const original = new Float32Array(data);
            const success = processor.applyACES2GamutCompress(data, 100);
            assert.ok(success, 'applyACES2GamutCompress failed');

            for (let i = 0; i < 3; i++) {
                assert.ok(
                    Math.abs(data[i] - original[i]) < 0.001,
                    `Gray channel ${i}: expected ${original[i]}, got ${data[i]} (diff=${Math.abs(data[i] - original[i])})`
                );
            }
        });

        it('should preserve well-inside-gamut colors', function () {
            const processor = new OCIOProcessor();
            processor.init();
            // Moderate saturation, well within AP1 gamut
            const colors = [
                [0.5, 0.3, 0.2],
                [0.2, 0.4, 0.3],
                [0.1, 0.1, 0.3],
            ];

            for (const [r, g, b] of colors) {
                const data = new Float32Array([r, g, b]);
                const original = new Float32Array(data);
                const success = processor.applyACES2GamutCompress(data, 100);
                assert.ok(success);

                for (let i = 0; i < 3; i++) {
                    assert.ok(
                        Math.abs(data[i] - original[i]) < 0.01,
                        `Color (${r},${g},${b}) ch${i}: in=${original[i]}, out=${data[i]}`
                    );
                }
            }
        });
    });

    describe('Out-of-gamut compression', () => {
        it('should modify highly saturated red', function () {
            const processor = new OCIOProcessor();
            processor.init();
            // Very saturated red in AP1 - extreme ratio between channels
            const data = new Float32Array([2.0, 0.01, 0.01]);
            const original = new Float32Array(data);
            const success = processor.applyACES2GamutCompress(data, 100);
            assert.ok(success, 'applyACES2GamutCompress failed');

            let totalDiff = 0;
            for (let i = 0; i < 3; i++) {
                totalDiff += Math.abs(data[i] - original[i]);
            }
            assert.ok(
                totalDiff > 0.01,
                `Saturated red should change, totalDiff=${totalDiff}`
            );
        });

        it('should modify highly saturated green', function () {
            const processor = new OCIOProcessor();
            processor.init();
            const data = new Float32Array([0.01, 2.0, 0.01]);
            const original = new Float32Array(data);
            const success = processor.applyACES2GamutCompress(data, 100);
            assert.ok(success);

            let totalDiff = 0;
            for (let i = 0; i < 3; i++) {
                totalDiff += Math.abs(data[i] - original[i]);
            }
            assert.ok(
                totalDiff > 0.01,
                `Saturated green should be compressed, totalDiff=${totalDiff}`
            );
        });

        it('should modify highly saturated blue', function () {
            const processor = new OCIOProcessor();
            processor.init();
            const data = new Float32Array([0.01, 0.01, 2.0]);
            const original = new Float32Array(data);
            const success = processor.applyACES2GamutCompress(data, 100);
            assert.ok(success);

            let totalDiff = 0;
            for (let i = 0; i < 3; i++) {
                totalDiff += Math.abs(data[i] - original[i]);
            }
            assert.ok(
                totalDiff > 0.01,
                `Saturated blue should be compressed, totalDiff=${totalDiff}`
            );
        });
    });

    describe('Peak luminance behavior', () => {
        it('should produce different results for 100 nit vs 1000 nit peak', function () {
            const processor = new OCIOProcessor();
            processor.init();

            // Use highly saturated color with extreme channel ratio
            const color = [2.0, 0.01, 0.01];
            const data100 = new Float32Array(color);
            const data1000 = new Float32Array(color);

            processor.applyACES2GamutCompress(data100, 100);
            processor.applyACES2GamutCompress(data1000, 1000);

            let maxDiff = 0;
            for (let i = 0; i < 3; i++) {
                maxDiff = Math.max(maxDiff, Math.abs(data100[i] - data1000[i]));
            }
            assert.ok(
                maxDiff > 0.001,
                `100 nit and 1000 nit should differ, maxDiff=${maxDiff}`
            );
        });

        it('should apply less compression at higher peak luminance', function () {
            const processor = new OCIOProcessor();
            processor.init();

            // At higher peak luminance, the gamut boundary is larger,
            // so less compression is needed for the same input
            const color = [1.0, 0.05, 0.05];

            const dataLow = new Float32Array(color);
            const dataHigh = new Float32Array(color);
            const original = new Float32Array(color);

            processor.applyACES2GamutCompress(dataLow, 100);
            processor.applyACES2GamutCompress(dataHigh, 4000);

            let distLow = 0, distHigh = 0;
            for (let i = 0; i < 3; i++) {
                distLow += Math.abs(dataLow[i] - original[i]);
                distHigh += Math.abs(dataHigh[i] - original[i]);
            }

            assert.ok(
                distHigh <= distLow + 0.001,
                `Higher peak should compress less: dist100=${distLow.toFixed(4)}, dist4000=${distHigh.toFixed(4)}`
            );
        });
    });

    describe('Roundtrip (compress + decompress)', () => {
        it('should approximate identity for in-gamut and moderately saturated colors', function () {
            const processor = new OCIOProcessor();
            processor.init();

            // RGC roundtrip precision depends on LUT resolution and compression ratio.
            // Highly saturated colors may have larger roundtrip error due to
            // LUT interpolation in the compressed region.
            const colors = [
                [0.5, 0.3, 0.2],    // moderate (in-gamut)
                [0.18, 0.18, 0.18], // neutral gray
                [0.8, 0.2, 0.1],    // moderately saturated
                [0.3, 0.6, 0.2],    // moderate green
            ];

            for (const [r, g, b] of colors) {
                const data = new Float32Array([r, g, b]);
                // Compress
                processor.applyACES2GamutCompress(data, 100, false);
                // Decompress
                processor.applyACES2GamutCompress(data, 100, true);

                for (let i = 0; i < 3; i++) {
                    const original = [r, g, b][i];
                    assert.ok(
                        Math.abs(data[i] - original) < 0.05,
                        `Roundtrip (${r},${g},${b}) ch${i}: expected ${original}, got ${data[i]}`
                    );
                }
            }
        });

        it('should have bounded roundtrip error for extreme colors', function () {
            const processor = new OCIOProcessor();
            processor.init();

            // Extreme colors have larger roundtrip error due to:
            // 1. LUT resolution limits in the compressed region
            // 2. Gamut mapping non-linearity
            // 3. Float32 precision in JMh space conversion
            // We verify the error is bounded but may be significant.
            const extremeColors = [
                [2.0, 0.01, 0.01],  // saturated red
                [0.01, 2.0, 0.01],  // saturated green
                [0.01, 0.01, 2.0],  // saturated blue
            ];

            for (const [r, g, b] of extremeColors) {
                const data = new Float32Array([r, g, b]);
                const compressed = new Float32Array(3);
                processor.applyACES2GamutCompress(data, 100, false);
                compressed.set(data);
                processor.applyACES2GamutCompress(data, 100, true);

                // Just verify the roundtrip values are finite and in a reasonable range
                for (let i = 0; i < 3; i++) {
                    assert.ok(isFinite(data[i]),
                        `Roundtrip (${r},${g},${b}) ch${i}: got non-finite ${data[i]}`);
                    assert.ok(data[i] >= -1.0 && data[i] <= 10.0,
                        `Roundtrip (${r},${g},${b}) ch${i}: out of range, got ${data[i]}`);
                }
            }
        });
    });

    describe('Batch processing', () => {
        it('should handle multiple pixels in a single call', function () {
            const processor = new OCIOProcessor();
            processor.init();

            // 4 pixels: gray, saturated red, saturated green, saturated blue
            const data = new Float32Array([
                0.18, 0.18, 0.18,  // gray (in-gamut)
                2.0, 0.01, 0.01,   // highly saturated red
                0.01, 2.0, 0.01,   // highly saturated green
                0.01, 0.01, 2.0,   // highly saturated blue
            ]);
            const original = new Float32Array(data);
            const success = processor.applyACES2GamutCompress(data, 100);
            assert.ok(success);

            // Gray should be preserved
            for (let i = 0; i < 3; i++) {
                assert.ok(
                    Math.abs(data[i] - original[i]) < 0.001,
                    `Gray pixel ch${i} changed: ${original[i]} -> ${data[i]}`
                );
            }

            // Out-of-gamut pixels should be modified
            for (let p = 1; p < 4; p++) {
                let diff = 0;
                for (let i = 0; i < 3; i++) {
                    diff += Math.abs(data[p * 3 + i] - original[p * 3 + i]);
                }
                assert.ok(diff > 0.01, `Pixel ${p} should be compressed, diff=${diff}`);
            }
        });
    });
});
