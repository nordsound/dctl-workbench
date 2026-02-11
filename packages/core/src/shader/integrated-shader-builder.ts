/**
 * Integrated Shader Builder
 *
 * Combines DCTL and OCIO into a unified shader pipeline.
 * Supports both WebGPU (WGSL) and WebGL2 (GLSL) outputs.
 */

import { getNagaProcessor } from '../naga/index.js';
import type { GpuShaderInfo, GpuTexture, GpuTexture3D } from '../ocio/types.js';
import type { DctlShaderInfo, DctlParam, DctlColorValue, TextureBinding } from '../types/index.js';
import {
    buildDctlShaderCode,
    getDctlDefaultUniforms,
    buildDctlShaderCodeWithUniformBuffer,
    ShaderParamMapping,
} from './dctl-shader-builder.js';
import type { WgslShaderInfo } from './ocio-wgsl-builder.js';
import { extractRgcGlslFunction, buildACES2RgcShader, type ACES2RgcShaderResult } from './aces-rgc-shader-builder.js';
import { buildOcioComputeShader } from './ocio-compute-wgsl-builder.js';
import { buildDctlComputeShader, type DctlComputeShaderInfo } from './dctl-compute-wgsl-builder.js';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
    type SamplerDeclaration,
} from './glsl-utils.js';
import { writeLog } from '../shared/logger.js';

/**
 * Extended shader info with DCTL support
 */
export interface IntegratedShaderInfo extends WgslShaderInfo {
    /** DCTL shader info (if present) */
    dctlInfo?: DctlShaderInfo;
    /** DCTL uniform bindings */
    dctlBindings?: DctlUniformBinding[];
    /** Default DCTL uniform values */
    dctlDefaults?: Record<string, number | boolean | DctlColorValue>;
    /** RGC texture bindings (from ACES 2.0 RGC) */
    rgcTextures?: GpuTexture[];
    /** RGC 3D texture bindings */
    rgcTextures3D?: GpuTexture3D[];
    /** Parameter mapping for uniform buffer mode */
    paramMapping?: ShaderParamMapping[];
    /** Whether uniform buffer mode is used */
    useUniformBuffer?: boolean;
    /** Uniform buffer binding index (when useUniformBuffer is true) */
    uniformBufferBinding?: number;
    /** DCTL + OCIO compute shader info (for compute pipeline with DCTL support) */
    dctlComputeShaderInfo?: DctlComputeShaderInfo;
}

/**
 * DCTL uniform binding information
 */
export interface DctlUniformBinding {
    /** Uniform name (with prefix) */
    name: string;
    /** Uniform type */
    type: 'float' | 'int' | 'bool' | 'vec3';
    /** Original parameter name */
    paramName: string;
    /** Default value */
    default: number | boolean | DctlColorValue;
}

/**
 * DCTL build options for integrated shader
 */
export interface DctlBuildOptions {
    /** Current parameter values (bakes as constants if provided, ignored if useUniformBuffer is true) */
    paramValues?: Record<string, number | boolean | DctlColorValue>;
    /** Whether DCTL is enabled */
    enabled?: boolean;
    /** Image width for DCTL built-in p_Width */
    imageWidth?: number;
    /** Image height for DCTL built-in p_Height */
    imageHeight?: number;
    /** Apply ACES 2.0 Reference Gamut Compression before DCTL (OCIO-based) */
    applyACES2GamutCompression?: boolean;
    /** Peak luminance for RGC (default: 100 nits for SDR) */
    peakLuminance?: number;
    /** Enable Zone System overlay (GPU-accelerated) */
    zoneSystemEnabled?: boolean;
    /**
     * Use uniform buffer for DCTL parameters (fast path)
     * When true, parameters are read from a uniform buffer instead of being baked as constants.
     * This allows fast parameter updates without shader recompilation.
     */
    useUniformBuffer?: boolean;
    /**
     * Use Rust WASM compiler for DCTL → WGSL conversion (compute shader only)
     * When true, bypasses TypeScript transpiler + Naga and uses direct Rust compilation.
     * Provides better type handling and higher success rate (96.5%).
     * Requires dctlSource to be provided.
     */
    useRustCompiler?: boolean;
    /**
     * Raw DCTL source code (required when useRustCompiler is true)
     */
    dctlSource?: string;
    /**
     * File path for DCTL (used for #include resolution)
     */
    dctlFilePath?: string;
}

/**
 * Build integrated shader with DCTL and OCIO
 *
 * @param extensionPath - Path to extension (for naga)
 * @param ocioShaderInfo - OCIO shader info
 * @param dctlInfo - Optional DCTL shader info
 * @param dctlOptions - Optional DCTL build options (param values, enabled state)
 * @returns Integrated shader info
 */
export async function buildIntegratedShader(
    extensionPath: string,
    ocioShaderInfo: GpuShaderInfo,
    dctlInfo?: DctlShaderInfo,
    dctlOptions?: DctlBuildOptions
): Promise<IntegratedShaderInfo> {
    const naga = getNagaProcessor();

    // Initialize naga if not already done
    if (!naga.isInitialized) {
        await naga.init(extensionPath);
    }

    // When using Rust compiler, skip GLSL/Fragment Shader build and use only Compute Pipeline
    const useRustCompiler = dctlOptions?.useRustCompiler ?? false;

    // Fragment shader build (WebGL fallback) - skip when using Rust compiler
    let fragmentWgslCode: string | undefined;
    let glslCode: string | undefined;
    let bindings: TextureBinding[] = [];
    let dctlBindings: DctlUniformBinding[] | undefined;
    let dctlDefaults: Record<string, number | boolean | DctlColorValue> | undefined;
    let rgcTextures: GpuTexture[] | undefined;
    let rgcTextures3D: GpuTexture3D[] | undefined;
    let paramMapping: ShaderParamMapping[] | undefined;
    let uniformBufferBinding: number | undefined;

    if (!useRustCompiler) {
        // Build the integrated GLSL shader
        const glslResult = buildIntegratedGlsl(
            ocioShaderInfo,
            dctlInfo,
            dctlOptions
        );

        glslCode = glslResult.glsl;
        bindings = glslResult.bindings;
        dctlBindings = glslResult.dctlBindings;
        dctlDefaults = glslResult.dctlDefaults;
        rgcTextures = glslResult.rgcTextures;
        rgcTextures3D = glslResult.rgcTextures3D;
        paramMapping = glslResult.paramMapping;
        uniformBufferBinding = glslResult.uniformBufferBinding;

        // Convert to WGSL using naga
        const conversionResult = naga.convertFragmentToWGSL(glslCode);

        if (!conversionResult.success) {
            console.error('GLSL to WGSL conversion failed:', conversionResult.error);
            return {
                wgslCode: '',
                glslCode,
                textures: ocioShaderInfo.textures,
                textures3D: ocioShaderInfo.textures3D,
                bindings: [],
                success: false,
                error: conversionResult.error,
                dctlInfo,
                rgcTextures,
                rgcTextures3D,
            };
        }

        fragmentWgslCode = conversionResult.wgsl;
    } else {
        const msg = '[Integrated] Using Rust compiler - skipping Fragment Shader (GLSL) build';
        console.log(msg);
        writeLog(msg);
    }

    // Build compute shader WGSL for compute pipeline support
    let computeWgslCode: string | undefined;
    let dctlComputeShaderInfo: DctlComputeShaderInfo | undefined;

    try {
        if (dctlInfo && (dctlOptions?.enabled ?? true)) {
            // Debug: Log Rust compiler options
            const optMsg = `[Integrated] useRustCompiler=${dctlOptions?.useRustCompiler}, dctlSource=${dctlOptions?.dctlSource ? 'exists' : 'undefined'}`;
            console.log(optMsg);
            writeLog(optMsg);

            // Get RGC shader info when RGC is enabled
            let rgcShaderInfo: ACES2RgcShaderResult | undefined;
            if (dctlOptions?.applyACES2GamutCompression) {
                const rgcMsg = `[Integrated] Building RGC shader for DCTL+OCIO (peak=${dctlOptions?.peakLuminance ?? 100})`;
                console.log(rgcMsg);
                writeLog(rgcMsg);
                try {
                    rgcShaderInfo = await buildACES2RgcShader(extensionPath, dctlOptions?.peakLuminance ?? 100);
                    const resultMsg = `[Integrated] RGC shader build result: success=${rgcShaderInfo.success}, wgslLength=${rgcShaderInfo.wgslCode.length}, textures2D=${rgcShaderInfo.textures.length}, textures3D=${rgcShaderInfo.textures3D.length}`;
                    console.log(resultMsg);
                    writeLog(resultMsg);
                    if (!rgcShaderInfo.success) {
                        console.warn('[Integrated] RGC shader build failed:', rgcShaderInfo.error);
                        writeLog(`[Integrated] RGC shader build failed: ${rgcShaderInfo.error}`);
                    }
                } catch (err) {
                    console.warn('[Integrated] RGC shader build error:', err);
                    writeLog(`[Integrated] RGC shader build error: ${err}`);
                }
            } else {
                writeLog(`[Integrated] RGC not requested (applyACES2GamutCompression=${dctlOptions?.applyACES2GamutCompression})`);
            }

            // Log what's being passed to buildDctlComputeShader
            const passRgc = dctlOptions?.applyACES2GamutCompression && rgcShaderInfo?.success;
            writeLog(`[Integrated] Passing to buildDctlComputeShader: applyRGC=${passRgc}, rgcShaderInfo=${rgcShaderInfo?.success ? 'valid' : 'undefined/failed'}`);

            // Build DCTL + OCIO compute shader
            const dctlComputeResult = await buildDctlComputeShader(
                extensionPath,
                ocioShaderInfo,
                dctlInfo,
                {
                    enabled: dctlOptions?.enabled ?? true,
                    workingColorSpace: dctlInfo.workingColorSpace,
                    paramValues: dctlOptions?.paramValues,
                    // Pass Rust compiler options if available
                    useRustCompiler: dctlOptions?.useRustCompiler,
                    dctlSource: dctlOptions?.dctlSource,
                    dctlFilePath: dctlOptions?.dctlFilePath,
                    // Pass uniform buffer flag
                    useUniformBuffer: dctlOptions?.useUniformBuffer,
                    // Pass RGC options (requires rgcShaderInfo when enabled)
                    applyACES2GamutCompression: dctlOptions?.applyACES2GamutCompression && rgcShaderInfo?.success,
                    peakLuminance: dctlOptions?.peakLuminance,
                    rgcShaderInfo: rgcShaderInfo?.success ? rgcShaderInfo : undefined,
                }
            );

            if (dctlComputeResult.success) {
                computeWgslCode = dctlComputeResult.computeWgsl;
                dctlComputeShaderInfo = dctlComputeResult;
                const successMsg = `[Integrated] DCTL+OCIO compute shader WGSL generated successfully (hasDctl=${dctlComputeResult.hasDctl})`;
                console.log(successMsg);
                writeLog(successMsg);
            } else {
                const failMsg = `[Integrated] DCTL+OCIO compute shader generation failed: ${dctlComputeResult.error}`;
                console.warn(failMsg);
                writeLog(failMsg);
                // Fallback to OCIO-only
                const ocioComputeResult = await buildOcioComputeShader(extensionPath, ocioShaderInfo);
                if (ocioComputeResult.success) {
                    computeWgslCode = ocioComputeResult.computeWgsl;
                    const fallbackMsg = '[Integrated] Fallback to OCIO-only compute shader';
                    console.log(fallbackMsg);
                    writeLog(fallbackMsg);
                }
            }
        } else {
            // No DCTL - check if RGC is enabled
            if (dctlOptions?.applyACES2GamutCompression) {
                // RGC without DCTL - use buildDctlComputeShader with dctlShaderInfo=undefined
                const rgcMsg = '[Integrated] Building OCIO+RGC compute shader (no DCTL)';
                console.log(rgcMsg);
                writeLog(rgcMsg);

                let rgcShaderInfo: ACES2RgcShaderResult | undefined;
                try {
                    rgcShaderInfo = await buildACES2RgcShader(extensionPath, dctlOptions?.peakLuminance ?? 100);
                    if (!rgcShaderInfo.success) {
                        console.warn('[Integrated] RGC shader build failed:', rgcShaderInfo.error);
                    }
                } catch (err) {
                    console.warn('[Integrated] RGC shader build error:', err);
                }

                if (rgcShaderInfo?.success) {
                    const rgcComputeResult = await buildDctlComputeShader(
                        extensionPath,
                        ocioShaderInfo,
                        undefined, // No DCTL
                        {
                            enabled: false, // DCTL disabled
                            workingColorSpace: 'ACEScct',
                            applyACES2GamutCompression: true,
                            peakLuminance: dctlOptions.peakLuminance,
                            rgcShaderInfo,
                        }
                    );

                    if (rgcComputeResult.success) {
                        computeWgslCode = rgcComputeResult.computeWgsl;
                        dctlComputeShaderInfo = rgcComputeResult;
                        const successMsg = `[Integrated] OCIO+RGC compute shader WGSL generated successfully (hasFullRgc=${rgcComputeResult.hasFullRgc})`;
                        console.log(successMsg);
                        writeLog(successMsg);
                    } else {
                        const failMsg = `[Integrated] OCIO+RGC compute shader generation failed: ${rgcComputeResult.error}`;
                        console.warn(failMsg);
                        writeLog(failMsg);
                    }
                }
            } else {
                // No DCTL, No RGC - build OCIO-only compute shader
                const ocioComputeResult = await buildOcioComputeShader(extensionPath, ocioShaderInfo);
                if (ocioComputeResult.success) {
                    computeWgslCode = ocioComputeResult.computeWgsl;
                    const ocioMsg = '[Integrated] OCIO-only compute shader WGSL generated successfully';
                    console.log(ocioMsg);
                    writeLog(ocioMsg);
                } else {
                    const errMsg = `[Integrated] OCIO compute shader generation failed: ${ocioComputeResult.error}`;
                    console.warn(errMsg);
                    writeLog(errMsg);
                }
            }
        }
    } catch (e) {
        const errMsg = `[Integrated] Compute shader generation error: ${e}`;
        console.warn(errMsg);
        writeLog(errMsg);
    }

    return {
        wgslCode: fragmentWgslCode ?? '',
        computeWgslCode,
        glslCode: glslCode ?? '',
        textures: ocioShaderInfo.textures,
        textures3D: ocioShaderInfo.textures3D,
        bindings,
        success: true,
        dctlInfo,
        dctlBindings,
        dctlDefaults,
        rgcTextures,
        rgcTextures3D,
        paramMapping,
        useUniformBuffer: dctlOptions?.useUniformBuffer,
        uniformBufferBinding,
        dctlComputeShaderInfo,
    };
}

/**
 * Build integrated GLSL shader code
 */
function buildIntegratedGlsl(
    ocioShaderInfo: GpuShaderInfo,
    dctlInfo?: DctlShaderInfo,
    dctlOptions?: DctlBuildOptions
): {
    glsl: string;
    bindings: TextureBinding[];
    dctlBindings: DctlUniformBinding[];
    dctlDefaults: Record<string, number | boolean | DctlColorValue>;
    rgcTextures?: GpuTexture[];
    rgcTextures3D?: GpuTexture3D[];
    paramMapping?: ShaderParamMapping[];
    uniformBufferBinding?: number;
} {
    let ocioCode = ocioShaderInfo.shaderText;
    let bindingIndex = 2; // Start after u_image_tex (0) and u_image_samp (1)
    const uniformPrefix = 'u_dctl_';

    const bindings: TextureBinding[] = [
        { binding: 0, type: 'texture2D', name: 'u_image_tex' },
        { binding: 1, type: 'sampler', name: 'u_image_samp' },
    ];

    // Extract RGC GLSL if enabled
    let rgcCode = '';
    let rgcTextures: GpuTexture[] = [];
    let rgcTextures3D: GpuTexture3D[] = [];
    let rgcSamplerDeclarations: SamplerDeclaration[] = [];

    if (dctlOptions?.applyACES2GamutCompression) {
        const peakLuminance = dctlOptions.peakLuminance ?? 100;
        const rgcResult = extractRgcGlslFunction(peakLuminance);

        if (rgcResult) {
            rgcCode = rgcResult.glsl;
            rgcTextures = rgcResult.textures;
            rgcTextures3D = rgcResult.textures3D;

            // Process RGC code: fix for naga and rename main function
            rgcCode = fixGlslForNaga(rgcCode);

            // Rename OCIODisplay to applyACES2RGC
            rgcCode = rgcCode.replace(
                /vec4\s+(OCIODisplay|ocio_main|OCIOMain)\s*\(\s*vec4/g,
                'vec4 applyACES2RGC(vec4'
            );

            // Prefix all RGC helper functions with "rgc_" to avoid collision with OCIO display functions
            const rgcFunctionNames: string[] = [];
            rgcCode = rgcCode.replace(
                /\b(ocio_[a-zA-Z0-9_]+)\s*\(/g,
                (match, funcName) => {
                    if (!rgcFunctionNames.includes(funcName)) {
                        rgcFunctionNames.push(funcName);
                    }
                    return `rgc_${funcName}(`;
                }
            );

            // Also rename the array declarations
            rgcCode = rgcCode.replace(
                /\b(ocio_[a-zA-Z0-9_]+_array)\b/g,
                'rgc_$1'
            );

            // Process RGC sampler declarations with rgc_ prefix
            const rgcSamplerResult = processSamplerDeclarations(rgcCode, bindingIndex, {
                duplicateStrategy: 'remove',
                prefix: 'rgc_',
            });
            rgcCode = rgcSamplerResult.code;
            rgcSamplerDeclarations = rgcSamplerResult.declarations;
            bindingIndex = rgcSamplerResult.nextBindingIndex;

            // Add RGC bindings with rgc: prefix in originalName to distinguish from OCIO
            for (const binding of rgcSamplerResult.bindings) {
                bindings.push({
                    ...binding,
                    originalName: binding.originalName ? `rgc:${binding.originalName}` : binding.originalName,
                });
            }

            // Replace texture() calls in RGC code
            rgcCode = replaceSamplerTextureCalls(rgcCode, rgcSamplerDeclarations);
        }
    }

    // Process OCIO code for naga compatibility
    ocioCode = fixGlslForNaga(ocioCode);

    // Process OCIO sampler declarations
    const ocioSamplerResult = processSamplerDeclarations(ocioCode, bindingIndex);
    ocioCode = ocioSamplerResult.code;
    bindings.push(...ocioSamplerResult.bindings);

    // Replace texture() calls to use combined sampler constructor
    ocioCode = replaceSamplerTextureCalls(ocioCode, ocioSamplerResult.declarations);

    // Find the main OCIO function name
    const ocioMainFunc = findOcioMainFunction(ocioCode);

    // Build DCTL uniform bindings
    const dctlBindings: DctlUniformBinding[] = [];
    const dctlDefaults: Record<string, number | boolean | DctlColorValue> = {};

    if (dctlInfo) {
        // Add enabled uniform
        dctlBindings.push({
            name: `${uniformPrefix}enabled`,
            type: 'bool',
            paramName: 'enabled',
            default: true,
        });
        dctlDefaults[`${uniformPrefix}enabled`] = true;

        // Add parameter uniforms
        for (const param of dctlInfo.params) {
            const uniformName = `${uniformPrefix}${param.name}`;
            let type: 'float' | 'int' | 'bool' | 'vec3';

            switch (param.type) {
                case 'DCTL_SLIDER_FLOAT':
                case 'DCTL_VALUE_BOX':
                    type = 'float';
                    break;
                case 'DCTL_SLIDER_INT':
                case 'DCTL_COMBO_BOX':
                    type = 'int';
                    break;
                case 'DCTL_CHECK_BOX':
                    type = 'bool';
                    break;
                case 'DCTL_COLOR_PICKER':
                    type = 'vec3';
                    break;
            }

            dctlBindings.push({
                name: uniformName,
                type,
                paramName: param.name,
                default: param.default,
            });
            dctlDefaults[uniformName] = param.default;
        }
    }

    // Build complete shader
    let completeGlsl = `#version 450

// Input/Output
layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

// Image texture (source EXR)
layout(set = 0, binding = 0) uniform texture2D u_image_tex;
layout(set = 0, binding = 1) uniform sampler u_image_samp;
`;

    // Track uniform buffer mode results
    let paramMapping: ShaderParamMapping[] | undefined;
    let uniformBufferBinding: number | undefined;

    // Add DCTL section if present
    if (dctlInfo) {
        // Add DCTL built-in parameters
        // p_Width and p_Height are constants, but p_X and p_Y are computed from v_texCoord
        // This allows per-pixel variation for effects like Film Grain
        const imgWidth = dctlOptions?.imageWidth ?? 1920;
        const imgHeight = dctlOptions?.imageHeight ?? 1080;
        completeGlsl += `
// DCTL Built-in Parameters
const int p_Width = ${imgWidth};
const int p_Height = ${imgHeight};
int p_X = 0;  // Computed per-pixel in main() from v_texCoord
int p_Y = 0;  // Computed per-pixel in main() from v_texCoord
const int TIMELINE_FRAME_INDEX = 0;
const float TRANSITION_PROGRESS = 0.0;
const int __RESOLVE_VER_MAJOR__ = 19;
const int __RESOLVE_VER_MINOR__ = 0;

// AP0 to ACEScg (Working Color Space) Matrix
// Used by dctl_sampleTexture to convert sampled colors to working space
// Note: GLSL mat3 uses column-major order, so values are transposed from row-major source
const mat3 dctl_ap0ToWorking = mat3(
    1.4514393161, -0.0765537734, 0.0083161484,    // Column 0
    -0.2365107469, 1.1762296998, -0.0060324498,   // Column 1
    -0.2149285693, -0.0996759264, 0.9977163014    // Column 2
);

// DCTL Texture Sampling Helper
// Samples the input image at arbitrary pixel coordinates (for _tex2D calls)
// Returns color in working color space (ACEScg) for consistency with DCTL transform
vec4 dctl_sampleTexture(int x, int y) {
    vec2 uv = vec2((float(x) + 0.5) / float(p_Width), (float(y) + 0.5) / float(p_Height));
    vec4 sampled = texture(sampler2D(u_image_tex, u_image_samp), uv);
    // Convert from input color space (AP0) to working color space (ACEScg)
    sampled.rgb = dctl_ap0ToWorking * sampled.rgb;
    return sampled;
}
`;
        // Choose between uniform buffer mode (fast path) and constant mode
        if (dctlOptions?.useUniformBuffer) {
            // Uniform buffer mode: parameters are read from a uniform buffer
            // Allocate binding for DCTL params uniform buffer
            uniformBufferBinding = bindingIndex++;
            bindings.push({
                binding: uniformBufferBinding,
                type: 'uniform',
                name: 'DctlUIParams',
            });

            const dctlResult = buildDctlShaderCodeWithUniformBuffer(dctlInfo, uniformBufferBinding, {
                uniformPrefix,
                inputColorSpace: 'ACES2065-1',
                outputColorSpace: 'ACES2065-1',
                enabled: dctlOptions?.enabled ?? true,
            });
            completeGlsl += dctlResult.completeFragment;
            paramMapping = dctlResult.paramMapping;
        } else {
            // Constant mode: parameters are baked as constants (requires shader recompilation on change)
            const dctlResult = buildDctlShaderCode(dctlInfo, {
                uniformPrefix,
                inputColorSpace: 'ACES2065-1',
                outputColorSpace: 'ACES2065-1',
                paramValues: dctlOptions?.paramValues,
                enabled: dctlOptions?.enabled ?? true,
            });
            completeGlsl += dctlResult.completeFragment;
        }
    }

    // Add RGC section if enabled
    if (rgcCode) {
        completeGlsl += `
// =============================================================================
// ACES 2.0 Reference Gamut Compression (RGC)
// Applied in AP1 space before DCTL processing
// =============================================================================

${rgcCode}
`;
    }

    // Add OCIO section
    completeGlsl += `
// =============================================================================
// OCIO Display Transform
// =============================================================================

${ocioCode}

// Main Function
void main() {
    vec4 color = texture(sampler2D(u_image_tex, u_image_samp), v_texCoord);
`;

    // Apply RGC if enabled (before DCTL, per ACES specification)
    if (rgcCode) {
        completeGlsl += `
    // Apply ACES 2.0 Reference Gamut Compression
    // RGC operates on AP1 linear, input is AP0 linear
    // The applyACES2RGC function handles AP0→AP1→RGC→AP1 internally
    color = applyACES2RGC(color);
`;
    }

    if (dctlInfo) {
        // Compute per-pixel coordinates for DCTL built-ins
        completeGlsl += `    // Compute pixel coordinates from texture coordinates
    p_X = int(v_texCoord.x * float(p_Width));
    p_Y = int(v_texCoord.y * float(p_Height));
    color.rgb = applyDCTL(color.rgb);
`;
    }

    completeGlsl += `    vec4 result = ${ocioMainFunc}(color);
    // Only clamp negative values, allow HDR values > 1.0
    fragColor = max(result, vec4(0.0));
}
`;

    return {
        glsl: completeGlsl,
        bindings,
        dctlBindings,
        dctlDefaults,
        rgcTextures,
        rgcTextures3D,
        paramMapping,
        uniformBufferBinding,
    };
}

/**
 * Create a DCTL-only shader (no OCIO)
 */
export function buildDctlOnlyGlslShader(dctlInfo: DctlShaderInfo): string {
    const uniformPrefix = 'u_dctl_';
    const dctlResult = buildDctlShaderCode(dctlInfo, {
        uniformPrefix,
        inputColorSpace: 'ACES2065-1',
        outputColorSpace: 'ACES2065-1',
    });

    return `#version 450

// Input/Output
layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

// Image texture
layout(set = 0, binding = 0) uniform texture2D u_image_tex;
layout(set = 0, binding = 1) uniform sampler u_image_samp;

${dctlResult.completeFragment}

void main() {
    vec4 color = texture(sampler2D(u_image_tex, u_image_samp), v_texCoord);
    color.rgb = applyDCTL(color.rgb);
    // Only clamp negative values, allow HDR values > 1.0
    fragColor = max(color, vec4(0.0));
}
`;
}
