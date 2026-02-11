/**
 * Working Color Space Change Tests
 *
 * Verifies that changing the working color space in the EXR Viewer
 * produces a different shader output (i.e., re-render actually reflects
 * the new color space).
 *
 * Bug: Changing working color space in the EXR viewer dropdown does not
 * cause re-rendering with the new color space.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveFixture } from '@dctl-workbench/core/out/test-paths.js';

const TEST_DCTL_PATH = resolveFixture('test_gain.dctl') ?? '';

suite('Working Color Space Change Tests', () => {
    let extensionPath: string;
    let ocioBasePath: string;

    suiteSetup(async function () {
        this.timeout(30000);

        let extension = vscode.extensions.getExtension('anthropic.dctl-workbench');
        if (!extension) {
            extension = vscode.extensions.getExtension('your-publisher-id.dctl-workbench');
        }
        if (!extension) {
            extension = vscode.extensions.all.find(ext =>
                ext.packageJSON?.name === 'dctl-workbench' ||
                ext.id.includes('dctl-workbench')
            );
        }

        if (extension) {
            extensionPath = extension.extensionPath;
            ocioBasePath = path.join(extensionPath, 'out');
        } else {
            extensionPath = path.resolve(__dirname, '../../..');
            ocioBasePath = extensionPath;
        }
    });

    test('buildIntegratedShader produces different shaders for different working color spaces', async function () {
        this.timeout(120000);

        const core = await import('@dctl-workbench/core');

        // Initialize OCIO
        await core.initOCIO(ocioBasePath);

        // Create OCIO processor
        const processor = new core.OCIOProcessor();
        processor.init();
        const displays = processor.getDisplays();
        const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
        const views = processor.getViews(defaultDisplay);
        processor.createDisplayTransform('ACES2065-1', defaultDisplay, views[0]);
        processor.setupGpuProcessor();
        const ocioShaderInfo = processor.extractGpuShaderInfo();
        processor.dispose();

        if (!TEST_DCTL_PATH) {
            this.skip();
            return;
        }
        const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
        const uiParams = core.extractUIParams(dctlSource);

        // Build shader with ACEScct working color space
        const dctlInfoCct = core.createDctlInfo(
            dctlSource,
            'ACEScct',
            uiParams.params,
            TEST_DCTL_PATH
        );

        const optionsCct = {
            enabled: true,
            imageWidth: 1920,
            imageHeight: 1080,
            useUniformBuffer: true,
            useRustCompiler: true,
            dctlSource,
        };

        const shaderCct = await core.buildIntegratedShader(
            extensionPath,
            ocioShaderInfo,
            dctlInfoCct,
            optionsCct
        );

        assert.ok(shaderCct.success, 'ACEScct shader build should succeed');

        // Build shader with ACEScg working color space
        const dctlInfoCg = core.createDctlInfo(
            dctlSource,
            'ACEScg',
            uiParams.params,
            TEST_DCTL_PATH
        );

        const optionsCg = {
            enabled: true,
            imageWidth: 1920,
            imageHeight: 1080,
            useUniformBuffer: true,
            useRustCompiler: true,
            dctlSource,
        };

        const shaderCg = await core.buildIntegratedShader(
            extensionPath,
            ocioShaderInfo,
            dctlInfoCg,
            optionsCg
        );

        assert.ok(shaderCg.success, 'ACEScg shader build should succeed');

        // The compute shaders MUST be different for different working color spaces
        const computeCct = shaderCct.dctlComputeShaderInfo?.computeWgsl || '';
        const computeCg = shaderCg.dctlComputeShaderInfo?.computeWgsl || '';

        assert.ok(computeCct.length > 0, 'ACEScct compute shader should not be empty');
        assert.ok(computeCg.length > 0, 'ACEScg compute shader should not be empty');

        // Key assertion: shaders for different color spaces must differ
        assert.notStrictEqual(
            computeCct,
            computeCg,
            'Compute shaders for ACEScct and ACEScg MUST be different. ' +
            'If they are identical, the working color space change is not reflected in the shader.'
        );

        // Verify ACEScct shader contains ACEScct-specific code (log encoding)
        const hasCctEncoding = computeCct.includes('ACEScct') ||
            computeCct.includes('acescct') ||
            computeCct.includes('lin_to_ACEScct') ||
            computeCct.includes('linToLog');
        console.log(`ACEScct shader contains log encoding references: ${hasCctEncoding}`);

        // Verify ACEScg shader does NOT contain ACEScct log encoding
        const cgHasCctEncoding = computeCg.includes('lin_to_ACEScct') ||
            computeCg.includes('linToLog');
        console.log(`ACEScg shader contains ACEScct log encoding: ${cgHasCctEncoding}`);
        // ACEScg is linear, so it should not have log encoding
        assert.ok(
            !cgHasCctEncoding,
            'ACEScg shader should NOT contain ACEScct log encoding functions'
        );
    });

    test('ACES2065-1 and linear_sRGB with RGC produce valid shaders', async function () {
        this.timeout(180000);

        const core = await import('@dctl-workbench/core');

        await core.initOCIO(ocioBasePath);

        const processor = new core.OCIOProcessor();
        processor.init();
        const displays = processor.getDisplays();
        const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
        const views = processor.getViews(defaultDisplay);
        processor.createDisplayTransform('ACES2065-1', defaultDisplay, views[0]);
        processor.setupGpuProcessor();
        const ocioShaderInfo = processor.extractGpuShaderInfo();
        processor.dispose();

        if (!TEST_DCTL_PATH) {
            this.skip();
            return;
        }
        const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
        const uiParams = core.extractUIParams(dctlSource);

        // Test both non-AP1 color spaces that caused black images
        const nonAp1ColorSpaces = ['ACES2065-1', 'linear_sRGB'] as const;

        for (const cs of nonAp1ColorSpaces) {
            const dctlInfo = core.createDctlInfo(
                dctlSource,
                cs,
                uiParams.params,
                TEST_DCTL_PATH
            );

            // Build with RGC enabled (same as user toggling RGC in the viewer)
            const options = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            };

            const shader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                options
            );

            assert.ok(shader.success, `Shader build for ${cs} with RGC should succeed`);
            const computeWgsl = shader.dctlComputeShaderInfo?.computeWgsl || '';
            assert.ok(computeWgsl.length > 0, `Compute shader for ${cs} with RGC should not be empty`);

            // Extract dctl_sampleTexture function body
            const sampleTexMatch = computeWgsl.match(
                /fn dctl_sampleTexture\([^)]*\)\s*->\s*vec4<f32>\s*\{([\s\S]*?)\n\}/
            );
            assert.ok(sampleTexMatch, `dctl_sampleTexture function should exist for ${cs}`);
            const sampleTexBody = sampleTexMatch![1];

            // Check: if the function uses 'ap1' variable, it MUST be declared with 'var ap1'
            // For non-AP1 color spaces (ACES2065-1, linear_sRGB), the RGC replacement
            // injects 'ap1 = applyACES2RGC(...)' but ap1 is not declared
            const usesAp1 = /\bap1\b/.test(sampleTexBody);
            if (usesAp1) {
                const declaresAp1 = /\bvar\s+ap1\b/.test(sampleTexBody) ||
                    /\blet\s+ap1\b/.test(sampleTexBody);
                assert.ok(
                    declaresAp1,
                    `${cs} dctl_sampleTexture uses 'ap1' variable but never declares it. ` +
                    `This causes a WGSL compilation error and black image. ` +
                    `Body:\n${sampleTexBody}`
                );
            }

            // The RGC function (applyACES2RGC) should be present in the shader
            // when RGC is enabled
            if (shader.dctlComputeShaderInfo?.hasFullRgc) {
                assert.ok(
                    computeWgsl.includes('fn applyACES2RGC'),
                    `RGC function should be present in ${cs} shader`
                );

                // For non-AP1 spaces, RGC operates on AP1. The shader must convert
                // to AP1 before applying RGC, then back to working space.
                // Check that RGC is properly integrated (not just injecting ap1 blindly)
                const hasProperRgcIntegration =
                    sampleTexBody.includes('applyACES2RGC') &&
                    !sampleTexBody.includes('ap1 = applyACES2RGC') || // Should NOT use undeclared ap1
                    (sampleTexBody.includes('var ap1') && sampleTexBody.includes('ap1 = applyACES2RGC'));
                assert.ok(
                    hasProperRgcIntegration,
                    `${cs} shader should properly integrate RGC ` +
                    `(convert to AP1 before RGC, not blindly reference ap1)`
                );
            }

            console.log(`${cs} with RGC: shader valid, compute length=${computeWgsl.length}`);
        }
    });

    test('RGC peak luminance setting produces different shaders for different values', async function () {
        this.timeout(180000);

        const core = await import('@dctl-workbench/core');

        await core.initOCIO(ocioBasePath);

        const processor = new core.OCIOProcessor();
        processor.init();
        const displays = processor.getDisplays();
        const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
        const views = processor.getViews(defaultDisplay);
        processor.createDisplayTransform('ACES2065-1', defaultDisplay, views[0]);
        processor.setupGpuProcessor();
        const ocioShaderInfo = processor.extractGpuShaderInfo();
        processor.dispose();

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

        // Test all UI-exposed peak luminance presets
        const peakValues = [100, 500, 1000, 2000, 4000];
        const results = new Map<number, any>();

        for (const peak of peakValues) {
            const options = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource,
                applyACES2GamutCompression: true,
                peakLuminance: peak,
            };

            const shader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                options
            );

            assert.ok(shader.success, `Shader build with peak=${peak} should succeed`);
            const compute = shader.dctlComputeShaderInfo;
            assert.ok(compute, `Compute shader info should exist for peak=${peak}`);
            assert.ok(compute!.hasFullRgc, `hasFullRgc should be true for peak=${peak}`);
            assert.ok(compute!.computeWgsl!.includes('fn applyACES2RGC'),
                `applyACES2RGC function should be present for peak=${peak}`);

            // Verify RGC textures are present
            const hasRgcTextures = (compute!.rgcTextures && compute!.rgcTextures.length > 0) ||
                (compute!.rgcTextures3D && compute!.rgcTextures3D.length > 0);
            assert.ok(hasRgcTextures, `RGC textures should be present for peak=${peak}`);

            // Verify RGC bindings are present
            assert.ok(compute!.rgcBindings && compute!.rgcBindings.length > 0,
                `RGC bindings should be present for peak=${peak}`);

            results.set(peak, {
                computeWgsl: compute!.computeWgsl,
                rgcTextures: compute!.rgcTextures,
                rgcTextures3D: compute!.rgcTextures3D,
                rgcFunctionWgsl: compute!.rgcFunctionWgsl,
            });

            console.log(`peak=${peak}: compute=${compute!.computeWgsl!.length}, ` +
                `rgcWgsl=${compute!.rgcFunctionWgsl?.length ?? 0}, ` +
                `rgc2D=${compute!.rgcTextures?.length ?? 0}, ` +
                `rgc3D=${compute!.rgcTextures3D?.length ?? 0}`);
        }

        // Different peak luminance values MUST produce different shaders.
        // OCIO embeds peak-dependent constants as inline arrays or LUT textures.
        // We verify via multiple signals: WGSL code, 2D textures, 3D textures.

        // Compare all pairs of peak values
        for (let i = 0; i < peakValues.length; i++) {
            for (let j = i + 1; j < peakValues.length; j++) {
                const peakA = peakValues[i];
                const peakB = peakValues[j];
                const a = results.get(peakA)!;
                const b = results.get(peakB)!;

                let foundDifference = false;

                // 1. Compare RGC WGSL function code (contains inline constants)
                if (a.rgcFunctionWgsl && b.rgcFunctionWgsl) {
                    if (a.rgcFunctionWgsl !== b.rgcFunctionWgsl) {
                        foundDifference = true;
                    }
                }

                // 2. Compare complete compute shader WGSL
                if (!foundDifference && a.computeWgsl !== b.computeWgsl) {
                    foundDifference = true;
                }

                // 3. Compare 2D LUT texture data
                if (!foundDifference && a.rgcTextures?.length > 0 && b.rgcTextures?.length > 0) {
                    for (let t = 0; t < Math.min(a.rgcTextures.length, b.rgcTextures.length); t++) {
                        const dataA = a.rgcTextures[t].data;
                        const dataB = b.rgcTextures[t].data;
                        if (dataA.length !== dataB.length) {
                            foundDifference = true;
                            break;
                        }
                        for (let k = 0; k < dataA.length; k++) {
                            if (dataA[k] !== dataB[k]) {
                                foundDifference = true;
                                break;
                            }
                        }
                        if (foundDifference) break;
                    }
                }

                // 4. Compare 3D LUT texture data
                if (!foundDifference && a.rgcTextures3D?.length > 0 && b.rgcTextures3D?.length > 0) {
                    for (let t = 0; t < Math.min(a.rgcTextures3D.length, b.rgcTextures3D.length); t++) {
                        const dataA = a.rgcTextures3D[t].data;
                        const dataB = b.rgcTextures3D[t].data;
                        if (dataA.length !== dataB.length) {
                            foundDifference = true;
                            break;
                        }
                        for (let k = 0; k < dataA.length; k++) {
                            if (dataA[k] !== dataB[k]) {
                                foundDifference = true;
                                break;
                            }
                        }
                        if (foundDifference) break;
                    }
                }

                assert.ok(
                    foundDifference,
                    `RGC shaders for peak=${peakA} and peak=${peakB} must differ. ` +
                    `If identical, peak luminance setting is not being applied to the RGC pipeline.`
                );
            }
        }

        console.log('All peak luminance pairs produce different RGC shaders (correct)');
    });

    test('all supported working color spaces produce valid shaders', async function () {
        this.timeout(180000);

        const core = await import('@dctl-workbench/core');

        await core.initOCIO(ocioBasePath);

        const processor = new core.OCIOProcessor();
        processor.init();
        const displays = processor.getDisplays();
        const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
        const views = processor.getViews(defaultDisplay);
        processor.createDisplayTransform('ACES2065-1', defaultDisplay, views[0]);
        processor.setupGpuProcessor();
        const ocioShaderInfo = processor.extractGpuShaderInfo();
        processor.dispose();

        if (!TEST_DCTL_PATH) {
            this.skip();
            return;
        }
        const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
        const uiParams = core.extractUIParams(dctlSource);

        const colorSpaces = ['ACEScct', 'ACEScg', 'ACEScc', 'ACES2065-1'] as const;
        const shaders = new Map<string, string>();

        for (const cs of colorSpaces) {
            const dctlInfo = core.createDctlInfo(
                dctlSource,
                cs,
                uiParams.params,
                TEST_DCTL_PATH
            );

            const options = {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource,
            };

            const shader = await core.buildIntegratedShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                options
            );

            assert.ok(shader.success, `Shader build for ${cs} should succeed`);
            assert.ok(
                shader.dctlComputeShaderInfo?.computeWgsl,
                `Compute shader for ${cs} should exist`
            );

            shaders.set(cs, shader.dctlComputeShaderInfo!.computeWgsl!);
            console.log(`${cs}: compute shader length = ${shader.dctlComputeShaderInfo!.computeWgsl!.length}`);
        }

        // Each color space should produce a unique shader
        for (let i = 0; i < colorSpaces.length; i++) {
            for (let j = i + 1; j < colorSpaces.length; j++) {
                const cs1 = colorSpaces[i];
                const cs2 = colorSpaces[j];
                assert.notStrictEqual(
                    shaders.get(cs1),
                    shaders.get(cs2),
                    `Shaders for ${cs1} and ${cs2} must be different`
                );
            }
        }
    });
});
