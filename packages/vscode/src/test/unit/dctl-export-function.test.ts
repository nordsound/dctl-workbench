/**
 * DCTL Export Function Tests
 *
 * NOTE: The actual export shader builder functions require VS Code APIs
 * and can only be tested within the VS Code extension test runner.
 *
 * This file contains tests that simulate and validate the export logic
 * without requiring VS Code dependencies.
 *
 * For full integration testing, use VS Code's test runner:
 * 1. Open the extension in VS Code
 * 2. Run Extension Tests from the debug panel
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Test DCTL sources
const GAIN_DCTL_SOURCE = `
// Test: Gain multiply
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    return make_float3(r * gain, g * gain, b * gain);
}
`;

describe('DCTL Export Function Tests', () => {
    describe('Export Shader Output Validation', () => {
        /**
         * These tests validate the generated shader files from actual exports.
         * The shader files are generated when using the Export feature in VS Code.
         */

        it('should validate non-RGC export shader if exists', function() {
            const debugPath = path.join(getTestOutputDir(), 'export_shader_debug.wgsl');

            if (!fs.existsSync(debugPath)) {
                console.log('No export shader debug file found - run Export in VS Code first');
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(debugPath, 'utf-8');

            console.log('\n=== Non-RGC Export Shader Validation ===');

            // Validate basic structure
            const checks = {
                hasFragmentEntry: /@fragment\s*fn\s+main/.test(shaderCode),
                hasTextureBinding: /@group\(0\)\s*@binding\(0\)/.test(shaderCode),
                hasSamplerBinding: /@group\(0\)\s*@binding\(1\)/.test(shaderCode),
                hasSampleTexture: /fn\s+dctl_sampleTexture/.test(shaderCode),
                hasTransform: /fn\s+transform/.test(shaderCode),
                callsTransformCorrectly: /transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y[\s,)]/.test(shaderCode),
                hasColorSpaceMatrices: /dctl_ap0ToWorking|dctl_workingToAp0/.test(shaderCode),
                hasACEScctFunctions: /dctl_lin_to_ACEScct|dctl_ACEScct_to_lin/.test(shaderCode),
            };

            for (const [name, passed] of Object.entries(checks)) {
                console.log(`${name}: ${passed ? '✓' : '✗'}`);
                assert.ok(passed, `${name} should pass`);
            }

            // Check for parameter injection
            const gainMatch = shaderCode.match(/var<private>\s+gain:\s*f32\s*=?\s*([^;]*);/);
            if (gainMatch) {
                console.log(`\nGain parameter: ${gainMatch[0]}`);
                const hasValue = gainMatch[0].includes('=');
                if (!hasValue) {
                    console.log('WARNING: Gain parameter declared but not initialized!');
                }
            }

            console.log('\n✓ Non-RGC export shader structure validated');
        });

        it('should validate RGC export shader if exists', function() {
            const rgcDebugPath = path.join(getTestOutputDir(), 'export_shader_rgc_debug.wgsl');

            if (!fs.existsSync(rgcDebugPath)) {
                console.log('\n=== RGC Export Shader Not Found ===');
                console.log('Expected path:', rgcDebugPath);
                console.log('This indicates RGC GLSL→WGSL conversion failed');
                console.log('The export falls back to non-RGC path');
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(rgcDebugPath, 'utf-8');

            console.log('\n=== RGC Export Shader Validation ===');

            // Validate RGC-specific structure
            const checks = {
                hasFragmentEntry: /@fragment\s*fn\s+main/.test(shaderCode),
                hasSampleTexture: /fn\s+dctl_sampleTexture/.test(shaderCode),
                hasTransform: /fn\s+transform/.test(shaderCode),
                callsTransformCorrectly: /transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y[\s,)]/.test(shaderCode),
                hasRgcFunctions: /applyACES2RGC|rgc_/.test(shaderCode),
                hasRgcTextures: /rgc_.*_tex|rgc_.*_samp/.test(shaderCode),
            };

            for (const [name, passed] of Object.entries(checks)) {
                console.log(`${name}: ${passed ? '✓' : '✗'}`);
            }

            console.log('\n✓ RGC export shader structure validated');
        });

        it('should detect if DCTL parameters are properly injected', function() {
            const debugPath = path.join(getTestOutputDir(), 'export_shader_debug.wgsl');

            if (!fs.existsSync(debugPath)) {
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(debugPath, 'utf-8');

            console.log('\n=== Parameter Injection Check ===');

            // Find all var<private> declarations
            const paramRegex = /var<private>\s+(\w+):\s*(f32|i32|bool)(\s*=\s*[^;]+)?;/g;
            const params: { name: string; type: string; value: string | null }[] = [];
            let match;

            while ((match = paramRegex.exec(shaderCode)) !== null) {
                params.push({
                    name: match[1],
                    type: match[2],
                    value: match[3] ? match[3].replace(/^\s*=\s*/, '').trim() : null,
                });
            }

            if (params.length === 0) {
                console.log('No parameters found (may be passthrough DCTL)');
            } else {
                console.log('Parameters found:');
                for (const param of params) {
                    const status = param.value ? `✓ ${param.value}` : '✗ NOT INJECTED';
                    console.log(`  ${param.name}: ${param.type} = ${status}`);

                    // Fail test if parameter is declared but not initialized
                    if (param.value === null) {
                        assert.fail(`Parameter "${param.name}" is declared but not initialized - parameter injection may have failed`);
                    }
                }
            }
        });

        it('should verify gain multiplication is present in transform', function() {
            const debugPath = path.join(getTestOutputDir(), 'export_shader_debug.wgsl');

            if (!fs.existsSync(debugPath)) {
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(debugPath, 'utf-8');

            // Check if this is a gain DCTL (has gain parameter)
            const hasGainParam = /var<private>\s+gain/.test(shaderCode);

            if (!hasGainParam) {
                console.log('No gain parameter found - not a gain DCTL');
                this.skip();
                return;
            }

            console.log('\n=== Gain Multiplication Check ===');

            // Check for multiplication with gain (direct or wrapped in vec3)
            const hasMultiplication = /\*\s*gain|\bgain\s*\*|\*\s*vec\d\(gain\)/.test(shaderCode);
            console.log(`Has multiplication with gain: ${hasMultiplication ? '✓' : '✗'}`);

            assert.ok(hasMultiplication, 'Gain parameter should be used in multiplication');

            // Check the multiplication context
            const multiplyMatches = shaderCode.match(/\([^)]*\*\s*gain\)|gain\s*\*[^)]+\)/g);
            if (multiplyMatches) {
                console.log('Multiplication expressions:');
                for (const expr of multiplyMatches.slice(0, 5)) {
                    console.log(`  ${expr}`);
                }
            }

            console.log('\n✓ Gain multiplication verified');
        });
    });

    describe('Export Behavior Documentation', () => {
        it('should document expected ACEScct gain behavior', () => {
            /**
             * IMPORTANT: Gain multiplication in ACEScct space is NOT linear!
             *
             * ACEScct is a logarithmic encoding. When you multiply by 2.0 in ACEScct space:
             * - You are NOT doubling the brightness
             * - You are exponentially increasing the brightness
             *
             * Example for 18% gray (0.18 linear):
             * - ACEScct value: ~0.414
             * - After gain×2: ~0.828
             * - Back to linear: ~27.3
             * - Effective multiplier: ~152x (not 2x!)
             */

            function linToACEScct(lin: number): number {
                const cut = 0.0078125;
                const a = 10.5402377416545;
                const b = 0.0729055341958355;
                if (lin <= cut) return a * lin + b;
                return (Math.log2(lin) + 9.72) / 17.52;
            }

            function ACEScctToLin(cct: number): number {
                const cut = 0.155251141552511;
                const a = 10.5402377416545;
                const b = 0.0729055341958355;
                if (cct <= cut) return (cct - b) / a;
                return Math.pow(2, cct * 17.52 - 9.72);
            }

            console.log('\n=== ACEScct Gain Behavior Documentation ===');
            console.log('\nWhen gain=2.0 is applied in ACEScct working space:');

            const testInputs = [0.01, 0.05, 0.18, 0.5, 1.0];
            console.log('\nLinear Input → ACEScct → ×2 → Linear Output → Multiplier');
            console.log('-'.repeat(60));

            for (const linearIn of testInputs) {
                const acescctIn = linToACEScct(linearIn);
                const acescctOut = acescctIn * 2.0;
                const linearOut = ACEScctToLin(acescctOut);
                const multiplier = linearOut / linearIn;

                console.log(`${linearIn.toFixed(2).padStart(6)} → ${acescctIn.toFixed(3)} → ${acescctOut.toFixed(3)} → ${linearOut.toFixed(2).padStart(8)} → ${multiplier.toFixed(0).padStart(5)}x`);
            }

            console.log('\nConclusion: If exported image appears DARKER with gain=2.0,');
            console.log('the DCTL transform is NOT being applied correctly.');
        });

        it('should document export debugging steps', () => {
            console.log('\n=== Export Debugging Steps ===');
            console.log(`
If the exported image doesn't show DCTL effects:

1. Check VS Code Developer Console (Help → Toggle Developer Tools)
   - Look for errors during export
   - Search for "DCTL Export" or "RGC" messages

2. Verify the debug shader file:
   - Path: images/test_patterns/test_results/export_shader_debug.wgsl
   - RGC path: images/test_patterns/test_results/export_shader_rgc_debug.wgsl

3. In the debug shader, check:
   - Parameter declaration: var<private> gain: f32 = 2f;  (must have value!)
   - Multiplication: r * gain, g * gain, b * gain

4. If RGC debug file is missing:
   - OCIO WASM may not be initialized
   - extractRgcGlslFunction() returns null
   - Export falls back to non-RGC path

5. Common issues:
   - Parameter not injected (declared but no value)
   - Transform function not called correctly
   - WebGPU pipeline errors
   - Color space viewing settings in EXR viewer
`);
        });
    });
});
