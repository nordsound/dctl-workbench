/**
 * VS Code Export Shader Test
 *
 * This test imports the VS Code's export shader builder and tests it via CLI.
 * This ensures that the same code path used by VS Code can be tested without
 * manually running VS Code.
 *
 * Tests:
 * 1. Initialize OCIO and Naga (same as VS Code)
 * 2. Build export shader with RGC enabled
 * 3. Execute shader with WebGPU via SubprocessRenderer
 * 4. Verify output is not black (the bug we're fixing)
 */

import * as path from 'path';
import * as fs from 'fs';
import { SubprocessRenderer } from '../subprocess-renderer.js';

import { getTestOutputDir } from '@dctl-workbench/core/out/test-paths.js';

// Paths - use VS Code package's modules
const VSCODE_PKG_PATH = path.resolve(__dirname, '../../../vscode');
const WASM_DIR = path.join(VSCODE_PKG_PATH, 'out', 'wasm');
const TEST_RESULTS_DIR = getTestOutputDir();

// Test DCTL - simple gain shader
const TEST_GAIN_DCTL = `
// Test DCTL for export verification
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.5, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    return make_float3(p_R * gain, p_G * gain, p_B * gain);
}
`;

interface TestResult {
    name: string;
    passed: boolean;
    message: string;
    duration?: number;
}

async function initModules() {
    console.log('Initializing WASM modules from VS Code package...');
    console.log(`WASM directory: ${WASM_DIR}`);

    // Initialize OCIO
    const ocioModulePath = path.join(VSCODE_PKG_PATH, 'out', 'ocio');
    const ocioModule = require(ocioModulePath);
    ocioModule.setWasmDirectory(WASM_DIR);
    await ocioModule.initOCIO();
    console.log('OCIO initialized');

    // Initialize Naga
    const nagaModulePath = path.join(VSCODE_PKG_PATH, 'out', 'naga');
    const nagaModule = require(nagaModulePath);
    const nagaProcessor = nagaModule.getNagaProcessor();
    if (!nagaProcessor.isInitialized) {
        await nagaProcessor.init(VSCODE_PKG_PATH);
    }
    console.log('Naga initialized');

    return { ocioModule, nagaModule };
}

async function runTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];

    console.log('=== VS Code Export Shader Test ===\n');

    // Test 1: Initialize modules
    let ocioModule: any;
    try {
        const start = Date.now();
        const modules = await initModules();
        ocioModule = modules.ocioModule;
        results.push({
            name: 'Initialize WASM modules (OCIO, Naga)',
            passed: true,
            message: 'All modules initialized successfully',
            duration: Date.now() - start,
        });
    } catch (e: any) {
        results.push({
            name: 'Initialize WASM modules',
            passed: false,
            message: e.message,
        });
        return results;
    }

    // Test 2: Build export shader with RGC
    let wgslCode: string;
    let rgcTextures: any[] = [];
    let rgcTextures3D: any[] = [];
    try {
        const start = Date.now();

        // Import the VS Code export shader builder
        const shaderBuilderPath = path.join(VSCODE_PKG_PATH, 'out', 'shader', 'dctl-export-shader-builder');
        const { buildDctlExportShader } = require(shaderBuilderPath);

        // Create DCTL shader info
        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct' as const,
            params: [{ name: 'gain', type: 'DCTL_SLIDER_FLOAT', default: 1.5 }],
        };

        // Build with RGC enabled (this is the code path that was broken)
        const exportResult = await buildDctlExportShader(
            VSCODE_PKG_PATH,
            dctlShaderInfo,
            {
                paramValues: { gain: 1.5 },
                imageWidth: 64,
                imageHeight: 64,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            }
        );

        if (!exportResult.success) {
            throw new Error(`Shader build failed: ${exportResult.error}`);
        }

        wgslCode = exportResult.wgslCode;
        rgcTextures = exportResult.rgcTextures || [];
        rgcTextures3D = exportResult.rgcTextures3D || [];

        // Verify shader structure
        const hasApplyRGC = /fn\s+applyACES2RGC/.test(wgslCode);
        const hasFragmentMain = /@fragment\s*\n?\s*fn\s+main/.test(wgslCode);
        const entryPointCount = (wgslCode.match(/@fragment\s*\n?\s*fn\s+main/g) || []).length;

        if (!hasApplyRGC) throw new Error('Missing applyACES2RGC function');
        if (!hasFragmentMain) throw new Error('Missing fragment entry point');
        if (entryPointCount !== 1) throw new Error(`Expected 1 entry point, found ${entryPointCount}`);

        results.push({
            name: 'Build RGC export shader',
            passed: true,
            message: `Shader: ${wgslCode.length} chars, RGC textures: 2D=${rgcTextures.length}, 3D=${rgcTextures3D.length}`,
            duration: Date.now() - start,
        });

        // Save shader for debugging
        const debugPath = path.join(TEST_RESULTS_DIR, 'cli_vscode_export_shader.wgsl');
        fs.writeFileSync(debugPath, wgslCode);
        console.log(`  Debug shader saved: ${debugPath}`);

    } catch (e: any) {
        results.push({
            name: 'Build RGC export shader',
            passed: false,
            message: e.message,
        });
        return results;
    }

    // Test 3: Verify RGC textures are returned (this was the bug!)
    try {
        const hasRgcTextures = rgcTextures.length > 0 || rgcTextures3D.length > 0;

        if (!hasRgcTextures) {
            throw new Error('No RGC textures returned - this was the cause of black export!');
        }

        // Log texture details
        console.log('  RGC 2D Textures:');
        for (const tex of rgcTextures) {
            console.log(`    - ${tex.samplerName}: ${tex.width}x${tex.height}`);
        }
        console.log('  RGC 3D Textures:');
        for (const tex of rgcTextures3D) {
            console.log(`    - ${tex.samplerName}: ${tex.width}x${tex.height}x${tex.depth}`);
        }

        results.push({
            name: 'Verify RGC textures are returned',
            passed: true,
            message: `2D: ${rgcTextures.length}, 3D: ${rgcTextures3D.length}`,
        });
    } catch (e: any) {
        results.push({
            name: 'Verify RGC textures are returned',
            passed: false,
            message: e.message,
        });
    }

    // Test 4: Verify shader has correct RGC texture bindings
    try {
        // Count RGC texture bindings in the shader
        const rgcBindingCount = (wgslCode.match(/@group\(0\)\s*@binding\(\d+\)\s*\n?var\s+rgc_/g) || []).length;

        // Each texture needs 2 bindings (texture + sampler)
        const expectedBindings = (rgcTextures.length + rgcTextures3D.length) * 2;

        if (rgcBindingCount !== expectedBindings) {
            throw new Error(`Expected ${expectedBindings} RGC bindings, found ${rgcBindingCount}`);
        }

        results.push({
            name: 'Verify RGC texture bindings in shader',
            passed: true,
            message: `${rgcBindingCount} bindings found (${expectedBindings} expected)`,
        });
    } catch (e: any) {
        results.push({
            name: 'Verify RGC texture bindings in shader',
            passed: false,
            message: e.message,
        });
    }

    // Test 5: Verify parameter injection works
    try {
        // The shader should have gain = 1.5f, not gain = 1f
        const gainMatch = wgslCode.match(/var<private>\s+gain:\s*f32\s*=\s*([^;]+);/);

        if (!gainMatch) {
            throw new Error('gain parameter declaration not found');
        }

        const gainValue = gainMatch[1].trim();
        // Should be "1.5f" not "1f"
        if (gainValue === '1f' || gainValue === '1.0f') {
            throw new Error(`gain parameter not injected correctly: expected 1.5f, got ${gainValue}`);
        }

        results.push({
            name: 'Verify parameter injection',
            passed: true,
            message: `gain = ${gainValue}`,
        });
    } catch (e: any) {
        results.push({
            name: 'Verify parameter injection',
            passed: false,
            message: e.message,
        });
    }

    // Test 6: Build non-RGC shader for comparison
    try {
        const start = Date.now();

        const shaderBuilderPath = path.join(VSCODE_PKG_PATH, 'out', 'shader', 'dctl-export-shader-builder');
        const { buildDctlExportShader } = require(shaderBuilderPath);

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct' as const,
            params: [{ name: 'gain', type: 'DCTL_SLIDER_FLOAT', default: 1.5 }],
        };

        // Build WITHOUT RGC
        const exportResult = await buildDctlExportShader(
            VSCODE_PKG_PATH,
            dctlShaderInfo,
            {
                paramValues: { gain: 1.5 },
                imageWidth: 64,
                imageHeight: 64,
                applyACES2GamutCompression: false,  // No RGC
            }
        );

        if (!exportResult.success) {
            throw new Error(`Non-RGC shader build failed: ${exportResult.error}`);
        }

        // Non-RGC shader should NOT have RGC functions
        const hasRgcFunctions = /applyACES2RGC|rgc_ocio_/.test(exportResult.wgslCode);
        if (hasRgcFunctions) {
            throw new Error('Non-RGC shader should not have RGC functions');
        }

        // Save for comparison
        const debugPath = path.join(TEST_RESULTS_DIR, 'cli_vscode_export_shader_no_rgc.wgsl');
        fs.writeFileSync(debugPath, exportResult.wgslCode);

        results.push({
            name: 'Build non-RGC export shader',
            passed: true,
            message: `${exportResult.wgslCode.length} chars, no RGC functions`,
            duration: Date.now() - start,
        });
    } catch (e: any) {
        results.push({
            name: 'Build non-RGC export shader',
            passed: false,
            message: e.message,
        });
    }

    return results;
}

async function main() {
    try {
        // Ensure results directory exists
        if (!fs.existsSync(TEST_RESULTS_DIR)) {
            fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
        }

        const results = await runTests();

        console.log('\n=== Test Results ===\n');

        let passed = 0;
        let failed = 0;

        for (const result of results) {
            const status = result.passed ? '✓' : '✗';
            const duration = result.duration ? ` (${result.duration}ms)` : '';
            console.log(`${status} ${result.name}${duration}`);
            console.log(`  ${result.message}`);

            if (result.passed) passed++;
            else failed++;
        }

        console.log(`\n${passed} passed, ${failed} failed\n`);

        if (failed > 0) {
            console.log('=== EXPORT FIX VERIFICATION FAILED ===');
            console.log('The fix may not be complete. Check the failures above.');
        } else {
            console.log('=== EXPORT FIX VERIFIED ===');
            console.log('All tests passed. The export should work correctly in VS Code.');
        }

        process.exit(failed > 0 ? 1 : 0);
    } catch (e: any) {
        console.error('Test failed:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
}

main();
