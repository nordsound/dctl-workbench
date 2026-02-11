/**
 * RGC Export Path Tests
 *
 * Tests to verify ACES 2.0 Reference Gamut Compression works correctly
 * during export. These tests validate the intermediate outputs at each
 * stage of the RGC export pipeline.
 *
 * RGC Export Pipeline:
 * 1. extractRgcGlslFunction() - Extract GLSL from OCIO
 * 2. fixGlslForNaga() - Fix GLSL syntax for naga compatibility
 * 3. naga.convertFragmentToWGSL() - Convert GLSL to WGSL
 * 4. Build complete WGSL shader with DCTL + RGC
 *
 * If any step fails, the export falls back to non-RGC path.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

describe('RGC Export Path Verification', () => {
    const testResultsDir = getTestOutputDir();

    describe('RGC Debug File Analysis', () => {
        it('should check if RGC debug file exists', function() {
            const rgcDebugPath = path.join(testResultsDir, 'export_shader_rgc_debug.wgsl');
            const nonRgcDebugPath = path.join(testResultsDir, 'export_shader_debug.wgsl');

            console.log('\n=== RGC Export Debug File Status ===');
            console.log(`RGC path: ${rgcDebugPath}`);
            console.log(`Non-RGC path: ${nonRgcDebugPath}`);

            const rgcExists = fs.existsSync(rgcDebugPath);
            const nonRgcExists = fs.existsSync(nonRgcDebugPath);

            console.log(`\nRGC debug file exists: ${rgcExists ? '✓' : '✗ MISSING'}`);
            console.log(`Non-RGC debug file exists: ${nonRgcExists ? '✓' : '✗'}`);

            if (!rgcExists && nonRgcExists) {
                console.log('\n=== ISSUE DETECTED ===');
                console.log('RGC debug file is MISSING but non-RGC file exists.');
                console.log('This indicates the RGC path failed and fell back to non-RGC.');
                console.log('\nPossible causes:');
                console.log('1. extractRgcGlslFunction() returned null (OCIO init failed)');
                console.log('2. naga.convertFragmentToWGSL() failed (GLSL→WGSL conversion error)');
                console.log('3. RGC GLSL has syntax incompatible with naga');
                console.log('\nCheck VS Code Developer Console for error messages.');
            }

            // This test documents the state, doesn't assert
        });

        it('should validate non-RGC debug file structure when RGC is requested but fails', function() {
            const nonRgcDebugPath = path.join(testResultsDir, 'export_shader_debug.wgsl');

            if (!fs.existsSync(nonRgcDebugPath)) {
                console.log('No debug file found - run export in VS Code first');
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(nonRgcDebugPath, 'utf-8');

            console.log('\n=== Non-RGC Export Shader Analysis ===');

            // Check if this shader has RGC indicators (it shouldn't if using non-RGC path)
            const hasRgcComment = shaderCode.includes('ACES 2.0 RGC') ||
                                  shaderCode.includes('Reference Gamut Compression');
            const hasRgcFunction = /fn\s+applyACES2RGC|rgc_ocio/.test(shaderCode);
            const hasRgcTextures = /rgc_.*_tex|rgc_.*_samp/.test(shaderCode);

            console.log(`Has RGC comment: ${hasRgcComment}`);
            console.log(`Has RGC function: ${hasRgcFunction}`);
            console.log(`Has RGC textures: ${hasRgcTextures}`);

            if (!hasRgcComment && !hasRgcFunction && !hasRgcTextures) {
                console.log('\n✓ This is a pure non-RGC shader (RGC path was NOT used)');
                console.log('If you expected RGC to be applied, the RGC extraction or conversion failed.');
            } else {
                console.log('\n⚠ This shader has some RGC indicators but may be incomplete');
            }

            // Verify DCTL is at least being applied
            const hasTransform = /fn\s+transform/.test(shaderCode);
            const hasGainParam = /var<private>\s+gain/.test(shaderCode);
            const hasGainUsage = /\*\s*gain|\bgain\s*\*/.test(shaderCode);

            console.log(`\nDCTL Status:`);
            console.log(`  Has transform function: ${hasTransform ? '✓' : '✗'}`);
            console.log(`  Has gain parameter: ${hasGainParam ? '✓' : '✗'}`);
            console.log(`  Gain is used in multiplication: ${hasGainUsage ? '✓' : '✗'}`);

            // Extract gain value
            const gainMatch = shaderCode.match(/var<private>\s+gain:\s*f32\s*=\s*([^f;]+)f?;/);
            if (gainMatch) {
                console.log(`  Gain value: ${gainMatch[1]}`);
            }
        });

        it('should validate RGC debug file structure if it exists', function() {
            const rgcDebugPath = path.join(testResultsDir, 'export_shader_rgc_debug.wgsl');

            if (!fs.existsSync(rgcDebugPath)) {
                console.log('\n=== RGC Debug File NOT FOUND ===');
                console.log('The RGC export path failed. Reasons to check:');
                console.log('1. OCIO WASM not initialized');
                console.log('2. setupACES2GamutCompress() failed');
                console.log('3. Naga GLSL→WGSL conversion failed');
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(rgcDebugPath, 'utf-8');

            console.log('\n=== RGC Export Shader Validation ===');

            // Check for RGC-specific content
            const checks = {
                hasRgcComment: shaderCode.includes('ACES 2.0 RGC') ||
                               shaderCode.includes('Reference Gamut Compression'),
                hasRgcFunction: /fn\s+applyACES2RGC/.test(shaderCode),
                hasRgcHelpers: /rgc_ocio_/.test(shaderCode),
                hasRgcTextures: /rgc_.*_tex/.test(shaderCode),
                hasTransform: /fn\s+transform/.test(shaderCode),
                hasFragmentEntry: /@fragment\s*fn\s+main/.test(shaderCode),
                callsTransform: /transform\s*\(\s*p_Width\s*,\s*p_Height\s*,\s*p_X\s*,\s*p_Y\s*\)/.test(shaderCode),
            };

            let allPassed = true;
            for (const [name, passed] of Object.entries(checks)) {
                const status = passed ? '✓' : '✗';
                console.log(`${status} ${name}`);
                if (!passed) allPassed = false;
            }

            if (allPassed) {
                console.log('\n✓ RGC export shader structure is valid');
            } else {
                console.log('\n⚠ RGC export shader has missing components');
            }

            // Check gain parameter
            const gainMatch = shaderCode.match(/var<private>\s+gain:\s*f32\s*=\s*([^f;]+)f?;/);
            if (gainMatch) {
                console.log(`\nGain parameter value: ${gainMatch[1]}`);
            }
        });
    });

    describe('RGC Shader Structure Validation', () => {
        it('should detect duplicate @fragment fn main (CRITICAL BUG)', function() {
            const rgcDebugPath = path.join(testResultsDir, 'export_shader_rgc_debug.wgsl');

            if (!fs.existsSync(rgcDebugPath)) {
                console.log('\n=== RGC Duplicate Entry Point Check ===');
                console.log('RGC debug file not found - skipping');
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(rgcDebugPath, 'utf-8');

            console.log('\n=== RGC Duplicate Entry Point Check ===');

            // Count @fragment fn main declarations
            const fragmentMainMatches = shaderCode.match(/@fragment\s*\n?\s*fn\s+main/g);
            const count = fragmentMainMatches ? fragmentMainMatches.length : 0;

            console.log(`@fragment fn main count: ${count}`);

            if (count > 1) {
                // Find line numbers
                let searchIdx = 0;
                const locations: number[] = [];
                while (true) {
                    const idx = shaderCode.indexOf('@fragment', searchIdx);
                    if (idx === -1) break;
                    const lineNum = shaderCode.substring(0, idx).split('\n').length;
                    locations.push(lineNum);
                    searchIdx = idx + 10;
                }
                console.log(`Duplicate entry points at lines: ${locations.join(', ')}`);
                console.log('\nThis is a CRITICAL BUG - shader will fail to compile!');
            }

            assert.strictEqual(count, 1,
                `Expected exactly 1 @fragment fn main, found ${count}. Duplicate entry points cause WebGPU compilation failure.`);
        });

        it('should verify RGC shader has required components', function() {
            const rgcDebugPath = path.join(testResultsDir, 'export_shader_rgc_debug.wgsl');

            if (!fs.existsSync(rgcDebugPath)) {
                this.skip();
                return;
            }

            const shaderCode = fs.readFileSync(rgcDebugPath, 'utf-8');

            console.log('\n=== RGC Shader Component Validation ===');

            const components = {
                'applyACES2RGC function': /fn\s+applyACES2RGC/.test(shaderCode),
                'rgc_ocio helper functions': /fn\s+rgc_ocio_/.test(shaderCode),
                'RGC texture bindings': /rgc_.*_tex|rgc_.*_samp/.test(shaderCode),
                'hues_array': /hues_array/.test(shaderCode),
                'transform function': /fn\s+transform/.test(shaderCode),
                'dctl_sampleTexture': /fn\s+dctl_sampleTexture/.test(shaderCode),
                'AP0 to AP1 matrix': /dctl_ap0ToWorking/.test(shaderCode),
                'AP1 to AP0 matrix': /dctl_workingToAp0/.test(shaderCode),
                'ACEScct encoding': /dctl_lin_to_ACEScct/.test(shaderCode),
                'ACEScct decoding': /dctl_ACEScct_to_lin/.test(shaderCode),
                '@fragment entry point': /@fragment\s*\n?\s*fn\s+main/.test(shaderCode),
            };

            let allPassed = true;
            for (const [name, passed] of Object.entries(components)) {
                console.log(`${passed ? '✓' : '✗'} ${name}`);
                if (!passed) allPassed = false;
            }

            // Critical components
            assert.ok(components['applyACES2RGC function'], 'Must have applyACES2RGC function');
            assert.ok(components['transform function'], 'Must have transform function');
            assert.ok(components['@fragment entry point'], 'Must have @fragment entry point');
        });
    });

    describe('RGC Conversion Error Detection', () => {
        it('should detect common GLSL→WGSL conversion issues', () => {
            // Common patterns that cause naga conversion to fail
            const problematicPatterns = [
                { pattern: /const\s+float\s+\w+\s*\[/, description: 'const array declaration (use without const)' },
                { pattern: /\d+\.?\d*f\b/, description: 'C-style float suffix (1.0f should be 1.0)' },
                { pattern: /uniform\s+sampler\d+D\s+\w+\s*;/, description: 'GLSL sampler (needs layout binding)' },
                { pattern: /gl_FragCoord/, description: 'gl_FragCoord (use builtin position)' },
            ];

            console.log('\n=== Common GLSL→WGSL Conversion Issues ===');
            console.log('These patterns in GLSL may cause naga to fail:\n');

            for (const { pattern, description } of problematicPatterns) {
                console.log(`- ${description}`);
                console.log(`  Pattern: ${pattern.source}`);
            }

            console.log('\nThe fixGlslForNaga() function should handle these,');
            console.log('but some OCIO-generated GLSL may have other issues.');
        });

        it('should document expected RGC GLSL structure', () => {
            console.log('\n=== Expected RGC GLSL from OCIO ===');
            console.log(`
The extractRgcGlslFunction() should return GLSL containing:

1. Sampler declarations:
   uniform sampler2D ocio_lut1d_0;
   uniform sampler3D ocio_lut3d_0;

2. Helper functions:
   vec4 ocio_...(...) { ... }

3. Main transform function:
   vec4 OCIODisplay(vec4 inPixel) { ... }

After processing by fixGlslForNaga():
- Float suffixes removed (1.0f → 1.0)
- const arrays converted to non-const
- Sampler declarations get layout bindings

If conversion still fails, check VS Code console for specific naga error.
`);
        });
    });

    describe('RGC vs Non-RGC Comparison', () => {
        it('should compare RGC and non-RGC shader sizes and structure', function() {
            const rgcPath = path.join(testResultsDir, 'export_shader_rgc_debug.wgsl');
            const nonRgcPath = path.join(testResultsDir, 'export_shader_debug.wgsl');

            console.log('\n=== RGC vs Non-RGC Shader Comparison ===');

            const results: { name: string; exists: boolean; size: number; hasRgc: boolean }[] = [];

            if (fs.existsSync(nonRgcPath)) {
                const code = fs.readFileSync(nonRgcPath, 'utf-8');
                results.push({
                    name: 'Non-RGC',
                    exists: true,
                    size: code.length,
                    hasRgc: /applyACES2RGC|rgc_ocio/.test(code),
                });
            } else {
                results.push({ name: 'Non-RGC', exists: false, size: 0, hasRgc: false });
            }

            if (fs.existsSync(rgcPath)) {
                const code = fs.readFileSync(rgcPath, 'utf-8');
                results.push({
                    name: 'RGC',
                    exists: true,
                    size: code.length,
                    hasRgc: /applyACES2RGC|rgc_ocio/.test(code),
                });
            } else {
                results.push({ name: 'RGC', exists: false, size: 0, hasRgc: false });
            }

            console.log('\nShader | Exists | Size (chars) | Has RGC Functions');
            console.log('-'.repeat(55));
            for (const r of results) {
                console.log(`${r.name.padEnd(8)} | ${r.exists ? 'Yes   ' : 'No    '} | ${r.size.toString().padStart(12)} | ${r.hasRgc ? 'Yes' : 'No'}`);
            }

            // Analysis
            const nonRgc = results.find(r => r.name === 'Non-RGC');
            const rgc = results.find(r => r.name === 'RGC');

            if (nonRgc?.exists && !rgc?.exists) {
                console.log('\n⚠ ISSUE: Only non-RGC shader exists');
                console.log('When RGC is enabled, the RGC debug file should also be created.');
                console.log('The RGC path is failing before the shader is written.');
            }

            if (rgc?.exists && !rgc?.hasRgc) {
                console.log('\n⚠ ISSUE: RGC shader exists but has no RGC functions');
                console.log('This indicates the naga conversion succeeded but returned empty/invalid WGSL.');
            }

            if (rgc?.exists && rgc?.hasRgc && rgc.size > (nonRgc?.size || 0) + 1000) {
                console.log('\n✓ RGC shader is significantly larger (expected due to RGC functions)');
            }
        });
    });

    describe('Export Debugging Checklist', () => {
        it('should provide debugging checklist for RGC export issues', () => {
            console.log('\n=== RGC Export Debugging Checklist ===');
            console.log(`
When RGC export doesn't work, check these in order:

□ 1. Is RGC checkbox enabled in the viewer?
     The export respects the current RGC setting.

□ 2. Check VS Code Developer Console (Help → Toggle Developer Tools)
     Search for these messages:
     - "[DCTL Export]" - General export messages
     - "[ACES2 RGC]" - RGC-specific messages
     - "RGC GLSL to WGSL conversion failed" - Naga error
     - "Failed to init OCIO" - OCIO initialization error
     - "Failed to setup RGC" - RGC setup error

□ 3. Check debug files:
     - export_shader_debug.wgsl (non-RGC path)
     - export_shader_rgc_debug.wgsl (RGC path)

     If only non-RGC exists, RGC path failed.

□ 4. Check parameter injection:
     In the debug shader, look for:
     var<private> gain: f32 = VALUE;

     If VALUE is missing, parameter injection failed.

□ 5. Verify DCTL is applied:
     The shader should contain:
     - fn transform(...)
     - multiplication with gain (r * gain)

□ 6. Run automated tests:
     cd dctl-workbench/packages/vscode
     npm test

     Look for failures in "RGC Export Path" tests.
`);
        });

        it('should create summary of current RGC export state', function() {
            const rgcPath = path.join(testResultsDir, 'export_shader_rgc_debug.wgsl');
            const nonRgcPath = path.join(testResultsDir, 'export_shader_debug.wgsl');

            console.log('\n=== Current RGC Export State Summary ===\n');

            const rgcExists = fs.existsSync(rgcPath);
            const nonRgcExists = fs.existsSync(nonRgcPath);

            // Status determination
            let status: 'WORKING' | 'PARTIAL' | 'NOT_WORKING' | 'UNKNOWN' = 'UNKNOWN';
            let details = '';

            if (rgcExists) {
                const rgcCode = fs.readFileSync(rgcPath, 'utf-8');
                const hasRgcFunctions = /applyACES2RGC|rgc_ocio/.test(rgcCode);
                const hasTransform = /fn\s+transform/.test(rgcCode);
                const hasGainValue = /gain:\s*f32\s*=\s*[\d.]+f/.test(rgcCode);

                if (hasRgcFunctions && hasTransform && hasGainValue) {
                    status = 'WORKING';
                    details = 'RGC shader has all required components';
                } else if (hasTransform) {
                    status = 'PARTIAL';
                    details = `Missing: ${!hasRgcFunctions ? 'RGC functions, ' : ''}${!hasGainValue ? 'gain value' : ''}`;
                } else {
                    status = 'NOT_WORKING';
                    details = 'RGC shader is missing critical components';
                }
            } else if (nonRgcExists) {
                const nonRgcCode = fs.readFileSync(nonRgcPath, 'utf-8');
                const hasTransform = /fn\s+transform/.test(nonRgcCode);
                const hasGainValue = /gain:\s*f32\s*=\s*[\d.]+f/.test(nonRgcCode);

                status = 'NOT_WORKING';
                details = `RGC file missing. Non-RGC has transform: ${hasTransform}, gain: ${hasGainValue}`;
            } else {
                status = 'UNKNOWN';
                details = 'No debug files found - run export first';
            }

            const statusEmoji = {
                'WORKING': '✓',
                'PARTIAL': '⚠',
                'NOT_WORKING': '✗',
                'UNKNOWN': '?',
            };

            console.log(`Status: ${statusEmoji[status]} ${status}`);
            console.log(`Details: ${details}`);
            console.log(`\nFiles:`);
            console.log(`  RGC debug: ${rgcExists ? 'EXISTS' : 'MISSING'}`);
            console.log(`  Non-RGC debug: ${nonRgcExists ? 'EXISTS' : 'MISSING'}`);

            if (status === 'NOT_WORKING') {
                console.log('\n=== Recommended Actions ===');
                console.log('1. Check VS Code Developer Console for RGC errors');
                console.log('2. Verify OCIO WASM is loaded correctly');
                console.log('3. Try disabling RGC and test if basic export works');
            }
        });
    });
});
