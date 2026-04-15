/**
 * L5.c — unit tests for the pre-transform compute-pass runner.
 *
 * `runPreTransform` is the pure core of `WebGPURenderer.applyPreTransform`:
 * given a device, a source texture, a matrix, and a persistent cache, it
 * executes one compute pass and returns a fresh rgba32float output texture.
 * The renderer only wraps the swap/destroy glue around it, so testing the
 * runner pins down the behaviors that matter:
 *
 *   - shader + pipeline creation keyed by input format
 *   - pipeline and uniform buffer caching across calls
 *   - correct uniform encoding (column-major mat3x3<f32> with vec4 padding)
 *   - rgba32float intermediate with STORAGE_BINDING + TEXTURE_BINDING
 *   - workgroup dispatch dimensions (ceil(w/8), ceil(h/8))
 *   - output swap does not touch the source (the caller owns destroy())
 */

import { strict as assert } from 'assert';
import {
    createPreTransformCache,
    runPreTransform,
} from '../../webview/shared/pre-transform-runner';
import {
    encodeMat3ForWgslUniform,
    MAT3X3_UNIFORM_BYTE_SIZE,
} from '../../webview/shared/matrix-encoding';
import {
    MockGPUDevice,
    MockGPUTexture,
    GPUBufferUsage,
    GPUTextureUsage,
} from '../mocks/webgpu-mock';

// Polyfill WebGPU runtime constants so `GPUBufferUsage.UNIFORM` and
// `GPUTextureUsage.STORAGE_BINDING` resolve when the production runner
// reads them at call time.
if (typeof (globalThis as any).GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = GPUBufferUsage;
}
if (typeof (globalThis as any).GPUTextureUsage === 'undefined') {
    (globalThis as any).GPUTextureUsage = GPUTextureUsage;
}

type PreTransformMatrix = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

const IDENTITY: PreTransformMatrix = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
];

const SRGB_TO_AP0: PreTransformMatrix = [
    [0.4395722998, 0.3839185441, 0.1765091561],
    [0.0895766616, 0.8150065542, 0.0954167842],
    [0.0173096404, 0.1095964685, 0.8730938911],
];

function makeSource(
    device: MockGPUDevice,
    opts: { width: number; height: number; format: 'rgba32float' | 'rgba16unorm' },
): MockGPUTexture {
    return device.createTexture({
        label: 'source imageTexture (test)',
        size: { width: opts.width, height: opts.height },
        format: opts.format,
        usage: GPUTextureUsage.TEXTURE_BINDING,
    });
}

describe('runPreTransform — rgba32float source', () => {
    const W = 17; // deliberately non-multiples of the workgroup size
    const H = 11;

    it('compiles the rgba32float shader variant and creates one compute pipeline', () => {
        const device = new MockGPUDevice();
        const cache = createPreTransformCache();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });

        runPreTransform(device as any, src as any, IDENTITY, cache);

        assert.equal(device.createdShaderModules.length, 1);
        const code = device.createdShaderModules[0].code;
        assert.match(code, /texture_storage_2d<rgba32float,\s*write>/);
        assert.match(code, /var<uniform>[^;]*mat3x3<f32>/);

        assert.equal(device.createdComputePipelines.length, 1);
        assert.equal(
            device.createdComputePipelines[0].compute.entryPoint,
            'apply_pre_transform',
        );
    });

    it('allocates a 48-byte uniform buffer with UNIFORM|COPY_DST usage', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        const uniform = device.createdBuffers.find(
            (b) => b.size === MAT3X3_UNIFORM_BYTE_SIZE
                && (b.usage & GPUBufferUsage.UNIFORM) !== 0,
        );
        assert.ok(uniform, 'expected a uniform buffer of MAT3X3_UNIFORM_BYTE_SIZE');
        assert.equal(uniform.size, 48);
        assert.ok((uniform.usage & GPUBufferUsage.UNIFORM) !== 0, 'usage must include UNIFORM');
        assert.ok((uniform.usage & GPUBufferUsage.COPY_DST) !== 0, 'usage must include COPY_DST');
    });

    it('writes the column-major padded matrix into the uniform buffer', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });

        runPreTransform(device as any, src as any, SRGB_TO_AP0, createPreTransformCache());

        const writes = device.queue.writtenBuffers;
        assert.ok(writes.length >= 1, 'expected at least one writeBuffer call');
        const last = writes[writes.length - 1];
        const view = new Float32Array(last.data);
        const expected = encodeMat3ForWgslUniform(SRGB_TO_AP0);
        assert.equal(view.length, expected.length);
        for (let i = 0; i < expected.length; i++) {
            assert.ok(
                Math.abs(view[i] - expected[i]) < 1e-12,
                `uniform[${i}]=${view[i]} expected ${expected[i]}`,
            );
        }
    });

    it('returns an rgba32float texture with STORAGE_BINDING | TEXTURE_BINDING usage', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });

        const out = runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        assert.notEqual(out, src, 'output must be a different texture than source');
        const mt = out as unknown as MockGPUTexture;
        assert.equal(mt.format, 'rgba32float');
        assert.equal(mt.width, W);
        assert.equal(mt.height, H);
        assert.ok(
            (mt.usage & GPUTextureUsage.STORAGE_BINDING) !== 0,
            'output must be bindable as storage (compute pass writes into it)',
        );
        assert.ok(
            (mt.usage & GPUTextureUsage.TEXTURE_BINDING) !== 0,
            'output must be sampleable for the next pass',
        );
    });

    it('dispatches ceil(W/8) × ceil(H/8) workgroups (non-aligned dimensions)', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });

        let lastEncoder: any = null;
        const orig = device.createCommandEncoder.bind(device);
        (device as any).createCommandEncoder = () => {
            const enc = orig();
            lastEncoder = enc;
            return enc;
        };

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        assert.ok(lastEncoder);
        const passes = lastEncoder.computePasses;
        assert.equal(passes.length, 1, 'expected exactly one compute pass');
        const dispatch = passes[0].dispatchCalls[0];
        assert.ok(dispatch, 'expected a dispatchWorkgroups call');
        assert.equal(dispatch.x, Math.ceil(W / 8));
        assert.equal(dispatch.y, Math.ceil(H / 8));
        assert.equal(dispatch.z, 1);
    });

    it('submits exactly one command buffer per call', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });
        const baseline = device.queue.submittedBuffers.length;

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        assert.equal(device.queue.submittedBuffers.length, baseline + 1);
    });

    it('does not destroy the source texture (caller owns that)', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: W, height: H, format: 'rgba32float' });

        let destroyed = false;
        const origDestroy = src.destroy.bind(src);
        (src as any).destroy = () => { destroyed = true; origDestroy(); };

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        assert.equal(destroyed, false, 'runner must leave destroy to the caller');
    });
});

describe('runPreTransform — rgba16unorm source', () => {
    it('compiles the rgba16unorm-labeled shader variant', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 8, height: 8, format: 'rgba16unorm' });

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        const modules = device.createdShaderModules;
        assert.equal(modules.length, 1);
        // The runner embeds the input format in the shader module label so
        // it shows up in debug tools without parsing the WGSL source.
        assert.ok(
            modules[0].label.includes('rgba16unorm'),
            `expected label to mention rgba16unorm, got '${modules[0].label}'`,
        );
    });

    it('still produces an rgba32float output (OCIO-ready intermediate)', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 8, height: 8, format: 'rgba16unorm' });

        const out = runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        const mt = out as unknown as MockGPUTexture;
        assert.equal(mt.format, 'rgba32float');
        assert.ok((mt.usage & GPUTextureUsage.STORAGE_BINDING) !== 0);
    });
});

describe('runPreTransform — caching across calls', () => {
    it('caches the compute pipeline per input format (single shader module)', () => {
        const device = new MockGPUDevice();
        const cache = createPreTransformCache();

        // Three calls against the same-format source. The runner does not
        // swap textures — the caller does — so passing the same source back
        // in is the realistic simulation for cache reuse.
        const src = makeSource(device, { width: 8, height: 8, format: 'rgba32float' });
        runPreTransform(device as any, src as any, IDENTITY, cache);
        runPreTransform(device as any, src as any, IDENTITY, cache);
        runPreTransform(device as any, src as any, IDENTITY, cache);

        assert.equal(
            device.createdShaderModules.length,
            1,
            'shader compiled once; subsequent calls must reuse it',
        );
        assert.equal(
            device.createdComputePipelines.length,
            1,
            'compute pipeline created once; subsequent calls must reuse it',
        );
    });

    it('reuses the uniform buffer across calls', () => {
        const device = new MockGPUDevice();
        const cache = createPreTransformCache();
        const src = makeSource(device, { width: 8, height: 8, format: 'rgba32float' });

        runPreTransform(device as any, src as any, IDENTITY, cache);
        runPreTransform(device as any, src as any, SRGB_TO_AP0, cache);
        runPreTransform(device as any, src as any, IDENTITY, cache);

        const uniforms = device.createdBuffers.filter(
            (b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0
                && b.size === MAT3X3_UNIFORM_BYTE_SIZE,
        );
        assert.equal(uniforms.length, 1, 'expected a single cached uniform buffer');
    });

    it('writes the uniform buffer on every call (matrix may differ)', () => {
        const device = new MockGPUDevice();
        const cache = createPreTransformCache();
        const src = makeSource(device, { width: 8, height: 8, format: 'rgba32float' });

        const baseline = device.queue.writtenBuffers.length;
        runPreTransform(device as any, src as any, IDENTITY, cache);
        runPreTransform(device as any, src as any, SRGB_TO_AP0, cache);

        const uniform = device.createdBuffers.find(
            (b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0,
        );
        assert.ok(uniform);
        const uniformWrites = device.queue.writtenBuffers
            .slice(baseline)
            .filter((w) => w.buffer === uniform);
        assert.equal(uniformWrites.length, 2);
    });

    it('compiles a second shader variant if input format changes within the same cache', () => {
        const device = new MockGPUDevice();
        const cache = createPreTransformCache();

        const srcA = makeSource(device, { width: 8, height: 8, format: 'rgba32float' });
        runPreTransform(device as any, srcA as any, IDENTITY, cache);
        assert.equal(device.createdShaderModules.length, 1);

        const srcB = makeSource(device, { width: 8, height: 8, format: 'rgba16unorm' });
        runPreTransform(device as any, srcB as any, IDENTITY, cache);
        assert.equal(
            device.createdShaderModules.length,
            2,
            'a new input format must trigger a second pipeline',
        );
        assert.equal(device.createdComputePipelines.length, 2);
    });
});

// L11 regression guard: the EXR path (no plugin-supplied matrix) must
// behave identically to before T006. The editor-provider relay tests
// (exr-editor-provider-handlers.test.ts) already prove the loadImage
// payload carries `preTransformMatrix: undefined` when the builtin plugin
// doesn't set it. Here we pin down the webview-side invariant that sits
// between that payload and the renderer: the "undefined matrix" guard
// that protects the runner from ever being called.
describe('runPreTransform — L11 regression (EXR path unchanged)', () => {
    // A faithful transcript of the wrapper's guard from webgpu-renderer.ts
    // (`applyPreTransform`). Keeping it as a local helper means we can
    // exercise the contract without importing the full renderer module,
    // which isn't practical in a ts-node unit test.
    function applyGuardedPreTransform(
        device: MockGPUDevice | null,
        imageTexture: MockGPUTexture | null,
        matrix: PreTransformMatrix | undefined,
        cache = createPreTransformCache(),
    ): MockGPUTexture | null {
        if (!matrix || !device || !imageTexture) return imageTexture;
        const out = runPreTransform(
            device as any,
            imageTexture as any,
            matrix,
            cache,
        );
        return out as unknown as MockGPUTexture;
    }

    it('leaves the source texture untouched when matrix is undefined', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 32, height: 16, format: 'rgba32float' });
        const baselineShaders = device.createdShaderModules.length;
        const baselineBuffers = device.createdBuffers.length;
        const baselineSubmits = device.queue.submittedBuffers.length;

        const result = applyGuardedPreTransform(device, src, undefined);

        assert.equal(result, src, 'guard must return the same texture reference');
        assert.equal(device.createdShaderModules.length, baselineShaders);
        assert.equal(device.createdBuffers.length, baselineBuffers);
        assert.equal(device.queue.submittedBuffers.length, baselineSubmits);
    });

    it('leaves the source texture untouched when device is missing', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 4, height: 4, format: 'rgba32float' });

        const result = applyGuardedPreTransform(null, src, IDENTITY);

        assert.equal(result, src);
    });

    it('leaves no effect when imageTexture is missing', () => {
        const device = new MockGPUDevice();
        const baselineShaders = device.createdShaderModules.length;

        const result = applyGuardedPreTransform(device, null, IDENTITY);

        assert.equal(result, null);
        assert.equal(device.createdShaderModules.length, baselineShaders);
    });

    it('runs the transform when all three inputs are present', () => {
        // Sanity check on the guard helper itself — if this ever fails,
        // the previous no-op tests become meaningless.
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 4, height: 4, format: 'rgba32float' });

        const result = applyGuardedPreTransform(device, src, IDENTITY);

        assert.notEqual(result, src, 'with a matrix present, output must be a new texture');
        assert.equal(device.createdShaderModules.length, 1);
    });
});

describe('runPreTransform — dispatch edge cases', () => {
    it('handles 1×1 image (dispatches 1×1 workgroup, not 0)', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 1, height: 1, format: 'rgba32float' });

        let lastEncoder: any = null;
        const orig = device.createCommandEncoder.bind(device);
        (device as any).createCommandEncoder = () => {
            const enc = orig();
            lastEncoder = enc;
            return enc;
        };

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        const dispatch = lastEncoder.computePasses[0].dispatchCalls[0];
        assert.equal(dispatch.x, 1);
        assert.equal(dispatch.y, 1);
    });

    it('handles exactly-aligned dimensions (8×8) without over-padding dispatch', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 8, height: 8, format: 'rgba32float' });

        let lastEncoder: any = null;
        const orig = device.createCommandEncoder.bind(device);
        (device as any).createCommandEncoder = () => {
            const enc = orig();
            lastEncoder = enc;
            return enc;
        };

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        const dispatch = lastEncoder.computePasses[0].dispatchCalls[0];
        assert.equal(dispatch.x, 1);
        assert.equal(dispatch.y, 1);
    });

    it('handles a large image (1920×1080) with correct workgroup count', () => {
        const device = new MockGPUDevice();
        const src = makeSource(device, { width: 1920, height: 1080, format: 'rgba32float' });

        let lastEncoder: any = null;
        const orig = device.createCommandEncoder.bind(device);
        (device as any).createCommandEncoder = () => {
            const enc = orig();
            lastEncoder = enc;
            return enc;
        };

        runPreTransform(device as any, src as any, IDENTITY, createPreTransformCache());

        const dispatch = lastEncoder.computePasses[0].dispatchCalls[0];
        assert.equal(dispatch.x, Math.ceil(1920 / 8)); // 240
        assert.equal(dispatch.y, Math.ceil(1080 / 8)); // 135
    });
});
