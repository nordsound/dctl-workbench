/**
 * GPU Worker - Runs WebGPU in isolation
 *
 * This script is designed to be run as a subprocess to avoid
 * conflicts between WebGPU native bindings and WASM modules.
 *
 * Supports:
 * - Buffer-based compute shaders (original)
 * - Texture-based compute shaders with RGC LUT support
 */

import { create, globals } from 'webgpu';
import * as fs from 'fs';

// WebGPU constants
const GPUMapMode = (globals as any).GPUMapMode ?? {
    READ: 0x0001,
    WRITE: 0x0002,
};

const GPUTextureUsage = (globals as any).GPUTextureUsage ?? {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
};

const GPUBufferUsage = (globals as any).GPUBufferUsage ?? {
    MAP_READ: 0x01,
    MAP_WRITE: 0x02,
    COPY_SRC: 0x04,
    COPY_DST: 0x08,
    INDEX: 0x10,
    VERTEX: 0x20,
    UNIFORM: 0x40,
    STORAGE: 0x80,
    INDIRECT: 0x100,
    QUERY_RESOLVE: 0x200,
};

interface TextureInfo {
    name: string;
    type: '2d' | '3d';
    width: number;
    height: number;
    depth?: number;
    /** Number of channels: 1 for single-channel (R), 3 for RGB */
    channels: number;
    dataPath: string;
}

/**
 * Convert float32 to float16 (IEEE 754 half-precision)
 */
function floatToHalf(value: number): number {
    const floatView = new Float32Array(1);
    const int32View = new Int32Array(floatView.buffer);

    floatView[0] = value;
    const x = int32View[0];

    // Extract sign, exponent, and mantissa
    const sign = (x >> 31) & 0x1;
    const exp = (x >> 23) & 0xff;
    const mant = x & 0x7fffff;

    let h_sign = sign << 15;

    if (exp === 0) {
        // Zero or denormal
        return h_sign;
    } else if (exp === 0xff) {
        // Inf or NaN
        if (mant === 0) {
            return h_sign | 0x7c00; // Inf
        } else {
            return h_sign | 0x7c00 | (mant >> 13); // NaN
        }
    }

    // Normalized number
    let newExp = exp - 127 + 15;
    let newMant = mant >> 13;

    if (newExp >= 31) {
        // Overflow -> Inf
        return h_sign | 0x7c00;
    } else if (newExp <= 0) {
        // Underflow -> Zero or denormal
        if (newExp < -10) {
            return h_sign;
        }
        // Denormal
        newMant = (mant | 0x800000) >> (1 - newExp + 13);
        return h_sign | newMant;
    }

    return h_sign | (newExp << 10) | newMant;
}

interface RenderRequest {
    shaderPath: string;
    inputPath: string;
    outputPath: string;
    width: number;
    height: number;
    // Optional: RGC texture data
    rgcTextures?: TextureInfo[];
    // Flag to indicate if we're using texture-based pipeline
    useTextures?: boolean;
}

async function main() {
    // Read request from stdin
    const stdinData = fs.readFileSync(0, 'utf-8');
    const request: RenderRequest = JSON.parse(stdinData);

    // Read shader
    const shader = fs.readFileSync(request.shaderPath, 'utf-8');

    // Read input data
    const inputBuffer = fs.readFileSync(request.inputPath);
    const inputData = new Float32Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 4);

    // Initialize WebGPU
    const gpu = create([]);
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
        throw new Error('WebGPU adapter not available');
    }

    const device = await adapter.requestDevice({
        requiredLimits: {
            maxStorageBufferBindingSize: 1024 * 1024 * 1024,
            maxBufferSize: 1024 * 1024 * 1024,
        },
    });

    // Create shader module
    const shaderModule = device.createShaderModule({ code: shader });
    const compilationInfo = await shaderModule.getCompilationInfo();
    const errors = compilationInfo.messages.filter((m: any) => m.type === 'error');
    if (errors.length > 0) {
        throw new Error(`Shader errors: ${errors.map((e: any) => e.message).join('\n')}`);
    }

    let outputData: Float32Array;

    if (request.useTextures && request.rgcTextures && request.rgcTextures.length > 0) {
        // Texture-based pipeline with RGC
        outputData = await runTextureBasedPipeline(
            device,
            shaderModule,
            inputData,
            request.width,
            request.height,
            request.rgcTextures
        );
    } else {
        // Buffer-based pipeline (original)
        outputData = await runBufferBasedPipeline(
            device,
            shaderModule,
            inputData,
            request.width,
            request.height
        );
    }

    // Write output
    fs.writeFileSync(request.outputPath, Buffer.from(outputData.buffer));

    console.log(JSON.stringify({ success: true, size: outputData.length }));
}

/**
 * Original buffer-based pipeline
 */
async function runBufferBasedPipeline(
    device: GPUDevice,
    shaderModule: GPUShaderModule,
    inputData: Float32Array,
    width: number,
    height: number
): Promise<Float32Array> {
    const channels = 3;
    const pixelCount = width * height;
    const bufferSize = pixelCount * channels * 4;

    const gpuInputBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const gpuOutputBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const stagingBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(gpuInputBuffer, 0, inputData);

    const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: gpuInputBuffer } },
            { binding: 1, resource: { buffer: gpuOutputBuffer } },
        ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(gpuOutputBuffer, 0, stagingBuffer, 0, bufferSize);
    device.queue.submit([encoder.finish()]);

    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const outputData = new Float32Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();

    gpuInputBuffer.destroy();
    gpuOutputBuffer.destroy();
    stagingBuffer.destroy();

    return outputData;
}

/**
 * Texture-based pipeline with RGC LUT support
 *
 * Bind group layout:
 * - Group 0: Input/output buffers (same as buffer pipeline)
 * - Group 1: RGC LUT textures and samplers
 */
async function runTextureBasedPipeline(
    device: GPUDevice,
    shaderModule: GPUShaderModule,
    inputData: Float32Array,
    width: number,
    height: number,
    rgcTextures: TextureInfo[]
): Promise<Float32Array> {
    const channels = 3;
    const pixelCount = width * height;
    const bufferSize = pixelCount * channels * 4;

    // Create input/output buffers (Group 0)
    const gpuInputBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const gpuOutputBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const stagingBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(gpuInputBuffer, 0, inputData);

    // Create RGC textures and samplers (Group 1)
    const textureResources: Array<{ texture: GPUTexture; sampler: GPUSampler }> = [];

    for (const texInfo of rgcTextures) {
        // Read texture data
        const texDataBuffer = fs.readFileSync(texInfo.dataPath);
        const texData = new Float32Array(texDataBuffer.buffer, texDataBuffer.byteOffset, texDataBuffer.length / 4);

        if (texInfo.type === '3d') {
            // 3D texture - use rgba16float for filtering support
            const size = texInfo.width;
            const texture = device.createTexture({
                size: [size, size, size],
                format: 'rgba16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                dimension: '3d',
            });

            // Convert RGB float32 to RGBA float16
            // JavaScript doesn't have Float16Array, so we use Uint16Array with manual conversion
            const rgbaData = new Uint16Array(size * size * size * 4);
            for (let i = 0; i < size * size * size; i++) {
                rgbaData[i * 4] = floatToHalf(texData[i * 3]);
                rgbaData[i * 4 + 1] = floatToHalf(texData[i * 3 + 1]);
                rgbaData[i * 4 + 2] = floatToHalf(texData[i * 3 + 2]);
                rgbaData[i * 4 + 3] = floatToHalf(1.0);
            }

            device.queue.writeTexture(
                { texture },
                rgbaData,
                { bytesPerRow: size * 4 * 2, rowsPerImage: size },
                [size, size, size]
            );

            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
                addressModeW: 'clamp-to-edge',
            });

            textureResources.push({ texture, sampler });
        } else {
            // 2D texture - use rgba16float for filtering support
            const texture = device.createTexture({
                size: [texInfo.width, texInfo.height],
                format: 'rgba16float',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });

            // Convert to RGBA float16 based on number of channels
            const pixelCount = texInfo.width * texInfo.height;
            const rgbaData = new Uint16Array(pixelCount * 4);
            const numChannels = texInfo.channels || 3; // Default to RGB if not specified

            if (numChannels === 1) {
                // Single channel (R) - replicate to all channels for proper sampling
                for (let i = 0; i < pixelCount; i++) {
                    const r = floatToHalf(texData[i]);
                    rgbaData[i * 4] = r;
                    rgbaData[i * 4 + 1] = r;
                    rgbaData[i * 4 + 2] = r;
                    rgbaData[i * 4 + 3] = floatToHalf(1.0);
                }
            } else {
                // RGB - convert to RGBA
                for (let i = 0; i < pixelCount; i++) {
                    rgbaData[i * 4] = floatToHalf(texData[i * 3]);
                    rgbaData[i * 4 + 1] = floatToHalf(texData[i * 3 + 1]);
                    rgbaData[i * 4 + 2] = floatToHalf(texData[i * 3 + 2]);
                    rgbaData[i * 4 + 3] = floatToHalf(1.0);
                }
            }

            device.queue.writeTexture(
                { texture },
                rgbaData,
                { bytesPerRow: texInfo.width * 4 * 2 },
                [texInfo.width, texInfo.height]
            );

            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });

            textureResources.push({ texture, sampler });
        }
    }

    // Create pipeline
    const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
            module: shaderModule,
            entryPoint: 'main',
        },
    });

    // Create bind group 0 (buffers)
    const bindGroup0 = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: gpuInputBuffer } },
            { binding: 1, resource: { buffer: gpuOutputBuffer } },
        ],
    });

    // Create bind group 1 (RGC textures) if we have textures
    let bindGroup1: GPUBindGroup | null = null;
    if (textureResources.length > 0) {
        const entries: GPUBindGroupEntry[] = [];
        let bindingIndex = 0;

        for (const res of textureResources) {
            entries.push({ binding: bindingIndex++, resource: res.texture.createView() });
            entries.push({ binding: bindingIndex++, resource: res.sampler });
        }

        bindGroup1 = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(1),
            entries,
        });
    }

    // Log texture info for debugging
    console.error(`[GPU] Texture pipeline: ${textureResources.length} textures, dispatch ${Math.ceil(width / 8)}x${Math.ceil(height / 8)}`);

    // Execute with error scope
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup0);
    if (bindGroup1) {
        pass.setBindGroup(1, bindGroup1);
    }
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(gpuOutputBuffer, 0, stagingBuffer, 0, bufferSize);
    device.queue.submit([encoder.finish()]);

    const gpuError = await device.popErrorScope();
    if (gpuError) {
        console.error(`[GPU] Validation error: ${gpuError.message}`);
    }

    // Read results
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const outputData = new Float32Array(stagingBuffer.getMappedRange().slice(0));
    stagingBuffer.unmap();

    // Cleanup
    gpuInputBuffer.destroy();
    gpuOutputBuffer.destroy();
    stagingBuffer.destroy();
    for (const res of textureResources) {
        res.texture.destroy();
    }

    return outputData;
}

main().catch(err => {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
});
