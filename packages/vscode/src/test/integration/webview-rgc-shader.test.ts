/**
 * Webview RGC Shader Integration Tests
 *
 * Tests the ACTUAL code path used by the webview display:
 * buildIntegratedShader -> buildDctlComputeShader -> dctlComputeShaderInfo
 *
 * This is different from the export path (buildDctlExportShader).
 */

console.log('[webview-rgc-shader.test.ts] Module loading...');

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveFixture, getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Use shared test-paths for test files
const TEST_DCTL_PATH = resolveFixture('test_gain.dctl') ?? '';
const TEST_OUTPUT_DIR = getTestOutputDir();

console.log('[webview-rgc-shader.test.ts] Registering suite...');

suite('Webview RGC Shader Integration Tests', () => {
    console.log('[webview-rgc-shader.test.ts] Inside suite callback');
    let extensionPath: string;
    let ocioBasePath: string;

    suiteSetup(async function() {
        this.timeout(30000);

        console.log('\n=== Webview RGC Shader Integration Tests ===');

        // Get extension path - try multiple extension IDs
        let extension = vscode.extensions.getExtension('anthropic.dctl-workbench');
        if (!extension) {
            extension = vscode.extensions.getExtension('your-publisher-id.dctl-workbench');
        }

        if (extension) {
            // Extension found - extensionPath is the source root
            extensionPath = extension.extensionPath;
            // initOCIO expects base path, it will add wasm/ocio internally
            ocioBasePath = path.join(extensionPath, 'out');
        } else {
            // Fallback - __dirname is inside out/src/test/integration
            // Go up 3 levels to get to 'out' directory
            extensionPath = path.resolve(__dirname, '../../..');
            // In fallback, extensionPath is already 'out', so use it directly
            ocioBasePath = extensionPath;
        }
        console.log(`Extension path: ${extensionPath}`);
        console.log(`OCIO base path: ${ocioBasePath}`);

        // getTestOutputDir() ensures the directory exists
    });

    test('buildIntegratedShader with RGC should return hasFullRgc=true', async function() {
        this.timeout(60000);

        console.log('\n--- Testing buildIntegratedShader with RGC ---');

        try {
            // Import core module (same as used by ExrEditorProvider)
            const core = await import('@dctl-workbench/core');

            // Initialize OCIO
            await core.initOCIO(ocioBasePath);
            console.log('OCIO initialized');

            // Create OCIO processor and get shader info (same as ExrEditorProvider.rebuildShaderWithDctl)
            const processor = new core.OCIOProcessor();
            const initResult = processor.init();
            console.log(`OCIO processor init: ${initResult}`);

            // Get displays and views dynamically (same as ExrEditorProvider)
            const displays = processor.getDisplays();
            const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
            const views = processor.getViews(defaultDisplay);
            const defaultView = views[0] || '';
            console.log(`Using display: ${defaultDisplay}, view: ${defaultView}`);
            console.log(`  Available displays: ${displays.slice(0, 5).join(', ')}${displays.length > 5 ? '...' : ''}`);
            console.log(`  Available views for ${defaultDisplay}: ${views.slice(0, 5).join(', ')}${views.length > 5 ? '...' : ''}`);

            const createResult = processor.createDisplayTransform('ACES2065-1', defaultDisplay, defaultView);
            console.log(`createDisplayTransform: ${createResult}`);

            if (!createResult) {
                const lastError = processor.getLastError?.() ?? 'Unknown error';
                throw new Error(`Failed to create display transform: ${lastError}`);
            }

            const gpuResult = processor.setupGpuProcessor();
            console.log(`setupGpuProcessor: ${gpuResult}`);

            const ocioShaderInfo = processor.extractGpuShaderInfo();
            console.log(`OCIO shader info: shaderText=${ocioShaderInfo?.shaderText?.length || 0} chars`);
            processor.dispose();

            if (!ocioShaderInfo || !ocioShaderInfo.shaderText) {
                throw new Error('Failed to extract OCIO shader info');
            }

            console.log(`OCIO shader: ${ocioShaderInfo.shaderText.length} chars`);

            // Load a simple DCTL
            if (!TEST_DCTL_PATH) {
                console.log('DCTL fixture not found');
                this.skip();
                return;
            }
            const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
            console.log(`DCTL loaded: ${dctlSource.length} chars`);

            // Parse DCTL to get params
            const uiParams = core.extractUIParams(dctlSource);
            console.log(`DCTL params extracted: ${uiParams.params.length} params`);

            const dctlInfo = core.createDctlInfo(
                dctlSource,
                'ACEScct',
                uiParams.params,
                TEST_DCTL_PATH
            );
            console.log(`DCTL info created: ${dctlInfo.params.length} params`);

            // THIS IS THE KEY TEST: Call buildIntegratedShader with RGC enabled
            // This is the exact same call made by ExrEditorProvider.rebuildShaderWithDctl
            const dctlOptions = {
                paramValues: undefined,
                enabled: true,  // DCTL enabled
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: true,  // RGC ENABLED
                peakLuminance: 100,
            };

            console.log('Calling buildIntegratedShader with RGC=true...');
            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            console.log(`buildIntegratedShader result:`);
            console.log(`  success: ${integratedShader.success}`);
            console.log(`  wgslCode length: ${integratedShader.wgslCode?.length || 0}`);
            console.log(`  computeWgslCode length: ${integratedShader.computeWgslCode?.length || 0}`);

            // Check dctlComputeShaderInfo - THIS IS WHAT THE WEBVIEW USES
            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            console.log(`  dctlComputeShaderInfo:`);
            console.log(`    exists: ${!!dctlComputeInfo}`);
            console.log(`    success: ${dctlComputeInfo?.success}`);
            console.log(`    hasDctl: ${dctlComputeInfo?.hasDctl}`);
            console.log(`    hasFullRgc: ${dctlComputeInfo?.hasFullRgc}`);
            console.log(`    computeWgsl length: ${dctlComputeInfo?.computeWgsl?.length || 0}`);
            console.log(`    rgcTextures: ${dctlComputeInfo?.rgcTextures?.length || 0}`);
            console.log(`    rgcTextures3D: ${dctlComputeInfo?.rgcTextures3D?.length || 0}`);

            // CRITICAL ASSERTIONS - These must pass for webview to work
            assert.ok(integratedShader.success, 'buildIntegratedShader should succeed');
            assert.ok(dctlComputeInfo, 'dctlComputeShaderInfo should exist');
            assert.ok(dctlComputeInfo.success, 'dctlComputeShaderInfo.success should be true');
            assert.ok(dctlComputeInfo.hasDctl, 'dctlComputeShaderInfo.hasDctl should be true');

            // THIS IS THE KEY ASSERTION FOR RGC
            assert.strictEqual(dctlComputeInfo.hasFullRgc, true,
                'dctlComputeShaderInfo.hasFullRgc MUST be true when RGC is enabled');

            // Verify RGC textures exist
            const totalRgcTextures = (dctlComputeInfo.rgcTextures?.length || 0) +
                                     (dctlComputeInfo.rgcTextures3D?.length || 0);
            assert.ok(totalRgcTextures > 0, 'RGC textures should be present');

            // Verify compute shader contains applyACES2RGC
            const computeWgsl = dctlComputeInfo.computeWgsl;
            assert.ok(computeWgsl, 'computeWgsl should exist');
            assert.ok(computeWgsl.includes('applyACES2RGC'),
                'Compute shader should contain applyACES2RGC function');

            // Save debug file for inspection
            const debugPath = path.join(TEST_OUTPUT_DIR, 'webview_compute_shader_rgc.wgsl');
            fs.writeFileSync(debugPath, computeWgsl);
            console.log(`Debug shader saved: ${debugPath}`);

            // Verify dctl_sampleTexture includes applyACES2RGC call
            const sampleTexMatch = computeWgsl.match(/fn\s+dctl_sampleTexture[^{]*\{[\s\S]*?return[^;]*;[\s\S]*?\n\}/);
            if (sampleTexMatch) {
                const sampleTexFunc = sampleTexMatch[0];
                console.log('\ndctl_sampleTexture function:');
                console.log(sampleTexFunc.substring(0, 500) + '...');

                const hasRgcCall = sampleTexFunc.includes('applyACES2RGC');
                console.log(`\ndctl_sampleTexture calls applyACES2RGC: ${hasRgcCall ? '✓' : '✗'}`);
                assert.ok(hasRgcCall, 'dctl_sampleTexture MUST call applyACES2RGC when RGC is enabled');
            }

            // Verify main compute entry point exists
            const hasComputeMain = /@compute[\s\S]*?fn\s+main/.test(computeWgsl);
            console.log(`Has @compute fn main: ${hasComputeMain ? '✓' : '✗'}`);
            assert.ok(hasComputeMain, 'Compute shader should have @compute fn main');

            // Verify bind groups are defined
            const hasGroup0 = /@group\(0\)/.test(computeWgsl);
            const hasGroup1 = /@group\(1\)/.test(computeWgsl);
            const hasGroup2 = /@group\(2\)/.test(computeWgsl);
            const hasGroup3 = /@group\(3\)/.test(computeWgsl);
            console.log(`Bind groups: g0=${hasGroup0 ? '✓' : '✗'}, g1=${hasGroup1 ? '✓' : '✗'}, g2=${hasGroup2 ? '✓' : '✗'}, g3=${hasGroup3 ? '✓' : '✗'}`);
            assert.ok(hasGroup0 && hasGroup1 && hasGroup2, 'Compute shader should have bind groups 0, 1, 2');

            console.log('\n✓ buildIntegratedShader with RGC test PASSED');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            if (e.stack) console.error(e.stack);
            throw e;
        }
    });

    test('buildIntegratedShader WITHOUT RGC should return hasFullRgc=false', async function() {
        this.timeout(60000);

        console.log('\n--- Testing buildIntegratedShader WITHOUT RGC ---');

        try {
            const core = await import('@dctl-workbench/core');

            // Use pre-computed ocioBasePath
            await core.initOCIO(ocioBasePath);

            // Get OCIO shader info with dynamic display/view selection
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

            if (!ocioShaderInfo?.shaderText) {
                throw new Error('Failed to extract OCIO shader info');
            }

            if (!TEST_DCTL_PATH) {
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

            // Call buildIntegratedShader with RGC DISABLED
            const dctlOptions = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource: dctlSource,
                applyACES2GamutCompression: false,  // RGC DISABLED
                peakLuminance: 100,
            };

            console.log('Calling buildIntegratedShader with RGC=false...');
            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                dctlOptions
            );

            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            console.log(`  hasFullRgc: ${dctlComputeInfo?.hasFullRgc}`);

            assert.ok(integratedShader.success, 'buildIntegratedShader should succeed');
            assert.ok(dctlComputeInfo, 'dctlComputeShaderInfo should exist');

            // When RGC is disabled, hasFullRgc should be false or undefined
            assert.ok(!dctlComputeInfo.hasFullRgc,
                'hasFullRgc should be false when RGC is disabled');

            // Compute shader should NOT contain applyACES2RGC
            const computeWgsl = dctlComputeInfo.computeWgsl;
            assert.ok(!computeWgsl.includes('applyACES2RGC'),
                'Compute shader should NOT contain applyACES2RGC when RGC is disabled');

            console.log('\n✓ buildIntegratedShader WITHOUT RGC test PASSED');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });

    test('RGC-only (no DCTL) should return hasFullRgc=true', async function() {
        this.timeout(60000);

        console.log('\n--- Testing RGC-only (no DCTL) ---');

        try {
            const core = await import('@dctl-workbench/core');

            // Use pre-computed ocioBasePath
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

            if (!ocioShaderInfo?.shaderText) {
                throw new Error('Failed to extract OCIO shader info');
            }

            // Call buildIntegratedShader with NO DCTL but RGC enabled
            const dctlOptions = {
                enabled: false,  // DCTL disabled
                imageWidth: 1920,
                imageHeight: 1080,
                applyACES2GamutCompression: true,  // RGC ENABLED
                peakLuminance: 100,
            };

            console.log('Calling buildIntegratedShader with DCTL=false, RGC=true...');
            const integratedShader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                undefined,  // No DCTL info
                dctlOptions
            );

            const dctlComputeInfo = integratedShader.dctlComputeShaderInfo;
            console.log(`  dctlComputeShaderInfo exists: ${!!dctlComputeInfo}`);
            console.log(`  success: ${dctlComputeInfo?.success}`);
            console.log(`  hasDctl: ${dctlComputeInfo?.hasDctl}`);
            console.log(`  hasFullRgc: ${dctlComputeInfo?.hasFullRgc}`);

            assert.ok(integratedShader.success, 'buildIntegratedShader should succeed');

            // When RGC is enabled without DCTL, we should still get RGC
            if (dctlComputeInfo) {
                assert.strictEqual(dctlComputeInfo.hasFullRgc, true,
                    'hasFullRgc should be true even without DCTL');
                assert.ok(!dctlComputeInfo.hasDctl,
                    'hasDctl should be false when no DCTL is provided');
            }

            console.log('\n✓ RGC-only test PASSED');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });

    test('Verify compute shader dctl_sampleTexture calls applyACES2RGC', async function() {
        this.timeout(60000);

        console.log('\n--- Verifying dctl_sampleTexture calls applyACES2RGC ---');

        try {
            const core = await import('@dctl-workbench/core');

            // Use pre-computed ocioBasePath
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

            if (!ocioShaderInfo?.shaderText) {
                throw new Error('Failed to extract OCIO shader info');
            }

            if (!TEST_DCTL_PATH) {
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

            const computeWgsl = integratedShader.dctlComputeShaderInfo?.computeWgsl;
            assert.ok(computeWgsl, 'computeWgsl should exist');

            // Find dctl_sampleTexture function
            const sampleTexMatch = computeWgsl.match(/fn\s+dctl_sampleTexture[^{]*\{[\s\S]*?\n\}/);
            assert.ok(sampleTexMatch, 'dctl_sampleTexture function should exist');

            const sampleTexFunc = sampleTexMatch[0];
            console.log('dctl_sampleTexture function:');
            console.log(sampleTexFunc.substring(0, 500));

            // Verify applyACES2RGC is called within dctl_sampleTexture
            const callsRgc = sampleTexFunc.includes('applyACES2RGC');
            console.log(`\nCalls applyACES2RGC: ${callsRgc ? '✓' : '✗'}`);

            assert.ok(callsRgc,
                'dctl_sampleTexture MUST call applyACES2RGC when RGC is enabled');

            // Verify correct call pattern: applyACES2RGC(vec4<f32>(ap1, 1.0))
            const correctPattern = sampleTexFunc.includes('applyACES2RGC(vec4<f32>(');
            console.log(`Correct call pattern: ${correctPattern ? '✓' : '✗'}`);

            assert.ok(correctPattern,
                'applyACES2RGC should be called with vec4<f32>(ap1, 1.0)');

            console.log('\n✓ dctl_sampleTexture RGC call verification PASSED');

        } catch (e: any) {
            console.error('Test failed:', e.message);
            throw e;
        }
    });
});
