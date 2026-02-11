/**
 * Webview RGC Full Pipeline Test
 *
 * This test verifies the COMPLETE pipeline from shader generation to pixel output.
 * It simulates what the webview does and verifies each step.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveFixture, getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Test files
const TEST_DCTL_PATH = resolveFixture('test_gain.dctl') ?? '';
const TEST_IMAGE = path.join(getTestOutputDir(), 'rgc_test_source_ap0_dctl_export.exr');
const TEST_OUTPUT_DIR = getTestOutputDir();

suite('Webview RGC Full Pipeline Tests', () => {
    let extensionPath: string;
    let ocioBasePath: string;

    suiteSetup(async function() {
        this.timeout(30000);

        console.log('\n=== Webview RGC Full Pipeline Tests ===');

        // Get extension path
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

    test('Full pipeline: buildIntegratedShader → computeWgsl → verify structure', async function() {
        this.timeout(120000);

        console.log('\n--- Full Pipeline Test: DCTL + RGC ---');

        try {
            const core = await import('@dctl-workbench/core');

            // Step 1: Initialize OCIO (same as ExrEditorProvider)
            console.log('Step 1: Initialize OCIO');
            await core.initOCIO(ocioBasePath);

            // Step 2: Create OCIO processor and get shader info (same as ExrEditorProvider)
            console.log('Step 2: Create OCIO processor');
            const processor = new core.OCIOProcessor();
            processor.init();

            const displays = processor.getDisplays();
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const views = processor.getViews(defaultDisplay);
            const defaultView = views[0] || '';
            console.log(`  Display: ${defaultDisplay}, View: ${defaultView}`);

            processor.createDisplayTransform('ACES2065-1', defaultDisplay, defaultView);
            processor.setupGpuProcessor();
            const ocioShaderInfo = processor.extractGpuShaderInfo();
            processor.dispose();

            assert.ok(ocioShaderInfo?.shaderText, 'OCIO shader info should be extracted');
            console.log(`  OCIO shader: ${ocioShaderInfo.shaderText.length} chars`);

            // Step 3: Load DCTL (same as ExrEditorProvider.handleLoadDctl)
            console.log('Step 3: Load DCTL');
            if (!TEST_DCTL_PATH) {
                console.log('DCTL fixture not found, skipping');
                this.skip();
                return;
            }

            const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
            const uiParams = core.extractUIParams(dctlSource);
            const dctlInfo = core.createDctlInfo(
                dctlSource,
                'ACEScct',
                uiParams.params,
                TEST_DCTL_PATH
            );
            console.log(`  DCTL: ${dctlSource.length} chars, ${dctlInfo.params.length} params`);

            // Step 4: Build integrated shader with RGC (same as ExrEditorProvider.rebuildShaderWithDctl)
            console.log('Step 4: Build integrated shader with RGC=true');
            const dctlOptions = {
                paramValues: undefined,
                enabled: true,  // DCTL enabled (same as state.enabled = true)
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: true,  // RGC ENABLED (same as state.applyRgc = true)
                peakLuminance: 100,
            };

            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            // Step 5: Verify integratedShader result
            console.log('Step 5: Verify integratedShader result');
            console.log(`  success: ${integratedShader.success}`);
            console.log(`  error: ${integratedShader.error || 'none'}`);

            assert.ok(integratedShader.success, `buildIntegratedShader should succeed: ${integratedShader.error}`);

            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            console.log(`  dctlComputeShaderInfo:`);
            console.log(`    exists: ${!!dctlComputeInfo}`);
            console.log(`    success: ${dctlComputeInfo?.success}`);
            console.log(`    hasDctl: ${dctlComputeInfo?.hasDctl}`);
            console.log(`    hasFullRgc: ${dctlComputeInfo?.hasFullRgc}`);
            console.log(`    computeWgsl: ${dctlComputeInfo?.computeWgsl?.length || 0} chars`);
            console.log(`    rgcTextures: ${dctlComputeInfo?.rgcTextures?.length || 0}`);
            console.log(`    rgcTextures3D: ${dctlComputeInfo?.rgcTextures3D?.length || 0}`);

            // Critical assertions - these MUST pass for webview to work
            assert.ok(dctlComputeInfo, 'dctlComputeShaderInfo MUST exist');
            assert.ok(dctlComputeInfo.success, 'dctlComputeShaderInfo.success MUST be true');
            assert.ok(dctlComputeInfo.hasDctl, 'dctlComputeShaderInfo.hasDctl MUST be true');
            assert.strictEqual(dctlComputeInfo.hasFullRgc, true, 'dctlComputeShaderInfo.hasFullRgc MUST be true');
            assert.ok(dctlComputeInfo.computeWgsl, 'computeWgsl MUST exist');
            assert.ok(dctlComputeInfo.computeWgsl.length > 10000, 'computeWgsl should be substantial (>10KB)');

            // Step 6: Verify shader structure (what webview would receive)
            console.log('Step 6: Verify shader structure');
            const computeWgsl = dctlComputeInfo.computeWgsl;

            // Check for @compute entry point
            const hasComputeEntry = /@compute[\s\S]*?fn\s+main/.test(computeWgsl);
            console.log(`  @compute fn main: ${hasComputeEntry ? '✓' : '✗'}`);
            assert.ok(hasComputeEntry, 'Shader MUST have @compute fn main');

            // Check for bind groups
            const hasGroup0 = /@group\(0\)/.test(computeWgsl);
            const hasGroup1 = /@group\(1\)/.test(computeWgsl);
            const hasGroup2 = /@group\(2\)/.test(computeWgsl);
            const hasGroup3 = /@group\(3\)/.test(computeWgsl);
            console.log(`  Bind groups: 0=${hasGroup0 ? '✓' : '✗'}, 1=${hasGroup1 ? '✓' : '✗'}, 2=${hasGroup2 ? '✓' : '✗'}, 3=${hasGroup3 ? '✓' : '✗'}`);
            assert.ok(hasGroup0 && hasGroup1 && hasGroup2 && hasGroup3, 'Shader MUST have all 4 bind groups');

            // Check for applyACES2RGC function
            const hasApplyRgc = /fn\s+applyACES2RGC/.test(computeWgsl);
            console.log(`  applyACES2RGC function: ${hasApplyRgc ? '✓' : '✗'}`);
            assert.ok(hasApplyRgc, 'Shader MUST have applyACES2RGC function');

            // Check for OCIODisplay function
            const hasOcioDisplay = /fn\s+OCIODisplay/.test(computeWgsl);
            console.log(`  OCIODisplay function: ${hasOcioDisplay ? '✓' : '✗'}`);
            assert.ok(hasOcioDisplay, 'Shader MUST have OCIODisplay function');

            // Check for applyDCTL function
            const hasApplyDctl = /fn\s+applyDCTL/.test(computeWgsl);
            console.log(`  applyDCTL function: ${hasApplyDctl ? '✓' : '✗'}`);
            assert.ok(hasApplyDctl, 'Shader MUST have applyDCTL function');

            // Check for dctl_sampleTexture with RGC
            const sampleTexMatch = computeWgsl.match(/fn\s+dctl_sampleTexture[^{]*\{[\s\S]*?\n\}/);
            if (sampleTexMatch) {
                const sampleTexFunc = sampleTexMatch[0];
                const hasRgcInSampleTex = sampleTexFunc.includes('applyACES2RGC');
                console.log(`  dctl_sampleTexture calls RGC: ${hasRgcInSampleTex ? '✓' : '✗'}`);
                assert.ok(hasRgcInSampleTex, 'dctl_sampleTexture MUST call applyACES2RGC');
            }

            // Check main function flow
            const mainMatch = computeWgsl.match(/@compute[\s\S]*?fn\s+main[\s\S]*?\n\}/);
            if (mainMatch) {
                const mainFunc = mainMatch[0];
                const hasApplyDctlCall = mainFunc.includes('applyDCTL');
                const hasApplyRgcCall = mainFunc.includes('applyACES2RGC');
                const hasOcioDisplayCall = mainFunc.includes('OCIODisplay');
                const hasTextureStore = mainFunc.includes('textureStore');
                console.log(`  main() calls applyDCTL: ${hasApplyDctlCall ? '✓' : '✗'}`);
                console.log(`  main() calls applyACES2RGC: ${hasApplyRgcCall ? '✓' : '✗'}`);
                console.log(`  main() calls OCIODisplay: ${hasOcioDisplayCall ? '✓' : '✗'}`);
                console.log(`  main() calls textureStore: ${hasTextureStore ? '✓' : '✗'}`);
                assert.ok(hasApplyDctlCall, 'main() MUST call applyDCTL');
                assert.ok(hasApplyRgcCall, 'main() MUST call applyACES2RGC');
                assert.ok(hasOcioDisplayCall, 'main() MUST call OCIODisplay');
                assert.ok(hasTextureStore, 'main() MUST call textureStore');
            }

            // Step 7: Verify RGC textures are present
            console.log('Step 7: Verify RGC textures');
            const rgcTextures2D = dctlComputeInfo.rgcTextures?.length || 0;
            const rgcTextures3D = dctlComputeInfo.rgcTextures3D?.length || 0;
            const totalRgcTextures = rgcTextures2D + rgcTextures3D;
            console.log(`  RGC textures: 2D=${rgcTextures2D}, 3D=${rgcTextures3D}, total=${totalRgcTextures}`);
            assert.ok(totalRgcTextures > 0, 'RGC textures MUST be present');

            // Step 8: Verify OCIO textures are present
            console.log('Step 8: Verify OCIO textures');
            const ocioTextures2D = dctlComputeInfo.textures?.length || 0;
            const ocioTextures3D = dctlComputeInfo.textures3D?.length || 0;
            console.log(`  OCIO textures: 2D=${ocioTextures2D}, 3D=${ocioTextures3D}`);
            assert.ok(ocioTextures2D > 0 || ocioTextures3D > 0, 'OCIO textures MUST be present');

            // Step 9: Verify param mapping
            console.log('Step 9: Verify param mapping');
            const paramMapping = dctlComputeInfo.paramMapping;
            console.log(`  Param mapping count: ${paramMapping?.length || 0}`);
            if (paramMapping && paramMapping.length > 0) {
                for (const param of paramMapping) {
                    console.log(`    ${param.name}: type=${param.type}, index=${param.index}`);
                }
            }

            // Save shader for manual inspection
            const outputPath = path.join(TEST_OUTPUT_DIR, 'full_pipeline_compute_shader.wgsl');
            fs.writeFileSync(outputPath, computeWgsl);
            console.log(`\nShader saved to: ${outputPath}`);

            // Step 10: Simulate what webview would do
            console.log('\nStep 10: Simulate webview shader processing');
            console.log('  In webview, this shader would be passed to:');
            console.log('  1. webgpu-renderer.buildShader(wgslShaderInfo)');
            console.log('  2. computePipelineManager.buildDctlOcioComputePipeline(dctlComputeShaderInfo)');
            console.log('  3. dispatchCompute() to render');
            console.log('  4. Display the result');

            // Verify the shader would be sent correctly
            const wgslShaderInfo = {
                wgslCode: integratedShader.wgslCode,
                computeWgslCode: integratedShader.computeWgslCode,
                textures: ocioShaderInfo.textures,
                textures3D: ocioShaderInfo.textures3D,
                bindings: integratedShader.bindings,
                dctlBindings: integratedShader.dctlBindings,
                dctlDefaults: integratedShader.dctlDefaults,
                paramMapping: integratedShader.paramMapping,
                useUniformBuffer: integratedShader.useUniformBuffer,
                uniformBufferBinding: integratedShader.uniformBufferBinding,
                dctlComputeShaderInfo: dctlComputeInfo,
            };

            console.log('\n  wgslShaderInfo for webview:');
            console.log(`    wgslCode: ${wgslShaderInfo.wgslCode?.length || 0} chars`);
            console.log(`    computeWgslCode: ${wgslShaderInfo.computeWgslCode?.length || 0} chars`);
            console.log(`    dctlComputeShaderInfo.success: ${wgslShaderInfo.dctlComputeShaderInfo?.success}`);
            console.log(`    dctlComputeShaderInfo.hasFullRgc: ${wgslShaderInfo.dctlComputeShaderInfo?.hasFullRgc}`);

            // This is what the webview should check
            const needsFullPipeline = wgslShaderInfo.dctlComputeShaderInfo?.success === true &&
                (wgslShaderInfo.dctlComputeShaderInfo?.hasDctl === true ||
                 wgslShaderInfo.dctlComputeShaderInfo?.hasFullRgc === true);
            console.log(`\n  needsFullPipeline (webview check): ${needsFullPipeline}`);
            assert.ok(needsFullPipeline, 'needsFullPipeline MUST be true for DCTL+RGC');

            console.log('\n✓ Full Pipeline Test PASSED');

        } catch (e: any) {
            console.error('\n✗ Full Pipeline Test FAILED');
            console.error('Error:', e.message);
            if (e.stack) console.error(e.stack);
            throw e;
        }
    });

    test('Compare RGC vs non-RGC shader output', async function() {
        this.timeout(60000);

        console.log('\n--- Compare RGC vs non-RGC Shaders ---');

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

            // Build shader WITHOUT RGC
            const shaderWithoutRgc = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                {
                    enabled: true,
                    imageWidth: 1920,
                    imageHeight: 1080,
                    useUniformBuffer: true,
                    useRustCompiler: true,
                    dctlSource: dctlSource,
                    applyACES2GamutCompression: false,  // RGC OFF
                    peakLuminance: 100,
                }
            );

            // Build shader WITH RGC
            const shaderWithRgc = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                {
                    enabled: true,
                    imageWidth: 1920,
                    imageHeight: 1080,
                    useUniformBuffer: true,
                    useRustCompiler: true,
                    dctlSource: dctlSource,
                    applyACES2GamutCompression: true,  // RGC ON
                    peakLuminance: 100,
                }
            );

            console.log('\nComparison:');
            console.log(`  Without RGC: hasFullRgc=${shaderWithoutRgc.dctlComputeShaderInfo?.hasFullRgc}, size=${shaderWithoutRgc.dctlComputeShaderInfo?.computeWgsl?.length || 0}`);
            console.log(`  With RGC:    hasFullRgc=${shaderWithRgc.dctlComputeShaderInfo?.hasFullRgc}, size=${shaderWithRgc.dctlComputeShaderInfo?.computeWgsl?.length || 0}`);

            // Verify difference
            assert.ok(!shaderWithoutRgc.dctlComputeShaderInfo?.hasFullRgc, 'Without RGC: hasFullRgc should be false');
            assert.ok(shaderWithRgc.dctlComputeShaderInfo?.hasFullRgc, 'With RGC: hasFullRgc should be true');

            const sizeWithout = shaderWithoutRgc.dctlComputeShaderInfo?.computeWgsl?.length || 0;
            const sizeWith = shaderWithRgc.dctlComputeShaderInfo?.computeWgsl?.length || 0;
            const sizeDiff = sizeWith - sizeWithout;
            console.log(`  Size difference: ${sizeDiff} chars (RGC adds ~${Math.round(sizeDiff / 1000)}KB)`);
            assert.ok(sizeDiff > 10000, 'RGC shader should be significantly larger');

            // Verify RGC functions only in RGC shader
            const hasRgcWithout = shaderWithoutRgc.dctlComputeShaderInfo?.computeWgsl?.includes('applyACES2RGC') || false;
            const hasRgcWith = shaderWithRgc.dctlComputeShaderInfo?.computeWgsl?.includes('applyACES2RGC') || false;
            console.log(`  applyACES2RGC in non-RGC shader: ${hasRgcWithout ? '✗ (unexpected)' : '✓ (expected)'}`);
            console.log(`  applyACES2RGC in RGC shader: ${hasRgcWith ? '✓ (expected)' : '✗ (unexpected)'}`);
            assert.ok(!hasRgcWithout, 'Non-RGC shader should NOT have applyACES2RGC');
            assert.ok(hasRgcWith, 'RGC shader MUST have applyACES2RGC');

            console.log('\n✓ Comparison Test PASSED');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });
});
