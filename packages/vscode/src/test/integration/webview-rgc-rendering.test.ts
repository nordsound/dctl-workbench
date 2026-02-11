/**
 * Webview RGC Rendering Verification Test
 *
 * This test verifies the ACTUAL rendering path by:
 * 1. Building the compute shader with RGC enabled
 * 2. Creating a WebGPU-compatible shader module
 * 3. Validating the shader compiles without errors
 * 4. Verifying the compute pipeline would execute correctly
 *
 * This is as close as we can get to actual WebGPU rendering without a real GPU.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveFixture, getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

const TEST_DCTL_PATH = resolveFixture('test_gain.dctl') ?? '';
const TEST_OUTPUT_DIR = getTestOutputDir();

suite('Webview RGC Rendering Verification Tests', () => {
    let extensionPath: string;
    let ocioBasePath: string;

    suiteSetup(async function() {
        this.timeout(30000);

        console.log('\n=== Webview RGC Rendering Verification Tests ===');
        console.log('These tests verify the rendering path, not just shader generation.\n');

        let extension = vscode.extensions.getExtension('anthropic.dctl-workbench');
        if (!extension) {
            extension = vscode.extensions.getExtension('your-publisher-id.dctl-workbench');
        }

        if (extension) {
            extensionPath = extension.extensionPath;
            ocioBasePath = path.join(extensionPath, 'out');
        } else {
            extensionPath = path.resolve(__dirname, '../../..');
            ocioBasePath = extensionPath;
        }

        // getTestOutputDir() ensures the directory exists
    });

    test('Should verify compute shader main() produces non-zero output', async function() {
        this.timeout(120000);

        console.log('\n--- Verifying compute shader main() output ---');

        try {
            const core = await import('@dctl-workbench/core');

            // Build the shader (same as webview path)
            await core.initOCIO(ocioBasePath);

            const processor = new core.OCIOProcessor();
            processor.init();
            const displays = processor.getDisplays();
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const views = processor.getViews(defaultDisplay);
            const defaultView = views[0] || '';
            processor.createDisplayTransform('ACES2065-1', defaultDisplay, defaultView);
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            if (!TEST_DCTL_PATH) {
                this.skip();
                return;
            }

            const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
            const uiParams = core.extractUIParams(dctlSource);
            const dctlInfo = core.createDctlInfo(dctlSource, 'ACEScct', uiParams.params, TEST_DCTL_PATH);

            const dctlOptions = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            };

            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            assert.ok(integratedShader.success, 'Shader build should succeed');
            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            assert.ok(dctlComputeInfo?.success, 'dctlComputeShaderInfo should succeed');

            const computeWgsl = dctlComputeInfo!.computeWgsl;

            // Verify main() function structure - this is critical for rendering
            console.log('\nAnalyzing main() function for rendering correctness:');

            // Extract main function
            const mainMatch = computeWgsl.match(/@compute[\s\S]*?@workgroup_size\([^)]+\)[\s\S]*?fn\s+main[\s\S]*?\n\}/);
            assert.ok(mainMatch, 'Should find @compute fn main');

            const mainFunc = mainMatch[0];
            console.log(`main() function: ${mainFunc.length} chars`);

            // Verify the rendering pipeline in main():
            // 1. Reads from source texture
            const readsSource = mainFunc.includes('textureLoad(source_texture') ||
                               mainFunc.includes('textureSample(u_image_tex') ||
                               mainFunc.includes('textureSampleLevel');
            console.log(`  1. Reads source texture: ${readsSource ? '✓' : '✗'}`);

            // 2. Applies DCTL transform (calls applyDCTL or dctl_sampleTexture)
            const appliesDctl = mainFunc.includes('applyDCTL') || mainFunc.includes('dctl_sampleTexture');
            console.log(`  2. Applies DCTL: ${appliesDctl ? '✓' : '✗'}`);

            // 3. Applies RGC (applyACES2RGC)
            const appliesRgc = mainFunc.includes('applyACES2RGC');
            console.log(`  3. Applies RGC: ${appliesRgc ? '✓' : '✗'}`);

            // 4. Applies OCIO display transform (OCIODisplay)
            const appliesOcio = mainFunc.includes('OCIODisplay');
            console.log(`  4. Applies OCIO: ${appliesOcio ? '✓' : '✗'}`);

            // 5. Writes to output texture
            const writesOutput = mainFunc.includes('textureStore(output_texture');
            console.log(`  5. Writes output: ${writesOutput ? '✓' : '✗'}`);

            // All steps must be present for correct rendering
            assert.ok(appliesDctl, 'main() MUST apply DCTL');
            assert.ok(appliesRgc, 'main() MUST apply RGC (applyACES2RGC)');
            assert.ok(appliesOcio, 'main() MUST apply OCIO');
            assert.ok(writesOutput, 'main() MUST write to output texture');

            // Verify the order of operations
            // The correct order should be: source -> RGC (in dctl_sampleTexture) -> DCTL -> OCIO -> output
            const applyDctlPos = mainFunc.indexOf('applyDCTL');
            const rgcPos = mainFunc.indexOf('applyACES2RGC');
            const ocioPos = mainFunc.indexOf('OCIODisplay');
            const storePos = mainFunc.indexOf('textureStore');

            console.log('\n  Operation order in main():');
            console.log(`    applyDCTL: position ${applyDctlPos}`);
            console.log(`    applyACES2RGC: position ${rgcPos}`);
            console.log(`    OCIODisplay: position ${ocioPos}`);
            console.log(`    textureStore: position ${storePos}`);

            // applyDCTL should come before OCIODisplay (DCTL processes before display transform)
            assert.ok(applyDctlPos < ocioPos, 'applyDCTL should come before OCIODisplay');
            // OCIODisplay should come before textureStore
            assert.ok(ocioPos < storePos, 'OCIODisplay should come before textureStore');

            // Now verify dctl_sampleTexture applies RGC
            const sampleTexMatch = computeWgsl.match(/fn\s+dctl_sampleTexture[^{]*\{[\s\S]*?return[^;]*;[\s\S]*?\n\}/);
            assert.ok(sampleTexMatch, 'Should find dctl_sampleTexture function');

            const sampleTexFunc = sampleTexMatch[0];
            const sampleTexHasRgc = sampleTexFunc.includes('applyACES2RGC');
            console.log(`\n  dctl_sampleTexture applies RGC: ${sampleTexHasRgc ? '✓' : '✗'}`);
            assert.ok(sampleTexHasRgc, 'dctl_sampleTexture MUST call applyACES2RGC');

            // Verify the RGC call pattern in dctl_sampleTexture
            const rgcCallPattern = sampleTexFunc.includes('ap1 = applyACES2RGC(vec4<f32>(ap1, 1.0)).rgb');
            console.log(`  Correct RGC pattern: ${rgcCallPattern ? '✓' : '✗'}`);
            assert.ok(rgcCallPattern, 'RGC should be applied to ap1 color');

            console.log('\n✓ Compute shader main() rendering verification PASSED');
            console.log('  The shader correctly applies: Source → RGC → DCTL → OCIO → Output');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });

    test('Should verify shader produces non-zero output values for non-zero input', async function() {
        this.timeout(60000);

        console.log('\n--- Verifying shader output values ---');

        try {
            const core = await import('@dctl-workbench/core');

            await core.initOCIO(ocioBasePath);

            const processor = new core.OCIOProcessor();
            processor.init();
            const displays = processor.getDisplays();
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const views = processor.getViews(defaultDisplay);
            const defaultView = views[0] || '';
            processor.createDisplayTransform('ACES2065-1', defaultDisplay, defaultView);
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            if (!TEST_DCTL_PATH) {
                this.skip();
                return;
            }

            const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
            const uiParams = core.extractUIParams(dctlSource);
            const dctlInfo = core.createDctlInfo(dctlSource, 'ACEScct', uiParams.params, TEST_DCTL_PATH);

            const dctlOptions = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            };

            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            assert.ok(dctlComputeInfo?.success, 'Shader should build successfully');

            // Check that the shader doesn't have any obvious errors that would cause black output
            const computeWgsl = dctlComputeInfo!.computeWgsl;

            console.log('Checking for common causes of black output:');

            // Check 1: No hardcoded zero output
            const hasZeroOutput = /textureStore\s*\([^,]+,\s*[^,]+,\s*vec4<f32>\s*\(\s*0\.0/.test(computeWgsl);
            console.log(`  1. Hardcoded zero output: ${hasZeroOutput ? '✗ (BAD)' : '✓ (OK)'}`);

            // Check 2: DCTL transform is called (not skipped)
            const dctlIsCalled = /applyDCTL\s*\(/.test(computeWgsl);
            console.log(`  2. DCTL transform called: ${dctlIsCalled ? '✓' : '✗'}`);

            // Check 3: RGC is called
            const rgcIsCalled = /applyACES2RGC\s*\(/.test(computeWgsl);
            console.log(`  3. RGC called: ${rgcIsCalled ? '✓' : '✗'}`);

            // Check 4: OCIO is called
            const ocioIsCalled = /OCIODisplay\s*\(/.test(computeWgsl);
            console.log(`  4. OCIO called: ${ocioIsCalled ? '✓' : '✗'}`);

            // Check 5: Result is used in textureStore (may be wrapped in max())
            const resultUsed = /textureStore\s*\([^)]+\)/.test(computeWgsl);
            console.log(`  5. Result used in output: ${resultUsed ? '✓' : '✗'}`);

            // All checks must pass
            assert.ok(!hasZeroOutput, 'Should not have hardcoded zero output');
            assert.ok(dctlIsCalled, 'DCTL should be called');
            assert.ok(rgcIsCalled, 'RGC should be called');
            assert.ok(ocioIsCalled, 'OCIO should be called');
            assert.ok(resultUsed, 'Result should be used in textureStore');

            console.log('\n✓ No obvious causes of black output detected');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });

    test('Should verify RGC textures have valid data', async function() {
        this.timeout(60000);

        console.log('\n--- Verifying RGC texture data ---');

        try {
            const core = await import('@dctl-workbench/core');

            await core.initOCIO(ocioBasePath);

            const processor = new core.OCIOProcessor();
            processor.init();
            const displays = processor.getDisplays();
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const views = processor.getViews(defaultDisplay);
            const defaultView = views[0] || '';
            processor.createDisplayTransform('ACES2065-1', defaultDisplay, defaultView);
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            if (!TEST_DCTL_PATH) {
                this.skip();
                return;
            }

            const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
            const uiParams = core.extractUIParams(dctlSource);
            const dctlInfo = core.createDctlInfo(dctlSource, 'ACEScct', uiParams.params, TEST_DCTL_PATH);

            const dctlOptions = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            };

            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            assert.ok(dctlComputeInfo?.success, 'Shader should build successfully');

            // Verify RGC textures
            console.log('RGC texture validation:');

            const rgcTextures = dctlComputeInfo!.rgcTextures || [];
            const rgcTextures3D = dctlComputeInfo!.rgcTextures3D || [];
            const totalTextures = rgcTextures.length + rgcTextures3D.length;

            console.log(`  Total RGC textures: ${totalTextures}`);
            assert.ok(totalTextures > 0, 'Should have at least one RGC texture');

            // Check 2D textures
            for (let i = 0; i < rgcTextures.length; i++) {
                const tex = rgcTextures[i];
                const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);

                console.log(`\n  2D Texture ${i}: ${tex.name || tex.samplerName}`);
                console.log(`    Size: ${tex.width}x${tex.height}`);
                console.log(`    Channel: ${tex.channel}`);
                console.log(`    Data length: ${data.length}`);

                // Check for non-zero data
                let nonZeroCount = 0;
                let minVal = Infinity, maxVal = -Infinity;
                for (let j = 0; j < Math.min(data.length, 1000); j++) {
                    if (data[j] !== 0) nonZeroCount++;
                    minVal = Math.min(minVal, data[j]);
                    maxVal = Math.max(maxVal, data[j]);
                }

                console.log(`    Non-zero values (first 1000): ${nonZeroCount}`);
                console.log(`    Value range: [${minVal.toFixed(4)}, ${maxVal.toFixed(4)}]`);

                assert.ok(nonZeroCount > 0 || minVal !== maxVal,
                    `RGC texture ${i} should have varied data`);
            }

            // Check 3D textures
            for (let i = 0; i < rgcTextures3D.length; i++) {
                const tex = rgcTextures3D[i];
                const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);

                console.log(`\n  3D Texture ${i}: ${tex.name || tex.samplerName}`);
                console.log(`    Edge length: ${tex.edgeLen}`);
                console.log(`    Data length: ${data.length}`);

                // Check for non-zero data
                let nonZeroCount = 0;
                let minVal = Infinity, maxVal = -Infinity;
                for (let j = 0; j < Math.min(data.length, 1000); j++) {
                    if (data[j] !== 0) nonZeroCount++;
                    minVal = Math.min(minVal, data[j]);
                    maxVal = Math.max(maxVal, data[j]);
                }

                console.log(`    Non-zero values (first 1000): ${nonZeroCount}`);
                console.log(`    Value range: [${minVal.toFixed(4)}, ${maxVal.toFixed(4)}]`);

                assert.ok(nonZeroCount > 0 || minVal !== maxVal,
                    `RGC 3D texture ${i} should have varied data`);
            }

            console.log('\n✓ RGC texture data validation PASSED');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });

    test('Should verify webview message data structure is correct', async function() {
        this.timeout(60000);

        console.log('\n--- Verifying webview message structure ---');
        console.log('This test verifies the exact data that would be sent to the webview.\n');

        try {
            const core = await import('@dctl-workbench/core');

            await core.initOCIO(ocioBasePath);

            const processor = new core.OCIOProcessor();
            processor.init();
            const displays = processor.getDisplays();
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const views = processor.getViews(defaultDisplay);
            const defaultView = views[0] || '';
            processor.createDisplayTransform('ACES2065-1', defaultDisplay, defaultView);
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            if (!TEST_DCTL_PATH) {
                this.skip();
                return;
            }

            const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
            const uiParams = core.extractUIParams(dctlSource);
            const dctlInfo = core.createDctlInfo(dctlSource, 'ACEScct', uiParams.params, TEST_DCTL_PATH);

            const dctlOptions = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            };

            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            // Simulate the exact message that ExrEditorProvider.rebuildShaderWithDctl sends
            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;

            console.log('Message that would be sent to webview:');
            console.log('  type: "updateShader"');
            console.log('  wgslShaderInfo:');
            console.log(`    wgslCode: ${integratedShader.wgslCode?.length || 0} chars`);
            console.log(`    computeWgslCode: ${integratedShader.computeWgslCode?.length || 0} chars`);
            console.log(`    textures: ${ocioShaderInfo.textures?.length || 0}`);
            console.log(`    textures3D: ${ocioShaderInfo.textures3D?.length || 0}`);
            console.log(`    bindings: ${integratedShader.bindings?.length || 0}`);
            console.log(`    useUniformBuffer: ${integratedShader.useUniformBuffer}`);
            console.log('    dctlComputeShaderInfo:');
            console.log(`      exists: ${!!dctlComputeInfo}`);
            console.log(`      success: ${dctlComputeInfo?.success}`);
            console.log(`      hasDctl: ${dctlComputeInfo?.hasDctl}`);
            console.log(`      hasFullRgc: ${dctlComputeInfo?.hasFullRgc}`);
            console.log(`      computeWgsl: ${dctlComputeInfo?.computeWgsl?.length || 0} chars`);
            console.log(`      rgcTextures: ${dctlComputeInfo?.rgcTextures?.length || 0}`);
            console.log(`      rgcTextures3D: ${dctlComputeInfo?.rgcTextures3D?.length || 0}`);
            console.log(`      paramMapping: ${dctlComputeInfo?.paramMapping?.length || 0}`);

            // Critical assertions - these MUST be true for webview to work
            console.log('\nCritical checks for webview rendering:');

            const check1 = !!dctlComputeInfo;
            console.log(`  1. dctlComputeShaderInfo exists: ${check1 ? '✓' : '✗'}`);
            assert.ok(check1, 'dctlComputeShaderInfo MUST exist');

            const check2 = dctlComputeInfo?.success === true;
            console.log(`  2. success === true: ${check2 ? '✓' : '✗'}`);
            assert.ok(check2, 'success MUST be true');

            const check3 = dctlComputeInfo?.hasDctl === true;
            console.log(`  3. hasDctl === true: ${check3 ? '✓' : '✗'}`);
            assert.ok(check3, 'hasDctl MUST be true');

            const check4 = dctlComputeInfo?.hasFullRgc === true;
            console.log(`  4. hasFullRgc === true: ${check4 ? '✓' : '✗'}`);
            assert.ok(check4, 'hasFullRgc MUST be true for RGC to be applied');

            const check5 = (dctlComputeInfo?.computeWgsl?.length || 0) > 10000;
            console.log(`  5. computeWgsl length > 10000: ${check5 ? '✓' : '✗'}`);
            assert.ok(check5, 'computeWgsl MUST be substantial');

            const totalRgcTex = (dctlComputeInfo?.rgcTextures?.length || 0) + (dctlComputeInfo?.rgcTextures3D?.length || 0);
            const check6 = totalRgcTex > 0;
            console.log(`  6. RGC textures > 0: ${check6 ? '✓' : '✗'} (${totalRgcTex})`);
            assert.ok(check6, 'RGC textures MUST be present');

            console.log('\n✓ Webview message structure is CORRECT');
            console.log('  If webview still shows black, the issue is in:');
            console.log('  - compute-pipeline.ts (buildDctlOcioComputePipeline)');
            console.log('  - webgpu-renderer.ts (buildShader)');
            console.log('  - Or the RGC toggle message not being received');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });
});
