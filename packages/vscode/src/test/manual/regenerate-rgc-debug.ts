/**
 * Manual test script to regenerate RGC export shader debug files
 *
 * This script actually calls buildDctlExportShader to generate new debug files
 * so we can verify the RGC fix is working.
 *
 * Run with: npx ts-node --project tsconfig.test.json src/test/manual/regenerate-rgc-debug.ts
 */

import * as path from 'path';
import * as fs from 'fs';

// Simple test DCTL source
const TEST_DCTL_SOURCE = `
// Simple gain DCTL for testing
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    return make_float3(r * gain, g * gain, b * gain);
}
`;

async function main() {
    // Get extension path (packages/vscode)
    const extensionPath = path.resolve(__dirname, '../../..');
    console.log('Extension path:', extensionPath);

    // Check if built
    const outDir = path.join(extensionPath, 'out');
    if (!fs.existsSync(outDir)) {
        console.error('Extension not built. Run "npm run build" first.');
        process.exit(1);
    }

    // Import the shader builder from built module
    const shaderBuilderPath = path.join(outDir, 'shader', 'dctl-export-shader-builder.js');
    if (!fs.existsSync(shaderBuilderPath)) {
        console.error('Shader builder module not found:', shaderBuilderPath);
        process.exit(1);
    }

    console.log('Loading shader builder module...');
    const { buildDctlExportShader } = require(shaderBuilderPath);

    // Create DctlShaderInfo
    const dctlShaderInfo = {
        source: TEST_DCTL_SOURCE,
        workingColorSpace: 'ACEScct' as const,
        params: [{ name: 'gain', type: 'float', default: 1.0 }],
    };

    // Test 1: Build without RGC
    console.log('\n=== Building Non-RGC Export Shader ===');
    const nonRgcResult = await buildDctlExportShader(extensionPath, dctlShaderInfo, {
        paramValues: { gain: 1.1 },
        imageWidth: 1920,
        imageHeight: 1080,
        applyACES2GamutCompression: false,
    });

    if (nonRgcResult.success) {
        console.log('Non-RGC build successful!');
        console.log(`WGSL size: ${nonRgcResult.wgslCode.length} chars`);

        // Check for key components
        const hasTransform = /fn\s+transform/.test(nonRgcResult.wgslCode);
        const hasGain = /gain:\s*f32\s*=\s*1\.1f/.test(nonRgcResult.wgslCode);
        const hasEntryPoint = /@fragment\s*\n?\s*fn\s+main/.test(nonRgcResult.wgslCode);

        console.log(`Has transform: ${hasTransform ? '✓' : '✗'}`);
        console.log(`Has gain=1.1f: ${hasGain ? '✓' : '✗'}`);
        console.log(`Has entry point: ${hasEntryPoint ? '✓' : '✗'}`);
    } else {
        console.error('Non-RGC build failed:', nonRgcResult.error);
    }

    // Test 2: Build with RGC
    console.log('\n=== Building RGC Export Shader ===');
    const rgcResult = await buildDctlExportShader(extensionPath, dctlShaderInfo, {
        paramValues: { gain: 1.15 },
        imageWidth: 1920,
        imageHeight: 1080,
        applyACES2GamutCompression: true,
        peakLuminance: 100,
    });

    if (rgcResult.success) {
        console.log('RGC build successful!');
        console.log(`WGSL size: ${rgcResult.wgslCode.length} chars`);
        console.log(`RGC 2D textures: ${rgcResult.rgcTextures?.length || 0}`);
        console.log(`RGC 3D textures: ${rgcResult.rgcTextures3D?.length || 0}`);

        // Check for key RGC components
        const hasApplyRGC = /fn\s+applyACES2RGC/.test(rgcResult.wgslCode);
        const hasRgcHelpers = /rgc_ocio_/.test(rgcResult.wgslCode);
        const hasTransform = /fn\s+transform/.test(rgcResult.wgslCode);
        const hasGain = /gain:\s*f32\s*=\s*1\.15f/.test(rgcResult.wgslCode);
        const hasEntryPoint = /@fragment\s*\n?\s*fn\s+main/.test(rgcResult.wgslCode);

        console.log(`Has applyACES2RGC: ${hasApplyRGC ? '✓' : '✗'}`);
        console.log(`Has RGC helpers: ${hasRgcHelpers ? '✓' : '✗'}`);
        console.log(`Has transform: ${hasTransform ? '✓' : '✗'}`);
        console.log(`Has gain=1.15f: ${hasGain ? '✓' : '✗'}`);
        console.log(`Has entry point: ${hasEntryPoint ? '✓' : '✗'}`);

        // Check for CRITICAL: dctl_sampleTexture calls applyACES2RGC
        const sampleTextureMatch = rgcResult.wgslCode.match(
            /fn dctl_sampleTexture[\s\S]*?(?=\nfn\s|\n\/\/\s*Fragment|\Z)/
        );
        if (sampleTextureMatch) {
            const sampleFn = sampleTextureMatch[0];
            const callsRGC = /applyACES2RGC/.test(sampleFn);
            console.log(`dctl_sampleTexture calls applyACES2RGC: ${callsRGC ? '✓' : '✗ CRITICAL BUG!'}`);

            if (!callsRGC) {
                console.log('\n=== CRITICAL: RGC not applied in dctl_sampleTexture ===');
                console.log('dctl_sampleTexture function:');
                console.log(sampleFn.substring(0, 600));
            }
        }

        // Check for duplicate entry points
        const fragmentMainMatches = rgcResult.wgslCode.match(/@fragment\s*\n?\s*fn\s+main/g);
        const fragmentCount = fragmentMainMatches ? fragmentMainMatches.length : 0;
        console.log(`@fragment fn main count: ${fragmentCount} ${fragmentCount === 1 ? '✓' : '✗ CRITICAL BUG!'}`);

        if (fragmentCount > 1) {
            console.log('\n=== CRITICAL: Duplicate entry points ===');
            let searchIdx = 0;
            while (true) {
                const idx = rgcResult.wgslCode.indexOf('@fragment', searchIdx);
                if (idx === -1) break;
                const lineNum = rgcResult.wgslCode.substring(0, idx).split('\n').length;
                console.log(`  Found at line ${lineNum}`);
                searchIdx = idx + 10;
            }
        }
    } else {
        console.error('RGC build failed:', rgcResult.error);
        console.log('This may be expected if OCIO is not initialized.');
    }

    console.log('\n=== Test Complete ===');
    console.log('Debug files should have been written to:');
    console.log('  - images/test_patterns/test_results/export_shader_debug.wgsl');
    console.log('  - images/test_patterns/test_results/export_shader_rgc_debug.wgsl');
}

main().catch(console.error);
