/**
 * Export Float32-Filterable Fallback Tests
 *
 * Tests selectSamplerForFormat() — the actual production function used by
 * WebGPURenderer.buildExportShader() to choose the correct sampler for
 * each RGC texture based on format and float32-filterable capability.
 *
 * When float32-filterable is NOT available, r32float textures (used by RGC
 * reach table) must use nearest-neighbor sampling instead of linear filtering,
 * otherwise WebGPU produces a silent validation error and the texture returns
 * zero values (RGC becomes identity transform = no compression).
 */

import * as assert from 'assert';
import {
    MockGPUDevice,
    MockGPUSampler,
} from '../mocks/webgpu-mock';
import {
    create2DTexture,
    createFilteringSampler,
    createNearestSampler,
    selectSamplerForFormat,
    SAMPLER_CONFIG,
} from '../../webview/texture-utils';

// Polyfill WebGPU runtime constants for Node.js test environment
// (TypeScript types are available via @webgpu/types, but runtime values are not)
if (typeof globalThis.GPUTextureUsage === 'undefined') {
    (globalThis as any).GPUTextureUsage = {
        COPY_SRC: 0x01,
        COPY_DST: 0x02,
        TEXTURE_BINDING: 0x04,
        STORAGE_BINDING: 0x08,
        RENDER_ATTACHMENT: 0x10,
    };
}

describe('Export Float32-Filterable Fallback', () => {

    describe('selectSamplerForFormat (production function)', () => {
        // These tests call the ACTUAL function used by WebGPURenderer.buildExportShader()

        let device: any;
        let filteringSampler: any;
        let nearestSampler: any;

        beforeEach(() => {
            device = new MockGPUDevice() as any;
            filteringSampler = createFilteringSampler(device, 'Filtering');
            nearestSampler = createNearestSampler(device, 'Nearest');
        });

        it('should return nearest sampler for r32float when float32-filterable is NOT available', () => {
            const result = selectSamplerForFormat('r32float', false, filteringSampler, nearestSampler);
            assert.strictEqual(result, nearestSampler,
                'r32float without float32-filterable MUST use nearest sampler');
        });

        it('should return filtering sampler for r32float when float32-filterable IS available', () => {
            const result = selectSamplerForFormat('r32float', true, filteringSampler, nearestSampler);
            assert.strictEqual(result, filteringSampler,
                'r32float with float32-filterable should use filtering sampler');
        });

        it('should return filtering sampler for rgba32float regardless of float32-filterable', () => {
            const withoutFeature = selectSamplerForFormat('rgba32float', false, filteringSampler, nearestSampler);
            const withFeature = selectSamplerForFormat('rgba32float', true, filteringSampler, nearestSampler);

            assert.strictEqual(withoutFeature, filteringSampler,
                'rgba32float should always use filtering sampler (no feature)');
            assert.strictEqual(withFeature, filteringSampler,
                'rgba32float should always use filtering sampler (with feature)');
        });

        it('should return filtering sampler for rgba8unorm regardless of float32-filterable', () => {
            const result = selectSamplerForFormat('rgba8unorm', false, filteringSampler, nearestSampler);
            assert.strictEqual(result, filteringSampler,
                'Non-float32 formats should always use filtering sampler');
        });
    });

    describe('RGC texture format detection', () => {
        // Verify create2DTexture returns the correct format that drives sampler selection

        it('should return r32float for single-channel RGC reach table (channel=0)', () => {
            const device = new MockGPUDevice() as any;
            const tex = {
                name: 'reach_table',
                samplerName: 'ocio_reach_m_table_0Sampler',
                width: 362, height: 1, channel: 0, dimensions: 2,
                data: new Array(362).fill(0.5),
            };

            const result = create2DTexture(device, tex);
            assert.ok(result);
            assert.strictEqual(result!.format, 'r32float');
        });

        it('should return rgba32float for RGB RGC cusp table (channel=1)', () => {
            const device = new MockGPUDevice() as any;
            const tex = {
                name: 'cusp_table',
                samplerName: 'ocio_gamut_cusp_table_0Sampler',
                width: 362, height: 1, channel: 1, dimensions: 2,
                data: new Array(362 * 3).fill(0.5),
            };

            const result = create2DTexture(device, tex);
            assert.ok(result);
            assert.strictEqual(result!.format, 'rgba32float');
        });
    });

    describe('Export bind group: selectSamplerForFormat integration', () => {
        // Simulates buildExportShader's bind group creation using the actual
        // selectSamplerForFormat function (same code path as the renderer).

        function buildExportBindEntries(hasFloat32Filterable: boolean) {
            const device = new MockGPUDevice({
                features: hasFloat32Filterable ? ['float32-filterable'] : [],
            }) as any;

            const filtering = createFilteringSampler(device, 'Filtering');
            const nearest = createNearestSampler(device, 'Nearest');

            // Simulate RGC textures: reach_table (r32float) + cusp_table (rgba32float)
            const rgcTextures = [
                { channel: 0, samplerName: 'reach_table' },
                { channel: 1, samplerName: 'cusp_table' },
            ];

            const entries: Array<{ binding: number; samplerLabel: string }> = [];
            let bindingIndex = 2; // after image texture (0) and image sampler (1)

            for (const tex of rgcTextures) {
                const format = (tex.channel === 0 ? 'r32float' : 'rgba32float') as GPUTextureFormat;
                // This is the ACTUAL production function
                const sampler = selectSamplerForFormat(format, hasFloat32Filterable, filtering, nearest);
                bindingIndex++; // texture binding
                entries.push({
                    binding: bindingIndex++,
                    samplerLabel: (sampler as any).label,
                });
            }

            return entries;
        }

        it('should use nearest for r32float and filtering for rgba32float when no float32-filterable', () => {
            const entries = buildExportBindEntries(false);

            assert.strictEqual(entries[0].samplerLabel, 'Nearest',
                'reach_table (r32float) sampler must be Nearest');
            assert.strictEqual(entries[1].samplerLabel, 'Filtering',
                'cusp_table (rgba32float) sampler must be Filtering');
        });

        it('should use filtering for ALL textures when float32-filterable is available', () => {
            const entries = buildExportBindEntries(true);

            assert.strictEqual(entries[0].samplerLabel, 'Filtering',
                'reach_table sampler should be Filtering with feature');
            assert.strictEqual(entries[1].samplerLabel, 'Filtering',
                'cusp_table sampler should be Filtering');
        });
    });

    describe('Renderer source verification', () => {
        // Verify that webgpu-renderer.ts actually calls selectSamplerForFormat

        let rendererSource: string;

        before(function() {
            const fs = require('fs');
            const path = require('path');
            const cwd = process.cwd();
            const rendererPath = fs.existsSync(path.join(cwd, 'src/webview/webgpu-renderer.ts'))
                ? path.join(cwd, 'src/webview/webgpu-renderer.ts')
                : path.join(cwd, 'packages/vscode/src/webview/webgpu-renderer.ts');

            if (!fs.existsSync(rendererPath)) {
                this.skip();
                return;
            }
            rendererSource = fs.readFileSync(rendererPath, 'utf-8');
        });

        it('should import selectSamplerForFormat from texture-utils', function() {
            assert.ok(
                rendererSource.includes('selectSamplerForFormat'),
                'Renderer must import and use selectSamplerForFormat',
            );
        });

        it('should call selectSamplerForFormat in buildExportShader', function() {
            // Find the selectSamplerForFormat call within the file
            const callPattern = /selectSamplerForFormat\s*\(\s*format\s*,/;
            assert.ok(
                callPattern.test(rendererSource),
                'buildExportShader must call selectSamplerForFormat(format, ...)',
            );
        });

        it('should check device.features.has float32-filterable', function() {
            assert.ok(
                rendererSource.includes("features.has('float32-filterable')"),
                'Renderer must check float32-filterable feature',
            );
        });

        it('should use pushErrorScope for render validation', function() {
            assert.ok(
                rendererSource.includes("pushErrorScope('validation')"),
                'Renderer must use pushErrorScope for validation error detection',
            );
        });
    });

    describe('Sampler configuration', () => {
        it('filtering sampler should use linear filter mode', () => {
            assert.strictEqual(SAMPLER_CONFIG.filtering.magFilter, 'linear');
            assert.strictEqual(SAMPLER_CONFIG.filtering.minFilter, 'linear');
        });

        it('nearest sampler should use nearest filter mode', () => {
            assert.strictEqual(SAMPLER_CONFIG.nearest.magFilter, 'nearest');
            assert.strictEqual(SAMPLER_CONFIG.nearest.minFilter, 'nearest');
        });
    });

    describe('MockGPUDevice features and error scope', () => {
        it('should default to no features', () => {
            const device = new MockGPUDevice();
            assert.strictEqual(device.features.has('float32-filterable'), false);
        });

        it('should support specifying features', () => {
            const device = new MockGPUDevice({ features: ['float32-filterable'] });
            assert.strictEqual(device.features.has('float32-filterable'), true);
        });

        it('should track pushErrorScope/popErrorScope', async () => {
            const device = new MockGPUDevice();
            device.pushErrorScope('validation');
            const error = await device.popErrorScope();

            assert.strictEqual(error, null);
            assert.deepStrictEqual(device.pushedErrorScopes, ['validation']);
            assert.deepStrictEqual(device.poppedErrorScopes, ['validation']);
        });
    });
});
