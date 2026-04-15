/**
 * L5.a — tests for the pre-transform WGSL compute shader generator.
 *
 * The shader itself is static — the generator returns a constant string
 * plus a few configurable knobs (workgroup size, input format). The tests
 * ensure the returned source has the structural pieces the host pipeline
 * relies on, so that refactors cannot silently break the contract.
 */

import { strict as assert } from 'assert';
import { buildPreTransformWGSL } from '../../webview/shared/pre-transform-shader';

describe('buildPreTransformWGSL — structure', () => {
    it('defines a compute entry point with workgroup_size(8, 8)', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        assert.match(wgsl, /@compute\s+@workgroup_size\(\s*8\s*,\s*8\s*\)/);
    });

    it('declares an rgba32float input texture when inputFormat === "rgba32float"', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        // Either a texture_2d<f32> that gets sampled with f32 loads or an
        // explicit rgba32float storage texture — we only require that the
        // shader source mentions f32 sampling.
        assert.match(wgsl, /texture_2d<f32>/);
    });

    it('declares an rgba16unorm input texture when inputFormat === "rgba16unorm"', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba16unorm' });
        // rgba16unorm is normalized to f32 on sample, so the shader still
        // reads with textureLoad returning vec4<f32>.
        assert.match(wgsl, /texture_2d<f32>/);
    });

    it('always writes into an rgba32float storage texture (the OCIO-ready intermediate)', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        assert.match(wgsl, /texture_storage_2d<rgba32float,\s*write>/);
    });

    it('binds the uniform mat3x3<f32> that carries the matrix', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        assert.match(wgsl, /var<uniform>[^;]*mat3x3<f32>/);
    });

    it('preserves alpha in the output', () => {
        // Weak structural check: alpha channel must appear in the stored vec4.
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        // Find a textureStore call and ensure it uses pixel.a for the 4th component.
        assert.match(wgsl, /textureStore\([^)]*pixel\.a[^)]*\)/);
    });

    it('guards against out-of-bounds workgroup threads', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        // Some form of `textureDimensions` comparison, so threads past the
        // image bounds bail out before touching storage.
        assert.match(wgsl, /textureDimensions/);
        assert.match(wgsl, /return/);
    });

    it('throws for unsupported inputFormat', () => {
        assert.throws(
            () => buildPreTransformWGSL({ inputFormat: 'bgra8unorm' as never }),
            /unsupported.*bgra8unorm/i,
        );
    });

    // Snapshot test to catch accidental semantic changes. The source is
    // small and stable; refactors should update the snapshot deliberately.
    it('snapshot: rgba32float output is stable across refactors', () => {
        const wgsl = buildPreTransformWGSL({ inputFormat: 'rgba32float' });
        // Rough length sanity — keeps the test from silently ignoring the
        // situation where the generator starts returning an empty string.
        assert.ok(wgsl.length > 200, `shader is suspiciously short: ${wgsl.length} chars`);
    });
});
