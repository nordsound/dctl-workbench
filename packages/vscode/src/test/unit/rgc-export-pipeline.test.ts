/**
 * RGC Export Pipeline Test
 *
 * Verifies that buildDctlExportShader produces WGSL with ACES 2.0 RGC
 * when applyACES2GamutCompression is enabled.
 *
 * This test actually initializes OCIO/Naga WASM and runs the real export
 * pipeline to verify RGC code is generated end-to-end.
 *
 * Bug: User reported that EXR export with RGC enabled produces output
 * without RGC applied.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

// Monorepo root - handle both cwd=packages/vscode and cwd=monorepo root
const cwd = process.cwd();
const PROJECT_ROOT = fs.existsSync(path.join(cwd, 'wasm', 'ocio.wasm'))
    ? cwd  // cwd is monorepo root
    : path.resolve(cwd, '../..');  // cwd is packages/vscode
const WASM_DIR = path.join(PROJECT_ROOT, 'wasm');

// Check if WASM files exist (skip all tests if not available)
const hasOcioWasm = fs.existsSync(path.join(WASM_DIR, 'ocio.wasm')) &&
                    fs.existsSync(path.join(WASM_DIR, 'ocio.js'));
const hasNagaWasm = fs.existsSync(path.join(WASM_DIR, 'naga', 'naga_wasm_bg.wasm')) &&
                    fs.existsSync(path.join(WASM_DIR, 'naga', 'naga_wasm.js'));
const hasDctlCompilerWasm = fs.existsSync(path.join(WASM_DIR, 'dctl-compiler', 'dctl_compiler_bg.wasm')) &&
                            fs.existsSync(path.join(WASM_DIR, 'dctl-compiler', 'dctl_compiler.js'));
const hasAllWasm = hasOcioWasm && hasNagaWasm && hasDctlCompilerWasm;

// Simple gain DCTL for testing
const TEST_GAIN_DCTL = `
DEFINE_UI_PARAMS(gain, Gain, DCTL_SLIDER_FLOAT, 1.0, 0.0, 4.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, __TEXTURE__ p_TexR, __TEXTURE__ p_TexG, __TEXTURE__ p_TexB) {
    float r = _tex2D(p_TexR, p_X, p_Y);
    float g = _tex2D(p_TexG, p_X, p_Y);
    float b = _tex2D(p_TexB, p_X, p_Y);
    return make_float3(r * gain, g * gain, b * gain);
}
`;

describe('RGC Export Pipeline', function() {
    // WASM initialization can be slow
    this.timeout(30000);

    let buildDctlExportShader: any;

    before(async function() {
        if (!hasAllWasm) {
            console.log('WASM files not found, skipping RGC export pipeline tests');
            console.log(`  OCIO: ${hasOcioWasm ? 'found' : 'MISSING'}`);
            console.log(`  Naga: ${hasNagaWasm ? 'found' : 'MISSING'}`);
            console.log(`  DCTL Compiler: ${hasDctlCompilerWasm ? 'found' : 'MISSING'}`);
            this.skip();
            return;
        }

        // Initialize OCIO WASM (use dynamic import for ESM compatibility)
        const core = await import('@dctl-workbench/core');
        core.setOcioWasmPath(PROJECT_ROOT);
        await core.initOCIO();

        // Get the buildDctlExportShader function
        buildDctlExportShader = core.buildDctlExportShader;
        assert.ok(buildDctlExportShader, 'buildDctlExportShader should be exported from core');
    });

    it('should build export shader with RGC successfully', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true,
            `Export shader build should succeed, got error: ${result.error}`);
    });

    it('should include applyACES2RGC function in WGSL when RGC is enabled', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true,
            `Build should succeed: ${result.error}`);
        assert.ok(result.wgslCode.length > 0, 'WGSL code should not be empty');

        // Key assertion: RGC function must be present in the shader
        const hasRgcFunction = /fn\s+applyACES2RGC/.test(result.wgslCode);
        assert.ok(hasRgcFunction,
            'WGSL should contain applyACES2RGC function when RGC is enabled');
    });

    it('should return RGC LUT textures when RGC is enabled', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true,
            `Build should succeed: ${result.error}`);

        // RGC requires LUT textures for the gamut compression
        const hasTextures = (result.rgcTextures && result.rgcTextures.length > 0) ||
                           (result.rgcTextures3D && result.rgcTextures3D.length > 0);
        assert.ok(hasTextures,
            `RGC should return LUT textures. Got rgcTextures=${result.rgcTextures?.length ?? 0}, rgcTextures3D=${result.rgcTextures3D?.length ?? 0}`);
    });

    it('should include RGC texture bindings in the shader', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true,
            `Build should succeed: ${result.error}`);

        // Bindings should include RGC-related entries (beyond the base u_image_tex/u_image_samp)
        const rgcBindings = result.bindings.filter(
            (b: any) => b.name.startsWith('rgc_')
        );
        assert.ok(rgcBindings.length > 0,
            `Should have RGC texture bindings. Total bindings: ${result.bindings.length}, RGC bindings: ${rgcBindings.length}`);
    });

    it('should NOT include RGC when applyACES2GamutCompression is false', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: false,
        });

        assert.strictEqual(result.success, true,
            `Build should succeed: ${result.error}`);

        // Without RGC, should NOT have RGC functions
        const hasRgcFunction = /applyACES2RGC|rgc_ocio/.test(result.wgslCode);
        assert.strictEqual(hasRgcFunction, false,
            'WGSL should NOT contain RGC functions when RGC is disabled');

        // Should NOT have RGC textures
        const hasTextures = (result.rgcTextures && result.rgcTextures.length > 0) ||
                           (result.rgcTextures3D && result.rgcTextures3D.length > 0);
        assert.ok(!hasTextures,
            'Should NOT return RGC textures when RGC is disabled');
    });

    it('should call applyACES2RGC in the fragment shader pipeline', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true,
            `Build should succeed: ${result.error}`);

        // The RGC function should be CALLED in the shader pipeline (not just defined)
        // It's called in dctl_sampleTexture to compress gamut before DCTL processing
        const callsRgc = /applyACES2RGC\s*\(/.test(result.wgslCode);
        assert.ok(callsRgc,
            'Shader should call applyACES2RGC in the fragment pipeline');
    });

    it('should include RGC call inside dctl_sampleTexture body', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true, `Build should succeed: ${result.error}`);

        // Extract the dctl_sampleTexture function body
        const sampleTexMatch = result.wgslCode.match(
            /fn\s+dctl_sampleTexture\s*\([^)]*\)\s*->\s*vec4<f32>\s*\{([\s\S]*?)\n\}/
        );
        assert.ok(sampleTexMatch, 'Should find dctl_sampleTexture function in WGSL');

        const sampleTexBody = sampleTexMatch![1];
        console.log('\n=== dctl_sampleTexture body ===');
        console.log(sampleTexBody);

        // The RGC call must be inside dctl_sampleTexture
        const hasRgcCall = sampleTexBody.includes('applyACES2RGC');
        assert.ok(hasRgcCall,
            'dctl_sampleTexture body should contain applyACES2RGC call');

        // Verify the call is on ap1 data (after AP0→AP1 conversion)
        const ap0ToAp1Idx = sampleTexBody.indexOf('dctl_ap0ToWorking');
        const rgcCallIdx = sampleTexBody.indexOf('applyACES2RGC');
        assert.ok(ap0ToAp1Idx < rgcCallIdx,
            'RGC should be applied AFTER AP0→AP1 conversion');
    });

    it('should apply RGC for float-based DCTL as well', async function() {
        if (!hasAllWasm) this.skip();

        // Float-based DCTL (no __TEXTURE__ params)
        const floatDctl = `
DEFINE_UI_PARAMS(min_val, Min Value, DCTL_SLIDER_FLOAT, 0.45, 0.0, 1.0, 0.01)

__DEVICE__ float3 transform(int p_Width, int p_Height, int p_X, int p_Y, float p_R, float p_G, float p_B) {
    float r = _fmaxf(p_R, min_val);
    float g = _fmaxf(p_G, min_val);
    float b = _fmaxf(p_B, min_val);
    return make_float3(r, g, b);
}
`;

        const dctlShaderInfo = {
            source: floatDctl,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'min_val',
                label: 'Min Value',
                type: 'DCTL_SLIDER_FLOAT',
                default: 0.45,
                min: 0.0,
                max: 1.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { min_val: 0.45 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true, `Build should succeed: ${result.error}`);

        // Float-based DCTL should also have RGC in dctl_sampleTexture
        const hasRgcFunction = /fn\s+applyACES2RGC/.test(result.wgslCode);
        const callsRgc = /applyACES2RGC\s*\(/.test(result.wgslCode);

        console.log(`\n=== Float-based DCTL RGC check ===`);
        console.log(`Has applyACES2RGC function: ${hasRgcFunction}`);
        console.log(`Calls applyACES2RGC: ${callsRgc}`);
        console.log(`Has RGC textures: ${(result.rgcTextures?.length ?? 0) + (result.rgcTextures3D?.length ?? 0)}`);

        assert.ok(hasRgcFunction, 'Float DCTL should have applyACES2RGC function');
        assert.ok(callsRgc, 'Float DCTL should call applyACES2RGC');
        assert.ok(result.rgcTextures && result.rgcTextures.length > 0,
            'Float DCTL should return RGC textures');
    });

    it('should produce different WGSL for RGC vs non-RGC', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const options = {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            peakLuminance: 100,
        };

        const resultWithRgc = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            ...options,
            applyACES2GamutCompression: true,
        });

        const resultWithoutRgc = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            ...options,
            applyACES2GamutCompression: false,
        });

        assert.strictEqual(resultWithRgc.success, true);
        assert.strictEqual(resultWithoutRgc.success, true);

        // The WGSL should be DIFFERENT when RGC is enabled
        assert.notStrictEqual(resultWithRgc.wgslCode, resultWithoutRgc.wgslCode,
            'WGSL code should differ between RGC on and RGC off');

        // The RGC version should be significantly longer (RGC code adds ~25000 chars)
        const lenDiff = resultWithRgc.wgslCode.length - resultWithoutRgc.wgslCode.length;
        console.log(`\n=== WGSL Length Comparison ===`);
        console.log(`With RGC: ${resultWithRgc.wgslCode.length} chars`);
        console.log(`Without RGC: ${resultWithoutRgc.wgslCode.length} chars`);
        console.log(`Difference: ${lenDiff} chars`);

        assert.ok(lenDiff > 5000,
            `RGC WGSL should be significantly longer (diff=${lenDiff})`);

        // Extract the dctl_sampleTexture function from both
        const sampleTexRgc = resultWithRgc.wgslCode.match(
            /fn\s+dctl_sampleTexture\s*\([^)]*\)\s*->\s*vec4<f32>\s*\{([\s\S]*?)\n\}/
        );
        const sampleTexNoRgc = resultWithoutRgc.wgslCode.match(
            /fn\s+dctl_sampleTexture\s*\([^)]*\)\s*->\s*vec4<f32>\s*\{([\s\S]*?)\n\}/
        );

        assert.ok(sampleTexRgc, 'RGC WGSL should have dctl_sampleTexture');
        assert.ok(sampleTexNoRgc, 'Non-RGC WGSL should have dctl_sampleTexture');

        console.log(`\nRGC dctl_sampleTexture body:\n${sampleTexRgc![1]}`);
        console.log(`\nNon-RGC dctl_sampleTexture body:\n${sampleTexNoRgc![1]}`);

        // RGC version should contain applyACES2RGC call
        assert.ok(sampleTexRgc![1].includes('applyACES2RGC'),
            'RGC sampleTexture should call applyACES2RGC');
        // Non-RGC version should NOT contain applyACES2RGC call
        assert.ok(!sampleTexNoRgc![1].includes('applyACES2RGC'),
            'Non-RGC sampleTexture should NOT call applyACES2RGC');
    });

    it('should have correct texture sampling in RGC WGSL code', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true, `Build should succeed: ${result.error}`);

        // Extract lines that reference RGC texture sampling
        const lines = result.wgslCode.split('\n');
        const textureSampleLines = lines.filter((l: string) =>
            l.includes('textureSample') && (l.includes('rgc_') || l.includes('ocio_'))
        );

        console.log('\n=== RGC texture sampling in WGSL ===');
        for (const line of textureSampleLines) {
            console.log(`  ${line.trim()}`);
        }

        // Each RGC texture should be sampled using textureSample(tex, samp, coord)
        const reach_tex = 'rgc_ocio_reach_m_table_0Sampler_tex';
        const reach_samp = 'rgc_ocio_reach_m_table_0Sampler_samp';
        const cusp_tex = 'rgc_ocio_gamut_cusp_table_0Sampler_tex';
        const cusp_samp = 'rgc_ocio_gamut_cusp_table_0Sampler_samp';

        assert.ok(result.wgslCode.includes(reach_tex),
            `WGSL should reference texture ${reach_tex}`);
        assert.ok(result.wgslCode.includes(reach_samp),
            `WGSL should reference sampler ${reach_samp}`);
        assert.ok(result.wgslCode.includes(cusp_tex),
            `WGSL should reference texture ${cusp_tex}`);
        assert.ok(result.wgslCode.includes(cusp_samp),
            `WGSL should reference sampler ${cusp_samp}`);

        // Check that textureSample calls reference correct tex/samp pairs
        const hasReachSample = result.wgslCode.includes(`textureSample(${reach_tex}, ${reach_samp}`) ||
                                result.wgslCode.includes(`textureSampleLevel(${reach_tex}, ${reach_samp}`);
        const hasCuspSample = result.wgslCode.includes(`textureSample(${cusp_tex}, ${cusp_samp}`) ||
                               result.wgslCode.includes(`textureSampleLevel(${cusp_tex}, ${cusp_samp}`);

        console.log(`\nReach table sampled with correct pair: ${hasReachSample}`);
        console.log(`Cusp table sampled with correct pair: ${hasCuspSample}`);

        assert.ok(hasReachSample, 'Reach table should be sampled with correct texture/sampler pair');
        assert.ok(hasCuspSample, 'Cusp table should be sampled with correct texture/sampler pair');
    });

    it('should have valid RGC texture data', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true, `Build should succeed: ${result.error}`);

        console.log('\n=== RGC Texture Data Inspection ===');
        if (result.rgcTextures) {
            for (let i = 0; i < result.rgcTextures.length; i++) {
                const tex = result.rgcTextures[i];
                console.log(`2D Texture ${i}: name="${tex.name}", sampler="${tex.samplerName}", `
                    + `${tex.width}x${tex.height}, channel=${tex.channel}, `
                    + `data.length=${tex.data.length}, data type=${tex.data.constructor.name}`);

                // Check data is not all zeros
                const hasNonZero = tex.data.some((v: number) => v !== 0);
                console.log(`  Has non-zero data: ${hasNonZero}`);
                assert.ok(hasNonZero, `Texture ${i} data should not be all zeros`);

                // Check expected data size matches dimensions
                const expectedSingleChannel = tex.width * tex.height;
                const expectedRgb = tex.width * tex.height * 3;
                const dataLen = tex.data.length;
                const matchesSingle = dataLen === expectedSingleChannel;
                const matchesRgb = dataLen === expectedRgb;
                console.log(`  Data length ${dataLen} matches: single=${matchesSingle}, rgb=${matchesRgb}`);
                assert.ok(matchesSingle || matchesRgb,
                    `Texture ${i} data length ${dataLen} should match dimensions (${expectedSingleChannel} single or ${expectedRgb} RGB)`);

                // Print first few values
                const first5 = tex.data.slice(0, 5);
                console.log(`  First 5 values: [${first5.join(', ')}]`);
            }
        }

        if (result.rgcTextures3D) {
            for (let i = 0; i < result.rgcTextures3D.length; i++) {
                const tex = result.rgcTextures3D[i];
                console.log(`3D Texture ${i}: name="${tex.name}", sampler="${tex.samplerName}", `
                    + `edgeLen=${tex.edgeLen}, data.length=${tex.data.length}`);
            }
        }
    });

    it('should have WGSL binding annotations matching the bindings array', async function() {
        if (!hasAllWasm) this.skip();

        const dctlShaderInfo = {
            source: TEST_GAIN_DCTL,
            workingColorSpace: 'ACEScct',
            params: [{
                name: 'gain',
                label: 'Gain',
                type: 'DCTL_SLIDER_FLOAT',
                default: 1.0,
                min: 0.0,
                max: 4.0,
                step: 0.01,
            }],
        };

        const result = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
            paramValues: { gain: 1.5 },
            imageWidth: 64,
            imageHeight: 64,
            applyACES2GamutCompression: true,
            peakLuminance: 100,
        });

        assert.strictEqual(result.success, true, `Build should succeed: ${result.error}`);

        // Extract all @binding(N) annotations from the WGSL
        const bindingRegex = /@group\(0\)\s+@binding\((\d+)\)/g;
        const wgslBindings: number[] = [];
        let match;
        while ((match = bindingRegex.exec(result.wgslCode)) !== null) {
            wgslBindings.push(parseInt(match[1]));
        }

        // Extract binding indices from the bindings array
        const arrayBindings = result.bindings.map((b: any) => b.binding);

        console.log('\n=== Binding Consistency Check ===');
        console.log(`WGSL @binding indices: [${wgslBindings.join(', ')}]`);
        console.log(`Bindings array indices: [${arrayBindings.join(', ')}]`);
        console.log(`Bindings details:`);
        for (const b of result.bindings) {
            console.log(`  binding ${b.binding}: type=${b.type}, name=${b.name}`);
        }

        // Every binding index in the WGSL must exist in the bindings array
        for (const wgslIdx of wgslBindings) {
            const found = arrayBindings.includes(wgslIdx);
            assert.ok(found,
                `WGSL @binding(${wgslIdx}) not found in bindings array [${arrayBindings.join(', ')}]`);
        }

        // Every binding in the array (except base texture/sampler) should exist in WGSL
        for (const arrIdx of arrayBindings) {
            const found = wgslBindings.includes(arrIdx);
            assert.ok(found,
                `Bindings array index ${arrIdx} not found in WGSL @binding annotations [${wgslBindings.join(', ')}]`);
        }

        // Verify the RGC textures match the order expected by the webview renderer
        // The webview adds 2D textures first, then 3D textures (each with a sampler)
        const rgcBindings = result.bindings.filter((b: any) => b.name.startsWith('rgc_'));
        const numRgcTextures2D = result.rgcTextures?.length ?? 0;
        const numRgcTextures3D = result.rgcTextures3D?.length ?? 0;

        // Each RGC texture needs 2 bindings (texture + sampler)
        const expectedRgcBindings = (numRgcTextures2D + numRgcTextures3D) * 2;
        assert.strictEqual(rgcBindings.length, expectedRgcBindings,
            `RGC bindings count mismatch: got ${rgcBindings.length}, expected ${expectedRgcBindings} (${numRgcTextures2D} 2D + ${numRgcTextures3D} 3D textures × 2)`);

        // Check that the webview's binding order matches the shader's binding order.
        // The webview iterates: all 2D textures first, then all 3D textures.
        // Each texture gets 2 consecutive bindings: texture view, then sampler.
        // Verify this matches the shader's declaration order.
        if (rgcBindings.length > 0) {
            // Separate 2D and 3D bindings from the shader
            const texture2DBindings = rgcBindings.filter((b: any) => b.type === 'texture2D');
            const texture3DBindings = rgcBindings.filter((b: any) => b.type === 'texture3D');
            const samplerBindings = rgcBindings.filter((b: any) => b.type === 'sampler');

            console.log(`\nRGC texture2D bindings: [${texture2DBindings.map((b: any) => b.binding).join(', ')}]`);
            console.log(`RGC texture3D bindings: [${texture3DBindings.map((b: any) => b.binding).join(', ')}]`);
            console.log(`RGC sampler bindings: [${samplerBindings.map((b: any) => b.binding).join(', ')}]`);

            // CRITICAL CHECK: Verify the webview renderer creates bind group entries in the
            // same order as the shader expects.
            // The webview does: for each 2D tex: [tex.createView(), sampler], then for each 3D tex: [tex.createView(), sampler]
            // Starting from bindingIndex = 2.
            //
            // The shader assigns bindings based on GLSL declaration order, which may
            // interleave 2D and 3D textures. If the GLSL declares a 2D, then a 3D, then a 2D,
            // the bindings would be: 2,3 (2D), 4,5 (3D), 6,7 (2D).
            // But the webview would assign: 2,3 (first 2D), 4,5 (second 2D), 6,7 (3D).
            //
            // Check if the binding order from the shader matches what the webview would produce.
            let simulatedBindingIdx = 2;
            const simulatedBindings: Array<{binding: number; type: string}> = [];

            // Webview adds 2D textures first
            for (let i = 0; i < numRgcTextures2D; i++) {
                simulatedBindings.push({ binding: simulatedBindingIdx++, type: 'texture2D' });
                simulatedBindings.push({ binding: simulatedBindingIdx++, type: 'sampler' });
            }
            // Then 3D textures
            for (let i = 0; i < numRgcTextures3D; i++) {
                simulatedBindings.push({ binding: simulatedBindingIdx++, type: 'texture3D' });
                simulatedBindings.push({ binding: simulatedBindingIdx++, type: 'sampler' });
            }

            console.log(`\nSimulated webview binding order: [${simulatedBindings.map(b => `${b.binding}:${b.type}`).join(', ')}]`);
            console.log(`Shader binding order: [${rgcBindings.map((b: any) => `${b.binding}:${b.type}`).join(', ')}]`);

            // Check for binding order mismatch
            for (let i = 0; i < simulatedBindings.length; i++) {
                const simulated = simulatedBindings[i];
                const shader = rgcBindings[i];
                if (!shader) {
                    assert.fail(`Webview would assign binding ${simulated.binding} (${simulated.type}) but shader has no corresponding binding at index ${i}`);
                }
                assert.strictEqual(simulated.binding, shader.binding,
                    `Binding index mismatch at position ${i}: webview=${simulated.binding}, shader=${shader.binding}`);
                assert.strictEqual(simulated.type, shader.type,
                    `Binding type mismatch at binding ${simulated.binding}: webview=${simulated.type}, shader=${shader.type}`);
            }
        }
    });

    describe('hues_array preservation', function() {
        // The hues_array is critical for hue-dependent gamut compression.
        // If it's missing or corrupted, RGC becomes an identity transform (no compression).
        // The compute/display path has safeguards, but the export path may not.

        let rgcResult: any;

        before(async function() {
            if (!hasAllWasm) {
                this.skip();
                return;
            }

            const dctlShaderInfo = {
                source: TEST_GAIN_DCTL,
                workingColorSpace: 'ACEScct',
                params: [{
                    name: 'gain',
                    label: 'Gain',
                    type: 'DCTL_SLIDER_FLOAT',
                    default: 1.0,
                    min: 0.0,
                    max: 4.0,
                    step: 0.01,
                }],
            };

            rgcResult = await buildDctlExportShader(PROJECT_ROOT, dctlShaderInfo, {
                paramValues: { gain: 1.5 },
                imageWidth: 64,
                imageHeight: 64,
                applyACES2GamutCompression: true,
                peakLuminance: 100,
            });

            assert.strictEqual(rgcResult.success, true,
                `Build should succeed: ${rgcResult.error}`);
        });

        it('should preserve hues_array declaration in export WGSL', function() {
            if (!hasAllWasm) this.skip();

            // hues_array is used for hue-dependent gamut boundary lookup.
            // It should appear as a var<private> with array type in the WGSL.
            const hasHuesArray = rgcResult.wgslCode.includes('hues_array');

            console.log('\n=== hues_array Preservation Check ===');
            console.log(`WGSL contains hues_array: ${hasHuesArray}`);

            // Find the actual declaration if present
            const huesArrayDecl = rgcResult.wgslCode.match(
                /var<private>\s+\w*hues_array\w*\s*:\s*array<[^>]+>[^;]*;/
            );
            console.log(`hues_array declaration: ${huesArrayDecl?.[0] ?? 'NOT FOUND'}`);

            assert.ok(hasHuesArray,
                'Export WGSL must contain hues_array declaration for proper RGC operation');
            assert.ok(huesArrayDecl,
                'hues_array must be declared as var<private> with array type');
        });

        it('should have f32 type for hues_array (not i32)', function() {
            if (!hasAllWasm) this.skip();

            // naga sometimes converts float arrays to i32, which breaks RGC computation
            const huesArrayDecl = rgcResult.wgslCode.match(
                /var<private>\s+\w*hues_array\w*\s*:\s*array<(\w+),/
            );

            console.log('\n=== hues_array Type Check ===');
            if (huesArrayDecl) {
                console.log(`hues_array element type: ${huesArrayDecl[1]}`);
            } else {
                console.log('hues_array declaration not found');
            }

            assert.ok(huesArrayDecl, 'hues_array declaration must be present');
            assert.strictEqual(huesArrayDecl![1], 'f32',
                `hues_array should be array<f32, ...> but got array<${huesArrayDecl![1]}, ...>`);
        });

        it('should have all required var<private> array declarations', function() {
            if (!hasAllWasm) this.skip();

            // Count var<private> array declarations in the RGC WGSL code
            const arrayDecls = rgcResult.wgslCode.match(
                /var<private>\s+\w+\s*:\s*array<[^>]+>[^;]*;/g
            ) ?? [];

            console.log('\n=== var<private> Array Declarations ===');
            console.log(`Total array declarations: ${arrayDecls.length}`);
            for (const decl of arrayDecls) {
                // Print first 100 chars of each declaration
                console.log(`  ${decl.substring(0, 100)}${decl.length > 100 ? '...' : ''}`);
            }

            // There should be at least one array declaration (hues_array)
            assert.ok(arrayDecls.length > 0,
                'Export WGSL must have at least one var<private> array declaration');
        });

        it('should have hues_array with initialization data (not empty/zero)', function() {
            if (!hasAllWasm) this.skip();

            // The hues_array should be initialized with actual values (0-359 hue indices)
            // If it's just declared without initialization, RGC won't work correctly
            const huesArrayWithInit = rgcResult.wgslCode.match(
                /var<private>\s+\w*hues_array\w*\s*:\s*array<[^>]+>\s*=\s*array<[^>]+>\(/
            );

            console.log('\n=== hues_array Initialization Check ===');
            console.log(`hues_array has initialization: ${!!huesArrayWithInit}`);

            assert.ok(huesArrayWithInit,
                'hues_array must have initialization data (= array<...>(...))');
        });
    });
});
