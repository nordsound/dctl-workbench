/**
 * OCIO GLSL to WGSL Shader Builder
 *
 * Converts OCIO-generated GLSL shaders to WebGPU WGSL format using naga.
 */

import { getNagaProcessor } from '../naga/index.js';
import type { GpuShaderInfo, GpuTexture, GpuTexture3D } from '../ocio/types.js';
import type { TextureBinding } from '../types/index.js';
import { buildOcioComputeShader } from './ocio-compute-wgsl-builder.js';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
    buildVulkanGlslPreamble,
    buildOcioMainFunction,
} from './glsl-utils.js';

export interface WgslShaderInfo {
    /** Complete WGSL fragment shader code */
    wgslCode: string;
    /** Complete WGSL compute shader code (for compute pipeline) */
    computeWgslCode?: string;
    /** Original GLSL code for fallback */
    glslCode: string;
    /** 2D textures (LUTs) */
    textures: GpuTexture[];
    /** 3D textures (LUTs) */
    textures3D: GpuTexture3D[];
    /** Texture and sampler bindings */
    bindings: TextureBinding[];
    /** Conversion success flag */
    success: boolean;
    /** Error message if conversion failed */
    error?: string;
}

/**
 * Build a complete WGSL fragment shader from OCIO GLSL shader info
 * Also builds compute shader WGSL for compute pipeline support
 */
export async function buildWgslShader(
    wasmPath: string,
    shaderInfo: GpuShaderInfo
): Promise<WgslShaderInfo> {
    const naga = getNagaProcessor();

    // Initialize naga if not already done
    if (!naga.isInitialized) {
        await naga.init(wasmPath);
    }

    // Build complete Vulkan GLSL 4.50 fragment shader
    const { glsl: completeGlsl, bindings } = buildVulkanGlslShader(shaderInfo);

    // Convert to WGSL using naga
    const conversionResult = naga.convertFragmentToWGSL(completeGlsl);

    if (!conversionResult.success) {
        console.error('GLSL to WGSL conversion failed:', conversionResult.error);
        return {
            wgslCode: '',
            glslCode: shaderInfo.shaderText,
            textures: shaderInfo.textures,
            textures3D: shaderInfo.textures3D,
            bindings: [],
            success: false,
            error: conversionResult.error,
        };
    }

    // Post-process WGSL to fix any issues
    const processedWgsl = postProcessWgsl(conversionResult.wgsl, shaderInfo);

    // Also build compute shader WGSL for compute pipeline support
    let computeWgslCode: string | undefined;
    try {
        const computeResult = await buildOcioComputeShader(wasmPath, shaderInfo);
        if (computeResult.success) {
            computeWgslCode = computeResult.computeWgsl;
            console.log('[OCIO] Compute shader WGSL generated successfully');
        } else {
            console.warn('[OCIO] Compute shader generation failed:', computeResult.error);
        }
    } catch (e) {
        console.warn('[OCIO] Compute shader generation error:', e);
    }

    return {
        wgslCode: processedWgsl,
        computeWgslCode,
        glslCode: shaderInfo.shaderText,
        textures: shaderInfo.textures,
        textures3D: shaderInfo.textures3D,
        bindings,
        success: true,
    };
}

/**
 * Build a complete Vulkan GLSL 4.50 fragment shader from OCIO shader code
 *
 * OCIO generates GLSL with combined texture samplers (uniform sampler2D xxx).
 * For naga to convert to WGSL, we need to:
 * 1. Use separated texture and sampler declarations with layout qualifiers
 * 2. Replace texture() calls with sampler2D(texture, sampler) constructor
 */
function buildVulkanGlslShader(shaderInfo: GpuShaderInfo): {
    glsl: string;
    bindings: TextureBinding[];
} {
    // Initial bindings for image texture
    const bindings: TextureBinding[] = [
        { binding: 0, type: 'texture2D', name: 'u_image_tex' },
        { binding: 1, type: 'sampler', name: 'u_image_samp' },
    ];

    // Apply GLSL fixes for naga compatibility
    let code = fixGlslForNaga(shaderInfo.shaderText);

    // Process sampler declarations (start after image texture bindings)
    const samplerResult = processSamplerDeclarations(code, 2);
    code = samplerResult.code;
    bindings.push(...samplerResult.bindings);

    // Replace texture() calls to use combined sampler constructor
    code = replaceSamplerTextureCalls(code, samplerResult.declarations);

    // Find the main OCIO function name
    const ocioMainFunc = findOcioMainFunction(code);

    // Build complete Vulkan GLSL 4.50 shader
    const preamble = buildVulkanGlslPreamble();
    const mainFunc = buildOcioMainFunction(ocioMainFunc);

    const completeGlsl = `${preamble}// OCIO Generated Code
${code}
${mainFunc}`;

    return { glsl: completeGlsl, bindings };
}

/**
 * Post-process WGSL output from naga
 */
function postProcessWgsl(wgslCode: string, shaderInfo: GpuShaderInfo): string {
    let processed = wgslCode;

    // Naga may generate different variable names, we might need to adjust
    // For now, pass through as-is since naga handles most conversions

    return processed;
}

/**
 * Create a fallback WGSL shader (no color transform)
 */
export function createFallbackWgslShader(): string {
    return `
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoord: vec2<f32>,
}

@fragment
fn main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(u_image_tex, u_image_samp, in.texCoord);
    return clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
}
`;
}
