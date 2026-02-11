/**
 * DCTL Export Shader Builder
 *
 * Builds a shader that applies only DCTL transform (no OCIO display transform).
 * Output is in ACES2065-1 (AP0) linear space, suitable for EXR export.
 */

import { getNagaProcessor } from '../naga/index.js';
import type { GpuTexture, GpuTexture3D } from '../ocio/types.js';
import type {
    DctlShaderInfo,
    DctlColorValue,
    TextureBinding,
} from '../types/index.js';
import { extractRgcGlslFunction } from './aces-rgc-shader-builder.js';
import { getDctlCompiler, isCompileError } from '../compiler/index.js';
import { buildExportShader } from './index.js';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
} from './glsl-utils.js';

export interface DctlExportShaderOptions {
    /** Current parameter values */
    paramValues?: Record<string, number | boolean | DctlColorValue>;
    /** Image width */
    imageWidth: number;
    /** Image height */
    imageHeight: number;
    /**
     * Apply ACES 2.0 Reference Gamut Compression (via OCIO).
     * Uses CAM16 JMh perceptual color space for compression.
     */
    applyACES2GamutCompression?: boolean;
    /**
     * Peak luminance for RGC (default: 100 nits for SDR).
     * Common values: 100 (SDR), 1000, 2000, 4000 (HDR)
     */
    peakLuminance?: number;
}

export interface DctlExportShaderResult {
    success: boolean;
    wgslCode: string;
    glslCode: string;
    /** RGC 2D LUT textures (when RGC is enabled) */
    rgcTextures?: GpuTexture[];
    /** RGC 3D LUT textures (when RGC is enabled) */
    rgcTextures3D?: GpuTexture3D[];
    /** Texture bindings for the shader */
    bindings: TextureBinding[];
    error?: string;
}

/**
 * Build a DCTL-only export shader (no OCIO display transform)
 *
 * Pipeline:
 * EXR (AP0 linear) → [ACES 2.0 RGC] → AP1 → [DCTL] → AP0 linear (for EXR export)
 *
 * Uses the working color space specified in dctlInfo.
 */
export async function buildDctlExportShader(
    wasmPath: string,
    dctlInfo: DctlShaderInfo,
    options: DctlExportShaderOptions
): Promise<DctlExportShaderResult> {
    const naga = getNagaProcessor();

    if (!naga.isInitialized) {
        await naga.init(wasmPath);
    }

    // Use the working color space from dctlInfo
    const workingColorSpace = dctlInfo.workingColorSpace;

    // Get DCTL compiler singleton (already initialized during preview)
    const compiler = getDctlCompiler();
    if (!compiler.isInitialized) {
        await compiler.init(wasmPath);
    }

    // Compile DCTL to WGSL
    const compileResult = compiler.compile(dctlInfo.source);

    if (isCompileError(compileResult)) {
        return {
            success: false,
            wgslCode: '',
            glslCode: '',
            bindings: [],
            error: `DCTL compilation failed: ${compileResult.message}`,
        };
    }

    // Initialize bindings with image texture/sampler
    let bindingIndex = 2; // Start after u_image_tex (0) and u_image_samp (1)
    const bindings: TextureBinding[] = [
        { binding: 0, type: 'texture2D', name: 'u_image_tex' },
        { binding: 1, type: 'sampler', name: 'u_image_samp' },
    ];

    // Extract ACES 2.0 RGC if enabled
    let rgcWgslCode = '';
    let rgcFunctionName = 'applyACES2RGC';
    let rgcTextures: GpuTexture[] = [];
    let rgcTextures3D: GpuTexture3D[] = [];

    if (options.applyACES2GamutCompression) {
        const peakLuminance = options.peakLuminance ?? 100;
        console.log(`[DCTL Export] Attempting to extract RGC GLSL (peakLuminance=${peakLuminance})`);
        const rgcResult = extractRgcGlslFunction(peakLuminance);

        if (rgcResult) {
            console.log(`[DCTL Export] RGC GLSL extracted successfully (${rgcResult.glsl.length} chars)`);
            console.log(`[DCTL Export] RGC textures: 2D=${rgcResult.textures.length}, 3D=${rgcResult.textures3D.length}`);

            rgcTextures = rgcResult.textures;
            rgcTextures3D = rgcResult.textures3D;

            // Process RGC GLSL code using shared utilities
            let rgcCode = rgcResult.glsl;
            rgcCode = fixGlslForNaga(rgcCode);

            // Rename OCIODisplay to applyACES2RGC
            rgcCode = rgcCode.replace(
                /vec4\s+(OCIODisplay|ocio_main|OCIOMain)\s*\(\s*vec4/g,
                'vec4 applyACES2RGC(vec4'
            );

            // Prefix all RGC helper functions with "rgc_"
            rgcCode = rgcCode.replace(/\b(ocio_[a-zA-Z0-9_]+)\s*\(/g, 'rgc_$1(');
            rgcCode = rgcCode.replace(/\b(ocio_[a-zA-Z0-9_]+_array)\b/g, 'rgc_$1');

            // Process sampler declarations using shared utility
            const samplerResult = processSamplerDeclarations(
                rgcCode,
                bindingIndex,
                { duplicateStrategy: 'remove', prefix: 'rgc_' }
            );
            rgcCode = samplerResult.code;
            bindingIndex = samplerResult.nextBindingIndex;

            // Add RGC bindings to the main bindings array
            for (const binding of samplerResult.bindings) {
                bindings.push({
                    ...binding,
                    originalName: `rgc:${binding.originalName || binding.name}`,
                });
            }

            // Replace texture() calls using shared utility
            rgcCode = replaceSamplerTextureCalls(rgcCode, samplerResult.declarations);

            // Build Vulkan GLSL wrapper for naga conversion
            const rgcGlslWrapper = `#version 450

${rgcCode}

layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = applyACES2RGC(vec4(v_texCoord, 0.0, 1.0));
}
`;

            console.log('[DCTL Export] Converting RGC GLSL to WGSL via naga...');
            const rgcConversion = naga.convertFragmentToWGSL(rgcGlslWrapper);

            if (rgcConversion.success) {
                console.log(`[DCTL Export] RGC WGSL conversion successful (${rgcConversion.wgsl.length} chars)`);

                // Extract just the RGC functions (remove entry point and I/O)
                // Use same pattern as compute path for consistency
                let rawWgsl = rgcConversion.wgsl;

                // Remove @fragment entry point and everything after
                const fragmentIdx = rawWgsl.indexOf('@fragment');
                if (fragmentIdx !== -1) {
                    rawWgsl = rawWgsl.substring(0, fragmentIdx);
                }

                rgcWgslCode = rawWgsl
                    .replace(/struct\s+FragmentOutput\s*\{[^}]*\}\s*/g, '')
                    .replace(/fn\s+main_1\s*\(\s*\)\s*\{[\s\S]*?\n\}\s*/g, '')
                    // Remove only fragment I/O var<private> declarations (not arrays/data)
                    // Use specific patterns matching compute path to avoid removing data arrays
                    .replace(/var<private>\s+(v_texCoord_?\d*|fragColor|gl_\w+)\s*:\s*[^;]+;/g, '')
                    .replace(/\n\s*\n\s*\n/g, '\n\n')
                    .trim();
            } else {
                console.error('[DCTL Export] RGC GLSL to WGSL conversion FAILED:', rgcConversion.error);
                console.error('[DCTL Export] Falling back to non-RGC export path');
            }
        } else {
            console.warn('[DCTL Export] extractRgcGlslFunction returned null - RGC will NOT be applied');
        }
    }

    // Use core's buildExportShader for consistent behavior
    const paramValues: Record<string, number | boolean> = {};
    if (options.paramValues) {
        for (const [key, value] of Object.entries(options.paramValues)) {
            if (typeof value === 'number' || typeof value === 'boolean') {
                paramValues[key] = value;
            }
        }
    }

    const shaderResult = buildExportShader(compileResult, {
        width: options.imageWidth,
        height: options.imageHeight,
        paramValues,
        workingColorSpace,
        applyRGC: !!rgcWgslCode,
        rgcWgslCode,
        rgcFunctionName,
    });

    return {
        success: true,
        wgslCode: shaderResult.wgsl,
        glslCode: '',
        rgcTextures: rgcTextures.length > 0 ? rgcTextures : undefined,
        rgcTextures3D: rgcTextures3D.length > 0 ? rgcTextures3D : undefined,
        bindings,
    };
}

