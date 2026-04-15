/**
 * Executor for the pre-transform compute pass.
 *
 * The renderer owns a long-lived cache (compiled pipeline + uniform buffer)
 * and a short-lived state (current source texture). This module extracts
 * the "run one compute pass" logic into a pure function so tests can drive
 * it with a mock GPUDevice without pulling in the whole WebGPURenderer
 * module graph.
 */

import {
    buildPreTransformWGSL,
    PRE_TRANSFORM_WORKGROUP_SIZE,
    type PreTransformInputFormat,
} from './pre-transform-shader';
import {
    encodeMat3ForWgslUniform,
    MAT3X3_UNIFORM_BYTE_SIZE,
} from './matrix-encoding';

export type PreTransformMatrix = readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number]
];

/**
 * Per-renderer cache shared across `runPreTransform` calls. Keyed by the
 * source texture's format so rgba16unorm and rgba32float inputs reuse
 * independent pipelines.
 */
export interface PreTransformCache {
    pipelines: Map<PreTransformInputFormat, GPUComputePipeline>;
    uniformBuffer: GPUBuffer | null;
}

export function createPreTransformCache(): PreTransformCache {
    return { pipelines: new Map(), uniformBuffer: null };
}

/**
 * Execute one pre-transform compute pass. Returns a fresh rgba32float
 * texture carrying the matrix-transformed pixels. The caller is responsible
 * for destroying the previous source texture (the renderer swaps first,
 * destroys last to avoid a stale reference inside this function).
 *
 * The function mutates `cache` to memoize the pipeline and uniform buffer.
 */
export function runPreTransform(
    device: GPUDevice,
    source: GPUTexture,
    matrix: PreTransformMatrix,
    cache: PreTransformCache,
): GPUTexture {
    const inputFormat: PreTransformInputFormat =
        source.format === 'rgba16unorm' ? 'rgba16unorm' : 'rgba32float';

    // --- Pipeline (shader module is created only on first use per format) ---
    let pipeline = cache.pipelines.get(inputFormat);
    if (!pipeline) {
        const module = device.createShaderModule({
            code: buildPreTransformWGSL({ inputFormat }),
            label: `pre-transform (${inputFormat})`,
        });
        pipeline = device.createComputePipeline({
            label: `pre-transform pipeline (${inputFormat})`,
            layout: 'auto',
            compute: { module, entryPoint: 'apply_pre_transform' },
        });
        cache.pipelines.set(inputFormat, pipeline);
    }

    // --- Uniform buffer (reused across calls; written fresh each time) ---
    if (!cache.uniformBuffer) {
        cache.uniformBuffer = device.createBuffer({
            label: 'pre-transform matrix uniform',
            size: MAT3X3_UNIFORM_BYTE_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }
    device.queue.writeBuffer(
        cache.uniformBuffer,
        0,
        encodeMat3ForWgslUniform(matrix),
    );

    // --- Fresh rgba32float intermediate the compute pass can store into ---
    const output = device.createTexture({
        label: 'pre-transform output (rgba32float)',
        // Object form is equivalent to `[w, h]` per the WebGPU spec; we use
        // it so both real devices and the mock (which only handles the
        // dict form) see identical output dimensions.
        size: { width: source.width, height: source.height },
        format: 'rgba32float',
        usage:
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: source.createView() },
            { binding: 1, resource: output.createView() },
            { binding: 2, resource: { buffer: cache.uniformBuffer } },
        ],
    });

    const encoder = device.createCommandEncoder({ label: 'pre-transform pass' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
        Math.ceil(source.width / PRE_TRANSFORM_WORKGROUP_SIZE),
        Math.ceil(source.height / PRE_TRANSFORM_WORKGROUP_SIZE),
    );
    pass.end();
    device.queue.submit([encoder.finish()]);

    return output;
}
