/**
 * Texture Utilities
 *
 * Shared utilities for WebGPU texture creation and management.
 * Used by webgpu-renderer.ts and compute-pipeline.ts.
 */

import type { GpuTexture, GpuTexture3D } from '@dctl-workbench/core';

/**
 * Sampler configuration constants
 */
export const SAMPLER_CONFIG = {
    /** Standard filtering sampler (for OCIO LUTs with interpolation) */
    filtering: {
        magFilter: 'linear' as GPUFilterMode,
        minFilter: 'linear' as GPUFilterMode,
        addressModeU: 'clamp-to-edge' as GPUAddressMode,
        addressModeV: 'clamp-to-edge' as GPUAddressMode,
        addressModeW: 'clamp-to-edge' as GPUAddressMode,
    },
    /** Nearest-neighbor sampler (for pixel-exact sampling) */
    nearest: {
        magFilter: 'nearest' as GPUFilterMode,
        minFilter: 'nearest' as GPUFilterMode,
        addressModeU: 'clamp-to-edge' as GPUAddressMode,
        addressModeV: 'clamp-to-edge' as GPUAddressMode,
        addressModeW: 'clamp-to-edge' as GPUAddressMode,
    },
} as const;

/**
 * Options for texture creation
 */
export interface TextureCreateOptions {
    /** Optional label for debugging */
    label?: string;
    /** Additional GPU texture usage flags */
    additionalUsage?: GPUTextureUsageFlags;
}

/**
 * Result of 2D texture creation
 */
export interface Texture2DResult {
    texture: GPUTexture;
    format: GPUTextureFormat;
}

/**
 * Result of 3D texture creation
 */
export interface Texture3DResult {
    texture: GPUTexture;
    format: GPUTextureFormat;
}

/**
 * Convert RGB Float32Array to RGBA Float32Array
 * Adds alpha = 1.0 to each pixel
 *
 * @param rgbData - RGB data (3 floats per pixel)
 * @param numPixels - Number of pixels
 * @returns RGBA data (4 floats per pixel)
 */
export function convertRgbToRgba(rgbData: Float32Array, numPixels: number): Float32Array {
    const rgbaData = new Float32Array(numPixels * 4);
    let srcIdx = 0;
    let dstIdx = 0;
    for (let i = 0; i < numPixels; i++) {
        rgbaData[dstIdx++] = rgbData[srcIdx++];
        rgbaData[dstIdx++] = rgbData[srcIdx++];
        rgbaData[dstIdx++] = rgbData[srcIdx++];
        rgbaData[dstIdx++] = 1.0;
    }
    return rgbaData;
}

/**
 * Create a 2D GPU texture from GpuTexture data
 *
 * Handles both single-channel (r32float) and RGB->RGBA conversion.
 *
 * @param device - WebGPU device
 * @param tex - GpuTexture data from OCIO
 * @param options - Optional texture creation options
 * @returns Created texture and format, or null on failure
 */
export function create2DTexture(
    device: GPUDevice,
    tex: GpuTexture,
    options: TextureCreateOptions = {}
): Texture2DResult | null {
    const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
    const numPixels = tex.width * tex.height;

    let uploadData: Float32Array;
    let format: GPUTextureFormat;
    let bytesPerPixel: number;

    if (tex.channel === 0) {
        // Single channel -> use r32float
        format = 'r32float';
        uploadData = data;
        bytesPerPixel = 4;
    } else {
        // RGB -> RGBA
        format = 'rgba32float';
        uploadData = convertRgbToRgba(data, numPixels);
        bytesPerPixel = 16;
    }

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        (options.additionalUsage ?? 0);

    const texture = device.createTexture({
        label: options.label ?? `OCIO LUT 2D: ${tex.samplerName}`,
        size: [tex.width, tex.height],
        format,
        usage,
    });

    device.queue.writeTexture(
        { texture },
        uploadData,
        { bytesPerRow: tex.width * bytesPerPixel },
        [tex.width, tex.height]
    );

    return { texture, format };
}

/**
 * Create a 3D GPU texture from GpuTexture3D data
 *
 * Always converts RGB to RGBA for WebGPU compatibility.
 *
 * @param device - WebGPU device
 * @param tex - GpuTexture3D data from OCIO
 * @param options - Optional texture creation options
 * @returns Created texture and format, or null on failure
 */
export function create3DTexture(
    device: GPUDevice,
    tex: GpuTexture3D,
    options: TextureCreateOptions = {}
): Texture3DResult | null {
    const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);
    const size = tex.edgeLen;
    const numVoxels = size * size * size;

    // Convert RGB to RGBA
    const rgbaData = convertRgbToRgba(data, numVoxels);

    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        (options.additionalUsage ?? 0);

    const texture = device.createTexture({
        label: options.label ?? `OCIO LUT 3D: ${tex.samplerName}`,
        size: [size, size, size],
        dimension: '3d',
        format: 'rgba32float',
        usage,
    });

    device.queue.writeTexture(
        { texture },
        rgbaData,
        { bytesPerRow: size * 16, rowsPerImage: size },
        [size, size, size]
    );

    return { texture, format: 'rgba32float' };
}

/**
 * Create a filtering sampler for OCIO LUT textures
 *
 * @param device - WebGPU device
 * @param label - Optional label for debugging
 * @returns Created sampler
 */
export function createFilteringSampler(device: GPUDevice, label?: string): GPUSampler {
    return device.createSampler({
        label: label ?? 'OCIO LUT Sampler',
        ...SAMPLER_CONFIG.filtering,
    });
}

/**
 * Create a nearest-neighbor sampler
 *
 * @param device - WebGPU device
 * @param label - Optional label for debugging
 * @returns Created sampler
 */
export function createNearestSampler(device: GPUDevice, label?: string): GPUSampler {
    return device.createSampler({
        label: label ?? 'Nearest Sampler',
        ...SAMPLER_CONFIG.nearest,
    });
}

/**
 * Select the appropriate sampler for a texture based on its format and
 * the device's float32-filterable capability.
 *
 * r32float textures require the 'float32-filterable' GPU feature to use
 * linear filtering. Without this feature, using a filtering sampler causes
 * a silent WebGPU validation error — the texture returns zero values,
 * which makes RGC become an identity transform (no compression).
 *
 * @param format - The GPU texture format (e.g. 'r32float', 'rgba32float')
 * @param hasFloat32Filterable - Whether the device supports 'float32-filterable'
 * @param filteringSampler - The linear filtering sampler
 * @param nearestSampler - The nearest-neighbor sampler (fallback)
 * @returns The appropriate sampler for this texture format
 */
export function selectSamplerForFormat(
    format: GPUTextureFormat,
    hasFloat32Filterable: boolean,
    filteringSampler: GPUSampler,
    nearestSampler: GPUSampler,
): GPUSampler {
    if (format === 'r32float' && !hasFloat32Filterable) {
        return nearestSampler;
    }
    return filteringSampler;
}
