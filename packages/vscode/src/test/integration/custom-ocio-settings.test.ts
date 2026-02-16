/**
 * Custom OCIO Settings & Pipeline Integration Tests
 *
 * Verifies that the custom OCIO dual-mode pipeline works correctly:
 * - Settings are registered in package.json
 * - Settings helpers correctly parse OCIO config paths
 * - Custom OCIO compute shader differs from ACES mode
 * - RGC is not included in custom OCIO mode
 * - Buffer-based CLI shader builder produces valid output
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveFixture } from '@dctl-workbench/core/out/test-paths.js';

const TEST_DCTL_PATH = resolveFixture('test_gain.dctl') ?? '';
const TEST_OCIO_CONFIG_PATH = resolveFixture('test-ocio-config', 'config.ocio');

suite('Custom OCIO Settings', () => {
    let extension: vscode.Extension<unknown> | undefined;

    suiteSetup(function () {
        extension = vscode.extensions.all.find(ext =>
            ext.packageJSON?.name === 'dctl-workbench' ||
            ext.id.includes('dctl-workbench')
        );
        if (!extension) {
            console.log('DCTL Workbench extension not found, skipping suite');
            this.skip();
        }
    });

    test('should register ocioConfigPath setting in package.json', function () {
        if (!extension) { this.skip(); return; }

        const contributes = extension.packageJSON.contributes;
        assert.ok(contributes.configuration, 'Extension should have configuration');

        // Search all configuration sections
        const configs = Array.isArray(contributes.configuration)
            ? contributes.configuration
            : [contributes.configuration];

        let foundOcioSetting = false;
        for (const config of configs) {
            if (config.properties?.['dctlWorkbench.exr_viewer.ocioConfigPath']) {
                foundOcioSetting = true;
                const setting = config.properties['dctlWorkbench.exr_viewer.ocioConfigPath'];
                assert.strictEqual(setting.type, 'string', 'ocioConfigPath should be string type');
                assert.strictEqual(setting.default, '', 'ocioConfigPath default should be empty');
                break;
            }
        }
        assert.ok(foundOcioSetting, 'ocioConfigPath setting should be registered');
    });

    test('should register defaultWorkingColorSpace setting', function () {
        if (!extension) { this.skip(); return; }

        const contributes = extension.packageJSON.contributes;
        const configs = Array.isArray(contributes.configuration)
            ? contributes.configuration
            : [contributes.configuration];

        let foundWorkingCS = false;
        for (const config of configs) {
            if (config.properties?.['dctlWorkbench.exr_viewer.defaultWorkingColorSpace']) {
                foundWorkingCS = true;
                const setting = config.properties['dctlWorkbench.exr_viewer.defaultWorkingColorSpace'];
                assert.strictEqual(setting.default, 'ACEScct', 'Default working CS should be ACEScct');
                assert.ok(Array.isArray(setting.enum), 'Working CS should have enum values');
                assert.ok(setting.enum.includes('ACEScct'), 'Enum should include ACEScct');
                assert.ok(setting.enum.includes('ACEScg'), 'Enum should include ACEScg');
                assert.ok(setting.enum.includes('linear_sRGB'), 'Enum should include linear_sRGB');
                break;
            }
        }
        assert.ok(foundWorkingCS, 'defaultWorkingColorSpace setting should be registered');
    });

    test('should register defaultExportCompression setting', function () {
        if (!extension) { this.skip(); return; }

        const contributes = extension.packageJSON.contributes;
        const configs = Array.isArray(contributes.configuration)
            ? contributes.configuration
            : [contributes.configuration];

        let foundCompression = false;
        for (const config of configs) {
            if (config.properties?.['dctlWorkbench.exr_viewer.defaultExportCompression']) {
                foundCompression = true;
                const setting = config.properties['dctlWorkbench.exr_viewer.defaultExportCompression'];
                assert.strictEqual(setting.default, 'PIZ', 'Default compression should be PIZ');
                assert.ok(setting.enum.length === 10, 'Should have 10 compression options');
                break;
            }
        }
        assert.ok(foundCompression, 'defaultExportCompression setting should be registered');
    });
});

suite('Custom OCIO Pipeline Integration', () => {
    let extensionPath: string;
    let ocioBasePath: string;

    suiteSetup(async function () {
        this.timeout(30000);

        let extension = vscode.extensions.all.find(ext =>
            ext.packageJSON?.name === 'dctl-workbench' ||
            ext.id.includes('dctl-workbench')
        );

        if (extension) {
            extensionPath = extension.extensionPath;
            ocioBasePath = path.join(extensionPath, 'out');
        } else {
            extensionPath = path.resolve(__dirname, '../../..');
            ocioBasePath = extensionPath;
        }
    });

    test('custom OCIO compute shader should use OCIO transforms instead of ACES matrices', async function () {
        this.timeout(120000);

        if (!TEST_OCIO_CONFIG_PATH) {
            console.log('Test OCIO config not found, skipping');
            this.skip();
            return;
        }

        const core = await import('@dctl-workbench/core');

        // Initialize OCIO
        if (!core.isOCIOInitialized()) {
            await core.initOCIO(ocioBasePath);
        }

        // Extract custom OCIO shaders
        const extracted = core.extractCustomOcioShaders(TEST_OCIO_CONFIG_PATH, {
            sourceColorSpace: 'reference',
            workingColorSpace: 'linear_working',
            display: 'sRGB',
            view: 'Film',
        });

        assert.ok(extracted.success, `Extraction failed: ${extracted.error}`);

        // Build compute shader (texture-based, as used by VS Code extension)
        const result = await core.buildCustomOcioComputeShader(
            ocioBasePath,
            extracted,
        );

        assert.ok(result.success, `Build failed: ${result.error}`);
        assert.ok(result.computeWgsl.length > 0, 'Compute WGSL should not be empty');

        // Should contain OCIO sw_/wd_ transform functions
        assert.ok(result.computeWgsl.includes('sw_'),
            'Should contain sw_ (source→working) OCIO transform');
        assert.ok(result.computeWgsl.includes('wd_'),
            'Should contain wd_ (working→display) OCIO transform');

        // Should NOT contain hardcoded ACES matrices
        assert.ok(!result.computeWgsl.includes('1.4514393161'),
            'Should NOT contain hardcoded AP0→AP1 matrix values');
        assert.ok(!result.computeWgsl.includes('0.6954522414'),
            'Should NOT contain hardcoded AP1→AP0 matrix values');

        // Should NOT contain ACEScct log encoding (custom config, not ACES)
        assert.ok(!result.computeWgsl.includes('lin_to_ACEScct'),
            'Should NOT contain hardcoded ACEScct transfer functions');

        console.log(`Custom OCIO compute shader: ${result.computeWgsl.length} chars, ` +
            `${result.textures.length} 2D textures, ${result.textures3D.length} 3D textures`);
    });

    test('custom OCIO shader should NOT include RGC', async function () {
        this.timeout(120000);

        if (!TEST_OCIO_CONFIG_PATH) {
            this.skip();
            return;
        }

        const core = await import('@dctl-workbench/core');

        if (!core.isOCIOInitialized()) {
            await core.initOCIO(ocioBasePath);
        }

        const extracted = core.extractCustomOcioShaders(TEST_OCIO_CONFIG_PATH, {
            sourceColorSpace: 'reference',
            workingColorSpace: 'linear_working',
            display: 'sRGB',
            view: 'Film',
        });

        assert.ok(extracted.success, `Extraction failed: ${extracted.error}`);

        const result = await core.buildCustomOcioComputeShader(
            ocioBasePath,
            extracted,
        );

        assert.ok(result.success, `Build failed: ${result.error}`);

        // RGC is NOT applicable in custom OCIO mode
        assert.ok(!result.computeWgsl.includes('applyACES2RGC'),
            'Custom OCIO shader should NOT contain RGC function');
        assert.ok(!result.computeWgsl.includes('gamut_compress'),
            'Custom OCIO shader should NOT contain gamut compression');
    });

    test('custom OCIO with DCTL should integrate correctly', async function () {
        this.timeout(120000);

        if (!TEST_OCIO_CONFIG_PATH || !TEST_DCTL_PATH) {
            this.skip();
            return;
        }

        const core = await import('@dctl-workbench/core');

        if (!core.isOCIOInitialized()) {
            await core.initOCIO(ocioBasePath);
        }

        // Read DCTL
        const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
        const uiParams = core.extractUIParams(dctlSource);

        // Extract custom OCIO shaders
        const extracted = core.extractCustomOcioShaders(TEST_OCIO_CONFIG_PATH, {
            sourceColorSpace: 'reference',
            workingColorSpace: 'linear_working',
            display: 'sRGB',
            view: 'Film',
        });

        assert.ok(extracted.success, `Extraction failed: ${extracted.error}`);

        // Build compute shader WITH DCTL
        const result = await core.buildCustomOcioComputeShader(
            ocioBasePath,
            extracted,
            {
                dctlSource,
                params: uiParams.params,
                useUniformBuffer: true,
            },
        );

        assert.ok(result.success, `Build failed: ${result.error}`);
        assert.ok(result.hasDctl, 'Should indicate DCTL is included');

        // Should contain dctl_sampleTexture that uses sw_ transform
        assert.ok(result.computeWgsl.includes('fn dctl_sampleTexture'),
            'Should contain dctl_sampleTexture function');

        // dctl_sampleTexture should use sw_ (source→working) transform, not ACES matrix
        const sampleTexMatch = result.computeWgsl.match(
            /fn dctl_sampleTexture\([^)]*\)\s*->\s*vec4<f32>\s*\{([\s\S]*?)\n\}/
        );
        assert.ok(sampleTexMatch, 'dctl_sampleTexture function should be parseable');
        const sampleTexBody = sampleTexMatch![1];
        assert.ok(sampleTexBody.includes('sw_'),
            'dctl_sampleTexture should call sw_ OCIO transform');

        // Should have DCTL parameter mapping
        assert.ok(result.paramMapping.length > 0,
            'Should have DCTL parameter mapping');

        console.log(`Custom OCIO + DCTL: ${result.computeWgsl.length} chars, ` +
            `${result.paramMapping.length} params, hasDctl=${result.hasDctl}`);
    });

    test('custom OCIO shader should differ from ACES mode shader', async function () {
        this.timeout(180000);

        if (!TEST_OCIO_CONFIG_PATH || !TEST_DCTL_PATH) {
            this.skip();
            return;
        }

        const core = await import('@dctl-workbench/core');

        if (!core.isOCIOInitialized()) {
            await core.initOCIO(ocioBasePath);
        }

        // === Build ACES mode shader ===
        const processor = new core.OCIOProcessor();
        processor.init();
        const displays = processor.getDisplays();
        const defaultDisplay = displays.includes('sRGB') ? 'sRGB' : displays[0];
        const views = processor.getViews(defaultDisplay);
        processor.createDisplayTransform('ACES2065-1', defaultDisplay, views[0]);
        processor.setupGpuProcessor();
        const ocioShaderInfo = processor.extractGpuShaderInfo();
        processor.dispose();

        const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');
        const uiParams = core.extractUIParams(dctlSource);

        const dctlInfo = core.createDctlInfo(
            dctlSource,
            'ACEScct',
            uiParams.params,
            TEST_DCTL_PATH
        );

        const acesShader = await core.buildIntegratedShader(
            extensionPath,
            ocioShaderInfo,
            dctlInfo,
            {
                enabled: true,
                imageWidth: 1920,
                imageHeight: 1080,
                useUniformBuffer: true,
                useRustCompiler: true,
                dctlSource,
            }
        );

        assert.ok(acesShader.success, 'ACES shader build should succeed');
        const acesWgsl = acesShader.dctlComputeShaderInfo?.computeWgsl || '';
        assert.ok(acesWgsl.length > 0, 'ACES compute shader should not be empty');

        // === Build custom OCIO shader ===
        const extracted = core.extractCustomOcioShaders(TEST_OCIO_CONFIG_PATH, {
            sourceColorSpace: 'reference',
            workingColorSpace: 'linear_working',
            display: 'sRGB',
            view: 'Film',
        });

        assert.ok(extracted.success, `Custom OCIO extraction failed: ${extracted.error}`);

        const customOcioShader = await core.buildCustomOcioComputeShader(
            ocioBasePath,
            extracted,
            {
                dctlSource,
                params: uiParams.params,
                useUniformBuffer: true,
            },
        );

        assert.ok(customOcioShader.success, `Custom OCIO build failed: ${customOcioShader.error}`);
        const customWgsl = customOcioShader.computeWgsl;
        assert.ok(customWgsl.length > 0, 'Custom OCIO compute shader should not be empty');

        // The two shaders MUST be different
        assert.notStrictEqual(
            acesWgsl,
            customWgsl,
            'Custom OCIO shader and ACES shader MUST be different'
        );

        // ACES shader should contain hardcoded matrices; custom OCIO should not
        const acesHasMatrix = acesWgsl.includes('ap0_to_ap1') || acesWgsl.includes('ap0ToWorking');
        const customHasMatrix = customWgsl.includes('ap0_to_ap1') || customWgsl.includes('ap0ToWorking');
        assert.ok(acesHasMatrix, 'ACES shader should contain AP0↔AP1 matrix references');
        assert.ok(!customHasMatrix, 'Custom OCIO shader should NOT contain AP0↔AP1 matrix references');

        console.log(`ACES shader: ${acesWgsl.length} chars`);
        console.log(`Custom OCIO shader: ${customWgsl.length} chars`);
    });

    test('buffer-based custom OCIO shader (CLI) should use storage buffers', async function () {
        this.timeout(120000);

        if (!TEST_OCIO_CONFIG_PATH || !TEST_DCTL_PATH) {
            this.skip();
            return;
        }

        const core = await import('@dctl-workbench/core');

        if (!core.isOCIOInitialized()) {
            await core.initOCIO(ocioBasePath);
        }

        const dctlSource = fs.readFileSync(TEST_DCTL_PATH, 'utf-8');

        // Compile DCTL
        const compiler = core.getDctlCompiler();
        if (!compiler.isInitialized) {
            await compiler.init(ocioBasePath);
        }
        const compileResult = compiler.compile(dctlSource);
        assert.ok(!core.isCompileError(compileResult), 'DCTL compilation should succeed');

        // Extract export shaders (source→working + working→source)
        const extracted = core.extractCustomOcioExportShaders(TEST_OCIO_CONFIG_PATH, {
            sourceColorSpace: 'reference',
            workingColorSpace: 'linear_working',
        });

        assert.ok(extracted.success, `Export shader extraction failed: ${extracted.error}`);

        // Build buffer-based compute shader
        const result = await core.buildCustomOcioBufferComputeShader(
            ocioBasePath,
            extracted,
            compileResult as any,
            { width: 1920, height: 1080 },
        );

        assert.ok(result.success, `Buffer shader build failed: ${result.error}`);

        // Should use storage buffers (CLI style), not textures
        assert.ok(result.computeWgsl.includes('var<storage, read> input_buffer'),
            'Should use storage buffer for input');
        assert.ok(result.computeWgsl.includes('var<storage, read_write> output_buffer'),
            'Should use storage buffer for output');

        // Should NOT use texture I/O (VS Code style)
        assert.ok(!result.computeWgsl.includes('source_texture'),
            'Should NOT use texture for input');
        assert.ok(!result.computeWgsl.includes('output_texture'),
            'Should NOT use texture for output');

        // Should contain ws_ (working→source) for export, not wd_ (working→display)
        assert.ok(result.computeWgsl.includes('ws_'),
            'Should contain ws_ (working→source) transform');

        console.log(`Buffer-based custom OCIO shader: ${result.computeWgsl.length} chars, ` +
            `${result.textures.length} 2D textures, ${result.textures3D.length} 3D textures`);
    });

    test('settings helpers should correctly determine pipeline mode', async function () {
        this.timeout(10000);

        // Dynamic import to test the settings helpers
        const helpers = await import('../../editor/settings-helpers.js');

        // Empty path → ACES mode
        assert.strictEqual(helpers.parseOcioConfigPath(''), null);
        assert.strictEqual(helpers.determinePipelineMode(null), 'aces');

        // Non-existent path → null → ACES mode
        assert.strictEqual(helpers.parseOcioConfigPath('/nonexistent/config.ocio'), null);
        assert.strictEqual(helpers.determinePipelineMode(null), 'aces');

        // Valid path → custom-ocio mode
        if (TEST_OCIO_CONFIG_PATH) {
            const parsed = helpers.parseOcioConfigPath(TEST_OCIO_CONFIG_PATH);
            assert.ok(parsed !== null, 'Should resolve existing OCIO config path');
            assert.strictEqual(helpers.determinePipelineMode(parsed), 'custom-ocio');
        }

        // Compression parsing
        assert.strictEqual(helpers.parseCompressionSetting('PIZ'), 4);
        assert.strictEqual(helpers.parseCompressionSetting('INVALID'), 4); // Falls back to PIZ

        // Working color space parsing
        assert.strictEqual(helpers.parseWorkingColorSpace('ACEScct'), 'ACEScct');
        assert.strictEqual(helpers.parseWorkingColorSpace('invalid'), 'ACEScct'); // Falls back
    });
});
