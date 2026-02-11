/**
 * Banding Investigation Test
 *
 * Test cases to investigate why green/cyan bands show banding artifacts
 * after DCTL export with gain = 1.05
 */

import * as assert from 'assert';
import {
    linToACEScct,
    ACEScctToLin,
    ap0ToAp1,
    ap1ToAp0,
    AP0_TO_AP1_MATRIX,
    AP1_TO_AP0_MATRIX,
} from '../../color-space/index.js';

describe('Banding Investigation', () => {
    // ACEScct constants
    const A = 10.5402377416545;
    const B = 0.0729055341958355;
    const CUT_LIN = 0.0078125;
    const CUT_CCT = 0.155251141552511;

    describe('ACEScct Round-trip with Negative Values', () => {
        it('should have minimal error for positive values in log region', () => {
            const testValues = [0.01, 0.1, 0.18, 0.5, 1.0, 2.0];

            for (const original of testValues) {
                const encoded = linToACEScct(original);
                const decoded = ACEScctToLin(encoded);
                const error = Math.abs(decoded - original);
                const relativeError = error / original;

                console.log(`  Lin ${original.toFixed(4)} -> CCT ${encoded.toFixed(6)} -> Lin ${decoded.toFixed(6)}, error: ${error.toExponential(2)}, rel: ${(relativeError * 100).toFixed(6)}%`);

                assert.ok(relativeError < 1e-6, `Relative error ${relativeError} too large for value ${original}`);
            }
        });

        it('should handle values in linear segment (x <= 0.0078125)', () => {
            const testValues = [0.001, 0.005, 0.0078125];

            console.log('\n  Linear segment (x <= 0.0078125):');
            for (const original of testValues) {
                const encoded = linToACEScct(original);
                const decoded = ACEScctToLin(encoded);
                const error = Math.abs(decoded - original);

                console.log(`  Lin ${original.toFixed(6)} -> CCT ${encoded.toFixed(6)} -> Lin ${decoded.toFixed(6)}, error: ${error.toExponential(2)}`);

                assert.ok(error < 1e-10, `Error ${error} too large for linear segment value ${original}`);
            }
        });

        it('should handle NEGATIVE values (critical for green/cyan)', () => {
            // These negative values occur after AP0->AP1 conversion for green/cyan
            const testValues = [-0.001, -0.01, -0.1, -0.237, -0.451];

            console.log('\n  Negative values (green/cyan R channel after AP0->AP1):');
            for (const original of testValues) {
                const encoded = linToACEScct(original);
                const decoded = ACEScctToLin(encoded);
                const error = Math.abs(decoded - original);

                console.log(`  Lin ${original.toFixed(4)} -> CCT ${encoded.toFixed(6)} -> Lin ${decoded.toFixed(6)}, error: ${error.toExponential(2)}`);

                // Check if round-trip is accurate
                assert.ok(error < 1e-10, `Error ${error} too large for negative value ${original}`);
            }
        });

        it('should show gain multiplication effect on negative ACEScct values', () => {
            const gain = 1.05;
            const testValues = [-0.237, -0.451]; // Green and Cyan R channel after AP0->AP1

            console.log(`\n  Gain ${gain} effect on negative values:`);
            for (const linOriginal of testValues) {
                const cctOriginal = linToACEScct(linOriginal);
                const cctWithGain = cctOriginal * gain;
                const linResult = ACEScctToLin(cctWithGain);
                const expectedLinResult = linOriginal * gain; // What we expect

                // But wait - gain in ACEScct space is NOT linear multiplication!
                // ACEScct(x * gain) != ACEScct(x) * gain
                // Let's calculate what the correct result should be
                const correctLinResult = linOriginal * gain;
                const correctCct = linToACEScct(correctLinResult);

                console.log(`  Lin ${linOriginal.toFixed(4)}:`);
                console.log(`    CCT original: ${cctOriginal.toFixed(6)}`);
                console.log(`    CCT * gain:   ${cctWithGain.toFixed(6)}`);
                console.log(`    Decoded:      ${linResult.toFixed(6)}`);
                console.log(`    Expected:     ${expectedLinResult.toFixed(6)} (if gain was in linear)`);
                console.log(`    Correct CCT:  ${correctCct.toFixed(6)} (ACEScct of lin*gain)`);

                // The key insight: multiplying in CCT space is WRONG for linear operations!
            }
        });
    });

    describe('AP0 <-> AP1 Matrix Round-trip', () => {
        it('should have minimal error for primary colors', () => {
            const colors = [
                { name: 'Red', ap0: [1, 0, 0] },
                { name: 'Green', ap0: [0, 1, 0] },
                { name: 'Blue', ap0: [0, 0, 1] },
                { name: 'Cyan', ap0: [0, 1, 1] },
                { name: 'Magenta', ap0: [1, 0, 1] },
                { name: 'Yellow', ap0: [1, 1, 0] },
                { name: 'White', ap0: [1, 1, 1] },
            ];

            console.log('\n  AP0 -> AP1 -> AP0 round-trip:');
            for (const color of colors) {
                const [r, g, b] = color.ap0;
                const ap1 = ap0ToAp1(r, g, b);
                const ap0Back = ap1ToAp0(ap1[0], ap1[1], ap1[2]);

                const errorR = Math.abs(ap0Back[0] - r);
                const errorG = Math.abs(ap0Back[1] - g);
                const errorB = Math.abs(ap0Back[2] - b);
                const maxError = Math.max(errorR, errorG, errorB);

                console.log(`  ${color.name.padEnd(8)}: AP1=[${ap1.map(v => v.toFixed(4)).join(', ')}], back=[${ap0Back.map(v => v.toFixed(4)).join(', ')}], maxErr=${maxError.toExponential(2)}`);

                assert.ok(maxError < 1e-6, `Round-trip error too large for ${color.name}`);
            }
        });

        it('should show which colors produce negative AP1 values', () => {
            const colors = [
                { name: 'Red', ap0: [1, 0, 0] },
                { name: 'Green', ap0: [0, 1, 0] },
                { name: 'Blue', ap0: [0, 0, 1] },
                { name: 'Cyan', ap0: [0, 1, 1] },
                { name: 'Magenta', ap0: [1, 0, 1] },
                { name: 'Yellow', ap0: [1, 1, 0] },
            ];

            console.log('\n  Colors with negative AP1 values:');
            for (const color of colors) {
                const [r, g, b] = color.ap0;
                const ap1 = ap0ToAp1(r, g, b);
                const hasNegative = ap1.some(v => v < 0);
                const negativeChannels = [];
                if (ap1[0] < 0) negativeChannels.push(`R=${ap1[0].toFixed(4)}`);
                if (ap1[1] < 0) negativeChannels.push(`G=${ap1[1].toFixed(4)}`);
                if (ap1[2] < 0) negativeChannels.push(`B=${ap1[2].toFixed(4)}`);

                if (hasNegative) {
                    console.log(`  ${color.name.padEnd(8)}: NEGATIVE - ${negativeChannels.join(', ')}`);
                } else {
                    console.log(`  ${color.name.padEnd(8)}: all positive`);
                }
            }
        });
    });

    describe('Full Pipeline Simulation: Gain in ACEScct vs Linear', () => {
        const gain = 1.05;

        function simulatePipelineACEScct(ap0: [number, number, number]): [number, number, number] {
            // AP0 -> AP1
            const ap1 = ap0ToAp1(ap0[0], ap0[1], ap0[2]);

            // AP1 -> ACEScct
            const cct: [number, number, number] = [
                linToACEScct(ap1[0]),
                linToACEScct(ap1[1]),
                linToACEScct(ap1[2]),
            ];

            // Apply gain in ACEScct space (THIS IS WHAT DCTL DOES)
            const cctWithGain: [number, number, number] = [
                cct[0] * gain,
                cct[1] * gain,
                cct[2] * gain,
            ];

            // ACEScct -> AP1
            const ap1Result: [number, number, number] = [
                ACEScctToLin(cctWithGain[0]),
                ACEScctToLin(cctWithGain[1]),
                ACEScctToLin(cctWithGain[2]),
            ];

            // AP1 -> AP0
            return ap1ToAp0(ap1Result[0], ap1Result[1], ap1Result[2]);
        }

        function simulatePipelineLinear(ap0: [number, number, number]): [number, number, number] {
            // AP0 -> AP1
            const ap1 = ap0ToAp1(ap0[0], ap0[1], ap0[2]);

            // Apply gain in LINEAR space (correct approach)
            const ap1WithGain: [number, number, number] = [
                ap1[0] * gain,
                ap1[1] * gain,
                ap1[2] * gain,
            ];

            // AP1 -> AP0
            return ap1ToAp0(ap1WithGain[0], ap1WithGain[1], ap1WithGain[2]);
        }

        it('should compare ACEScct vs Linear pipeline for all primary colors', () => {
            const colors = [
                { name: 'Red', ap0: [1, 0, 0] as [number, number, number] },
                { name: 'Green', ap0: [0, 1, 0] as [number, number, number] },
                { name: 'Blue', ap0: [0, 0, 1] as [number, number, number] },
                { name: 'Cyan', ap0: [0, 1, 1] as [number, number, number] },
                { name: 'Magenta', ap0: [1, 0, 1] as [number, number, number] },
                { name: 'Yellow', ap0: [1, 1, 0] as [number, number, number] },
                { name: 'Gray 18%', ap0: [0.18, 0.18, 0.18] as [number, number, number] },
            ];

            console.log(`\n  Pipeline comparison (gain=${gain}):`);
            console.log('  Color     | ACEScct Pipeline          | Linear Pipeline           | Diff');
            console.log('  ----------|---------------------------|---------------------------|------');

            for (const color of colors) {
                const resultACEScct = simulatePipelineACEScct(color.ap0);
                const resultLinear = simulatePipelineLinear(color.ap0);

                const diffR = Math.abs(resultACEScct[0] - resultLinear[0]);
                const diffG = Math.abs(resultACEScct[1] - resultLinear[1]);
                const diffB = Math.abs(resultACEScct[2] - resultLinear[2]);
                const maxDiff = Math.max(diffR, diffG, diffB);

                console.log(`  ${color.name.padEnd(9)} | [${resultACEScct.map(v => v.toFixed(4)).join(', ')}] | [${resultLinear.map(v => v.toFixed(4)).join(', ')}] | ${maxDiff.toFixed(6)}`);
            }
        });

        it('should show error amplification for green/cyan (critical test)', () => {
            // Test various green intensities
            const greenIntensities = [0.1, 0.2, 0.5, 0.8, 1.0];

            console.log('\n  Green intensity sweep (gain=1.05):');
            console.log('  Intensity | Expected    | ACEScct     | Linear      | ACEScct Err | Linear Err');
            console.log('  ----------|-------------|-------------|-------------|-------------|------------');

            for (const intensity of greenIntensities) {
                const ap0: [number, number, number] = [0, intensity, 0];
                const expected: [number, number, number] = [0, intensity * gain, 0];

                const resultACEScct = simulatePipelineACEScct(ap0);
                const resultLinear = simulatePipelineLinear(ap0);

                // Compare G channel (the main component)
                const errorACEScct = Math.abs(resultACEScct[1] - expected[1]);
                const errorLinear = Math.abs(resultLinear[1] - expected[1]);

                console.log(`  ${intensity.toFixed(2).padStart(9)} | ${expected[1].toFixed(4).padStart(11)} | ${resultACEScct[1].toFixed(4).padStart(11)} | ${resultLinear[1].toFixed(4).padStart(11)} | ${errorACEScct.toFixed(6).padStart(11)} | ${errorLinear.toFixed(6).padStart(10)}`);
            }
        });

        it('should detect quantization sensitivity in ACEScct linear segment', () => {
            // Test small variations around a green value
            const baseGreen = 0.5;
            const variations = [-0.001, -0.0001, 0, 0.0001, 0.001];

            console.log('\n  Quantization sensitivity test (base green=0.5):');
            console.log('  Variation | Input G   | ACEScct G | Delta ACEScct');
            console.log('  ----------|-----------|-----------|---------------');

            const baseCct = linToACEScct(baseGreen);

            for (const v of variations) {
                const inputG = baseGreen + v;
                const cctG = linToACEScct(inputG);
                const deltaCct = cctG - baseCct;

                console.log(`  ${v.toFixed(4).padStart(9)} | ${inputG.toFixed(6).padStart(9)} | ${cctG.toFixed(6).padStart(9)} | ${deltaCct.toFixed(8).padStart(13)}`);
            }

            // Now test for negative values (the problematic case)
            console.log('\n  Quantization sensitivity for NEGATIVE values (simulating green R channel):');
            const baseNegative = -0.237; // Green's R channel after AP0->AP1

            console.log('  Variation | Input R   | ACEScct R | Delta ACEScct | Amplification');
            console.log('  ----------|-----------|-----------|---------------|---------------');

            const baseNegCct = linToACEScct(baseNegative);

            for (const v of variations) {
                const inputR = baseNegative + v;
                const cctR = linToACEScct(inputR);
                const deltaCct = cctR - baseNegCct;
                const amplification = v !== 0 ? Math.abs(deltaCct / v) : 0;

                console.log(`  ${v.toFixed(4).padStart(9)} | ${inputR.toFixed(6).padStart(9)} | ${cctR.toFixed(6).padStart(9)} | ${deltaCct.toFixed(8).padStart(13)} | ${amplification.toFixed(2).padStart(13)}x`);
            }
        });
    });

    describe('Root Cause Analysis: Gain operation in wrong color space', () => {
        it('should demonstrate that gain in ACEScct is NOT equivalent to gain in linear', () => {
            const testValue = 0.5; // Mid-gray
            const gain = 1.05;

            // Method 1: Apply gain in linear, then encode
            const linearResult = testValue * gain;
            const method1Cct = linToACEScct(linearResult);

            // Method 2: Encode, apply gain in CCT, decode (WHAT DCTL DOES)
            const cctValue = linToACEScct(testValue);
            const cctWithGain = cctValue * gain;
            const method2Linear = ACEScctToLin(cctWithGain);

            console.log('\n  Gain operation comparison (value=0.5, gain=1.05):');
            console.log(`  Method 1 (Linear gain): ${testValue} * ${gain} = ${linearResult}`);
            console.log(`  Method 2 (CCT gain):    CCT(${testValue})=${cctValue.toFixed(6)} * ${gain} = ${cctWithGain.toFixed(6)} -> Lin=${method2Linear.toFixed(6)}`);
            console.log(`  Difference: ${Math.abs(linearResult - method2Linear).toExponential(4)}`);

            // This shows that the two methods give DIFFERENT results
            // For a simple gain operation, the DCTL should work in LINEAR space, not log space
        });

        it('should show the mathematical relationship', () => {
            // ACEScct(x) = (log2(x) + 9.72) / 17.52 for x > 0.0078125
            // ACEScct(x) * gain != ACEScct(x * gain)
            //
            // Because: log2(x * gain) = log2(x) + log2(gain)
            // So: ACEScct(x * gain) = (log2(x) + log2(gain) + 9.72) / 17.52
            //                       = ACEScct(x) + log2(gain) / 17.52
            //
            // But: ACEScct(x) * gain is a different operation entirely

            const x = 0.5;
            const gain = 1.05;

            const correctCct = linToACEScct(x * gain);
            const incorrectCct = linToACEScct(x) * gain;
            const expectedCorrection = Math.log2(gain) / 17.52;

            console.log('\n  Mathematical analysis:');
            console.log(`  For x=${x}, gain=${gain}:`);
            console.log(`  Correct:   ACEScct(x*gain) = ${correctCct.toFixed(6)}`);
            console.log(`  Incorrect: ACEScct(x)*gain = ${incorrectCct.toFixed(6)}`);
            console.log(`  The correct operation should ADD log2(gain)/17.52 = ${expectedCorrection.toFixed(6)}`);
            console.log(`  Instead of MULTIPLY by gain`);

            // For negative values in linear segment, the formula is different:
            // ACEScct(x) = A * x + B
            // ACEScct(x * gain) = A * x * gain + B
            // ACEScct(x) * gain = (A * x + B) * gain = A * x * gain + B * gain
            // The difference is B * (gain - 1)

            const negX = -0.237;
            const negCorrectCct = linToACEScct(negX * gain);
            const negIncorrectCct = linToACEScct(negX) * gain;
            const negExpectedDiff = B * (gain - 1);

            console.log(`\n  For negative x=${negX}, gain=${gain}:`);
            console.log(`  Correct:   ACEScct(x*gain) = ${negCorrectCct.toFixed(6)}`);
            console.log(`  Incorrect: ACEScct(x)*gain = ${negIncorrectCct.toFixed(6)}`);
            console.log(`  Expected diff (B*(gain-1)): ${negExpectedDiff.toFixed(6)}`);
            console.log(`  Actual diff: ${(negIncorrectCct - negCorrectCct).toFixed(6)}`);
        });
    });
});
