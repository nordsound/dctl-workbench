/**
 * ACES 2.0 Reference Gamut Compression (RGC) Shader Builder
 *
 * Extracts ACES 2.0 RGC as a GPU shader from OCIO WASM and converts to WGSL.
 * Uses the official OCIO implementation with RGB → JMh → Compress → JMh → RGB pipeline.
 */

import { OCIOProcessor } from '../ocio/index.js';
import type { GpuTexture, GpuTexture3D } from '../ocio/types.js';
import type { TextureBinding } from '../types/index.js';
import { buildWgslShader } from './ocio-wgsl-builder.js';
import { writeLog } from '../shared/logger.js';

export interface ACES2RgcShaderResult {
    /** WGSL shader code for RGC function */
    wgslCode: string;
    /** Original GLSL code */
    glslCode: string;
    /** 2D LUT textures */
    textures: GpuTexture[];
    /** 3D LUT textures */
    textures3D: GpuTexture3D[];
    /** Texture and sampler bindings */
    bindings: TextureBinding[];
    /** Success flag */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

/**
 * Build ACES 2.0 Reference Gamut Compression shader
 *
 * @param wasmPath Path to WASM modules
 * @param peakLuminance Peak luminance in nits (100 for SDR, 1000+ for HDR)
 * @returns WGSL shader with RGC function and required LUT textures
 */
export async function buildACES2RgcShader(
    wasmPath: string,
    peakLuminance: number = 100
): Promise<ACES2RgcShaderResult> {
    const processor = new OCIOProcessor();

    try {
        // Initialize OCIO config (required for processor)
        if (!processor.init()) {
            return {
                wgslCode: '',
                glslCode: '',
                textures: [],
                textures3D: [],
                bindings: [],
                success: false,
                error: `Failed to init OCIO: ${processor.getLastError()}`,
            };
        }

        // Setup ACES 2.0 RGC transform
        // This creates the RGB → JMh → Compress → JMh → RGB pipeline
        if (!processor.setupACES2GamutCompress(peakLuminance, false)) {
            return {
                wgslCode: '',
                glslCode: '',
                textures: [],
                textures3D: [],
                bindings: [],
                success: false,
                error: `Failed to setup RGC: ${processor.getLastError()}`,
            };
        }

        // Setup GPU processor
        if (!processor.setupGpuProcessor()) {
            return {
                wgslCode: '',
                glslCode: '',
                textures: [],
                textures3D: [],
                bindings: [],
                success: false,
                error: `Failed to setup GPU processor: ${processor.getLastError()}`,
            };
        }

        // Extract GPU shader info
        const shaderInfo = processor.extractGpuShaderInfo();

        // Debug: Log GLSL array declarations to understand the data types
        const glslArrayMatch = shaderInfo.shaderText.match(/const\s+float\s+\w+_hues_array\s*\[\s*\d+\s*\]/);
        if (glslArrayMatch) {
            writeLog(`[ACES2 RGC] GLSL hues_array declaration: ${glslArrayMatch[0]}`);
        }
        // Log first 500 chars of GLSL to see the structure
        writeLog(`[ACES2 RGC] GLSL preview (first 500 chars): ${shaderInfo.shaderText.substring(0, 500)}`);

        // Convert GLSL to WGSL using the existing builder
        const wgslResult = await buildWgslShader(wasmPath, shaderInfo);

        // Debug: Log RGC shader info
        writeLog(`[ACES2 RGC] GLSL length: ${shaderInfo.shaderText.length}`);
        writeLog(`[ACES2 RGC] WGSL success: ${wgslResult.success}`);
        writeLog(`[ACES2 RGC] WGSL length: ${wgslResult.wgslCode.length}`);
        writeLog(`[ACES2 RGC] Textures: 2D=${wgslResult.textures.length}, 3D=${wgslResult.textures3D.length}`);
        if (wgslResult.textures.length > 0) {
            writeLog(`[ACES2 RGC] 2D texture names: ${wgslResult.textures.map(t => t.samplerName).join(', ')}`);
        }
        if (wgslResult.textures3D.length > 0) {
            writeLog(`[ACES2 RGC] 3D texture names: ${wgslResult.textures3D.map(t => t.samplerName).join(', ')}`);
        }
        writeLog(`[ACES2 RGC] WGSL contains OCIODisplay: ${wgslResult.wgslCode.includes('OCIODisplay')}`);
        writeLog(`[ACES2 RGC] WGSL contains @fragment: ${wgslResult.wgslCode.includes('@fragment')}`);
        // Debug: Check WGSL array type after naga conversion
        const wgslArrayMatch = wgslResult.wgslCode.match(/var<private>\s+\w+_hues_array\s*:\s*array<([^,>]+)/);
        if (wgslArrayMatch) {
            writeLog(`[ACES2 RGC] WGSL hues_array type: array<${wgslArrayMatch[1]}> (expected f32, not i32)`);
        }
        // Log hues_array related code
        const huesArrayLines = wgslResult.wgslCode.split('\n').filter(line => line.includes('hues_array')).slice(0, 5);
        if (huesArrayLines.length > 0) {
            writeLog(`[ACES2 RGC] WGSL hues_array lines:\n${huesArrayLines.join('\n')}`);
        }
        if (!wgslResult.success) {
            writeLog(`[ACES2 RGC] Error: ${wgslResult.error}`);
        }

        // Deep-copy texture data before processor.dispose() frees WASM resources
        return {
            wgslCode: wgslResult.wgslCode,
            glslCode: wgslResult.glslCode,
            textures: wgslResult.textures.map((t: GpuTexture) => ({
                ...t,
                data: Array.from(t.data),
            })),
            textures3D: wgslResult.textures3D.map((t: GpuTexture3D) => ({
                ...t,
                data: Array.from(t.data),
            })),
            bindings: wgslResult.bindings,
            success: wgslResult.success,
            error: wgslResult.error,
        };
    } finally {
        processor.dispose();
    }
}

/**
 * Extract just the OCIO function from RGC shader for embedding in other shaders.
 *
 * The extracted GLSL function can be called as: vec4 result = OCIODisplay(inputColor);
 * Input/output is in AP1 linear color space.
 *
 * @param peakLuminance Peak luminance in nits
 * @returns GLSL shader info with RGC function
 */
export function extractRgcGlslFunction(
    peakLuminance: number = 100
): { glsl: string; textures: GpuTexture[]; textures3D: GpuTexture3D[] } | null {
    const processor = new OCIOProcessor();

    try {
        if (!processor.init()) {
            writeLog(`Failed to init OCIO: ${processor.getLastError()}`);
            return null;
        }

        if (!processor.setupACES2GamutCompress(peakLuminance, false)) {
            writeLog(`Failed to setup RGC: ${processor.getLastError()}`);
            return null;
        }

        if (!processor.setupGpuProcessor()) {
            writeLog(`Failed to setup GPU processor: ${processor.getLastError()}`);
            return null;
        }

        const shaderInfo = processor.extractGpuShaderInfo();

        // Deep-copy texture data for safety — ensures data survives after processor.dispose()
        // frees WASM resources (matches extractRgcShaderInfo pattern in ocio/index.ts)
        return {
            glsl: shaderInfo.shaderText,
            textures: shaderInfo.textures.map((t: GpuTexture) => ({
                ...t,
                data: Array.from(t.data),
            })),
            textures3D: shaderInfo.textures3D.map((t: GpuTexture3D) => ({
                ...t,
                data: Array.from(t.data),
            })),
        };
    } finally {
        processor.dispose();
    }
}

/**
 * Check if ACES 2.0 RGC is available in the current OCIO build
 */
export function isACES2RgcAvailable(): boolean {
    const processor = new OCIOProcessor();

    try {
        if (!processor.init()) {
            return false;
        }

        // Try to setup RGC - if it works, ACES 2.0 is available
        const result = processor.setupACES2GamutCompress(100, false);
        return result;
    } catch {
        return false;
    } finally {
        processor.dispose();
    }
}
