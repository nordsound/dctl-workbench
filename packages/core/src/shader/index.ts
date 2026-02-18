/**
 * Shader Module
 *
 * Unified WGSL shader generation for DCTL.
 * Used by both CLI and VS Code extension.
 */

import type {
    DctlParamValues,
    DctlColorSpace,
    ShaderBuildOptions,
    ShaderBuildResult,
    TextureBinding,
    CompileResult,
} from '../types/index.js';
import {
    AP0_TO_AP1_MATRIX,
    AP1_TO_AP0_MATRIX,
    ACESCCT_ENCODE_WGSL,
    ACESCCT_DECODE_WGSL,
    isLogColorSpace,
} from '../color-space/index.js';

// Re-export types
export type { ShaderBuildOptions, ShaderBuildResult, TextureBinding };

// Re-export GLSL utilities
export * from './glsl-utils.js';

// =============================================================================
// Transform Signature Detection
// =============================================================================

/**
 * DCTL transform function signature type
 * - 'texture': uses __TEXTURE__ parameters (calls dctl_sampleTexture internally)
 * - 'float': uses p_R, p_G, p_B parameters (expects RGB values as arguments)
 */
export type TransformSignatureType = 'texture' | 'float';

/**
 * Detect transform function signature type from WGSL code
 *
 * This is critical for correctly calling the transform function:
 * - texture-based: call transform(p_Width, p_Height, p_X, p_Y)
 * - float-based: call transform(p_Width, p_Height, p_X, p_Y, p_R, p_G, p_B)
 */
export function detectTransformSignature(wgsl: string): TransformSignatureType {
    // Look for transform function signature
    const transformMatch = wgsl.match(/fn\s+transform\s*\([^)]+\)/);
    if (transformMatch) {
        // Check if it contains texture_2d parameters (texture sampling DCTL)
        if (transformMatch[0].includes('texture_2d')) {
            return 'texture';
        }
        // Check if it contains p_R, p_G, p_B parameters (direct RGB DCTL)
        if (transformMatch[0].includes('p_R') || transformMatch[0].includes('p_G') || transformMatch[0].includes('p_B')) {
            return 'float';
        }
    }
    // Default to texture if unknown (safe - will use dctl_sampleTexture)
    return 'texture';
}

// =============================================================================
// Transform Signature Rewriting
// =============================================================================

/**
 * Rewrite texture-based transform signature to remove texture_2d parameters
 *
 * The DCTL compiler generates:
 *   fn transform(p_Width, p_Height, p_X, p_Y, p_TexR: texture_2d<f32>, p_TexG: texture_2d<f32>, p_TexB: texture_2d<f32>)
 *
 * But the texture parameters are never used - the function calls dctl_sampleTexture internally.
 * We need to remove these so the entry point can call transform(p_Width, p_Height, p_X, p_Y).
 */
export function rewriteTextureTransformSignature(wgsl: string): string {
    return wgsl.replace(
        /fn\s+transform\s*\(\s*p_Width\s*:\s*i32\s*,\s*p_Height\s*:\s*i32\s*,\s*p_X\s*:\s*i32\s*,\s*p_Y\s*:\s*i32\s*,\s*p_TexR\s*:\s*texture_2d<f32>\s*,\s*p_TexG\s*:\s*texture_2d<f32>\s*,\s*p_TexB\s*:\s*texture_2d<f32>\s*\)/g,
        'fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32)'
    );
}

/**
 * Rewrite texture-based transform signature for compute shader (uses i32 dummy params)
 */
export function rewriteTextureTransformForCompute(wgsl: string): string {
    return wgsl.replace(
        /fn\s+transform\s*\(\s*p_Width\s*:\s*i32\s*,\s*p_Height\s*:\s*i32\s*,\s*p_X\s*:\s*i32\s*,\s*p_Y\s*:\s*i32\s*,\s*p_TexR\s*:\s*texture_2d<f32>\s*,\s*p_TexG\s*:\s*texture_2d<f32>\s*,\s*p_TexB\s*:\s*texture_2d<f32>\s*\)/g,
        'fn transform(p_Width: i32, p_Height: i32, p_X: i32, p_Y: i32, p_TexR: i32, p_TexG: i32, p_TexB: i32)'
    );
}

// =============================================================================
// Parameter Injection
// =============================================================================

/**
 * Parameter info extracted from WGSL
 */
interface WgslParam {
    name: string;
    type: string;
    match: string;
}

/**
 * Extract var<private> declarations from WGSL
 * Matches both initialized and uninitialized declarations:
 * - var<private> gain: f32;
 * - var<private> gain: f32 = 1f;
 */
export function extractWgslParams(wgsl: string): WgslParam[] {
    const varPrivateRegex = /var<private>\s+(\w+):\s*(f32|i32|bool)(?:\s*=\s*[^;]+)?;/g;
    const params: WgslParam[] = [];
    let match;

    while ((match = varPrivateRegex.exec(wgsl)) !== null) {
        params.push({
            name: match[1],
            type: match[2],
            match: match[0],
        });
    }

    return params;
}

/**
 * Inject parameter values into WGSL code
 *
 * Handles parameter renaming (e.g., dmax -> dmax_2) by stripping _N suffix
 */
export function injectParameters(wgsl: string, paramValues: DctlParamValues): string {
    const wgslParams = extractWgslParams(wgsl);
    let result = wgsl;

    for (const wgslParam of wgslParams) {
        let value: number | boolean | undefined;

        // Try exact match first
        if (paramValues[wgslParam.name] !== undefined) {
            const v = paramValues[wgslParam.name];
            if (typeof v === 'number' || typeof v === 'boolean') {
                value = v;
            }
        } else {
            // Try stripping _N suffix (e.g., dmax_2 -> dmax)
            const baseName = wgslParam.name.replace(/_\d+$/, '');
            if (baseName !== wgslParam.name && paramValues[baseName] !== undefined) {
                const v = paramValues[baseName];
                if (typeof v === 'number' || typeof v === 'boolean') {
                    value = v;
                }
            }
        }

        if (value !== undefined) {
            if (wgslParam.type === 'f32' && typeof value === 'number') {
                result = result.replace(
                    wgslParam.match,
                    `var<private> ${wgslParam.name}: f32 = ${value}f;`
                );
            } else if (wgslParam.type === 'i32' && typeof value === 'number') {
                result = result.replace(
                    wgslParam.match,
                    `var<private> ${wgslParam.name}: i32 = ${Math.floor(value)}i;`
                );
            } else if (wgslParam.type === 'i32' && typeof value === 'boolean') {
                // DCTL CHECK_BOX compiles to i32, but param values may be boolean
                result = result.replace(
                    wgslParam.match,
                    `var<private> ${wgslParam.name}: i32 = ${value ? 1 : 0}i;`
                );
            } else if (wgslParam.type === 'bool' && typeof value === 'boolean') {
                result = result.replace(
                    wgslParam.match,
                    `var<private> ${wgslParam.name}: bool = ${value};`
                );
            }
        }
    }

    return result;
}

// =============================================================================
// Texture Sampling Stub Removal
// =============================================================================

/**
 * Remove the dctl_sampleTexture stub from compiled WGSL
 */
export function removeSampleTextureStub(wgsl: string): string {
    return wgsl.replace(
        /fn dctl_sampleTexture\([^)]*\)\s*->\s*vec4<f32>\s*\{[\s\S]*?return vec4<f32>\([^)]*\);[\s\S]*?\}/,
        ''
    );
}

// =============================================================================
// WGSL Code Generation Helpers
// =============================================================================

/**
 * Generate color space conversion code (WGSL)
 */
export function generateColorSpaceCode(workingColorSpace: DctlColorSpace): string {
    const isLog = isLogColorSpace(workingColorSpace);

    let code = `// Color space matrices
${AP0_TO_AP1_MATRIX.wgsl}

${AP1_TO_AP0_MATRIX.wgsl}

`;

    if (isLog) {
        code += `// ACEScct encoding
fn dctl_lin_to_ACEScct(lin: f32) -> f32 {
    let cut: f32 = 0.0078125;
    let a: f32 = 10.5402377416545;
    let b: f32 = 0.0729055341958355;
    if (lin <= cut) {
        return a * lin + b;
    } else {
        return (log2(lin) + 9.72) / 17.52;
    }
}

fn dctl_lin_to_ACEScct_vec(lin: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dctl_lin_to_ACEScct(lin.x),
        dctl_lin_to_ACEScct(lin.y),
        dctl_lin_to_ACEScct(lin.z)
    );
}

// ACEScct decoding
fn dctl_ACEScct_to_lin(cct: f32) -> f32 {
    let cut: f32 = 0.155251141552511;
    let a: f32 = 10.5402377416545;
    let b: f32 = 0.0729055341958355;
    if (cct <= cut) {
        return (cct - b) / a;
    } else {
        return pow(2.0, cct * 17.52 - 9.72);
    }
}

fn dctl_ACEScct_to_lin_vec(cct: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dctl_ACEScct_to_lin(cct.x),
        dctl_ACEScct_to_lin(cct.y),
        dctl_ACEScct_to_lin(cct.z)
    );
}

`;
    }

    return code;
}

/**
 * Generate texture sampling function for fragment shader (WGSL)
 */
export function generateFragmentTextureSampler(
    workingColorSpace: DctlColorSpace,
    applyRgc: boolean = false,
    rgcFunctionCall: string = ''
): string {
    const isLog = isLogColorSpace(workingColorSpace);

    if (isLog) {
        return `
// DCTL Texture Sampling (with ACEScct encoding)
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let uv = vec2<f32>((f32(x) + 0.5) / f32(p_Width), (f32(y) + 0.5) / f32(p_Height));
    var sampled = textureSample(u_image_tex, u_image_samp, uv);
    // Convert AP0 -> AP1 linear
    var ap1 = dctl_ap0ToWorking * sampled.rgb;
    ${applyRgc ? `// Apply ACES 2.0 RGC (AP1 -> AP1)\n    ap1 = ${rgcFunctionCall}(vec4<f32>(ap1, 1.0)).rgb;` : ''}
    // Encode to ACEScct (working space)
    var cct = dctl_lin_to_ACEScct_vec(ap1);
    return vec4<f32>(cct, sampled.a);
}
`;
    } else {
        return `
// DCTL Texture Sampling (linear)
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let uv = vec2<f32>((f32(x) + 0.5) / f32(p_Width), (f32(y) + 0.5) / f32(p_Height));
    var sampled = textureSample(u_image_tex, u_image_samp, uv);
    // Convert AP0 -> AP1 linear
    var ap1 = dctl_ap0ToWorking * sampled.rgb;
    ${applyRgc ? `// Apply ACES 2.0 RGC (AP1 -> AP1)\n    ap1 = ${rgcFunctionCall}(vec4<f32>(ap1, 1.0)).rgb;` : ''}
    return vec4<f32>(ap1, sampled.a);
}
`;
    }
}

/**
 * Generate fragment shader entry point (WGSL)
 */
export function generateFragmentEntryPoint(
    transformType: TransformSignatureType,
    workingColorSpace: DctlColorSpace
): string {
    const isLog = isLogColorSpace(workingColorSpace);

    if (transformType === 'float') {
        // Float-based DCTL: sample texture and pass values to transform
        if (isLog) {
            return `
// Fragment shader entry point (float-based DCTL)
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    // Sample texture for float-based DCTL
    let sampled = dctl_sampleTexture(p_X, p_Y);
    let p_R = sampled.x;
    let p_G = sampled.y;
    let p_B = sampled.z;

    // Call DCTL transform (returns ACEScct)
    let resultACEScct = transform(p_Width, p_Height, p_X, p_Y, p_R, p_G, p_B);

    // Decode ACEScct -> AP1 linear
    let resultAP1 = dctl_ACEScct_to_lin_vec(resultACEScct);

    // Convert AP1 -> AP0 for export
    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}
`;
        } else {
            return `
// Fragment shader entry point (float-based DCTL)
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    // Sample texture for float-based DCTL
    let sampled = dctl_sampleTexture(p_X, p_Y);
    let p_R = sampled.x;
    let p_G = sampled.y;
    let p_B = sampled.z;

    // Call DCTL transform (returns linear AP1)
    let resultAP1 = transform(p_Width, p_Height, p_X, p_Y, p_R, p_G, p_B);

    // Convert AP1 -> AP0 for export
    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}
`;
        }
    } else {
        // Texture-based DCTL: transform uses dctl_sampleTexture internally
        if (isLog) {
            return `
// Fragment shader entry point (texture-based DCTL)
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    // Call DCTL transform (returns ACEScct)
    let resultACEScct = transform(p_Width, p_Height, p_X, p_Y);

    // Decode ACEScct -> AP1 linear
    let resultAP1 = dctl_ACEScct_to_lin_vec(resultACEScct);

    // Convert AP1 -> AP0 for export
    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}
`;
        } else {
            return `
// Fragment shader entry point (texture-based DCTL)
@fragment
fn main(@location(0) v_texCoord: vec2<f32>) -> @location(0) vec4<f32> {
    let p_X = i32(v_texCoord.x * f32(p_Width));
    let p_Y = i32(v_texCoord.y * f32(p_Height));

    // Call DCTL transform (returns linear AP1)
    let resultAP1 = transform(p_Width, p_Height, p_X, p_Y);

    // Convert AP1 -> AP0 for export
    let resultAP0 = dctl_workingToAp0 * resultAP1;

    return vec4<f32>(resultAP0, 1.0);
}
`;
        }
    }
}

// =============================================================================
// Legacy Shader Builder (Backward Compatibility)
// =============================================================================

/**
 * Build a complete WGSL shader from compiled DCTL
 * @deprecated Use buildExportShader for export or buildComputeShader for CLI
 */
export function buildShader(
    compileResult: CompileResult,
    options: ShaderBuildOptions
): ShaderBuildResult {
    return buildExportShader(compileResult, options);
}

// =============================================================================
// Export Shader Builder (Fragment Shader for VS Code)
// =============================================================================

/**
 * Options for building export shader
 */
export interface ExportShaderOptions extends ShaderBuildOptions {
    /** Pre-extracted RGC WGSL code (from OCIO) */
    rgcWgslCode?: string;
    /** RGC main function name */
    rgcFunctionName?: string;
}

/**
 * Build a fragment shader for EXR export
 *
 * Used by VS Code extension for export functionality.
 * Pipeline: AP0 -> [RGC] -> AP1 (linear) -> DCTL -> AP1 -> AP0
 *
 * NOTE: Uses linear AP1 (ACEScg) by default for export to ensure
 * mathematically correct linear operations (gain, multiply, etc.)
 * ACEScct causes banding artifacts for colors with negative AP1 components
 * (green, cyan) due to gain multiplication in log space.
 */
export function buildExportShader(
    compileResult: CompileResult,
    options: ExportShaderOptions
): ShaderBuildResult {
    const {
        width,
        height,
        paramValues = {},
        workingColorSpace = 'ACEScct',
        applyRGC = false,
        rgcWgslCode = '',
        rgcFunctionName = 'applyACES2RGC',
    } = options;

    const isLog = isLogColorSpace(workingColorSpace);

    // Process DCTL WGSL
    let dctlWgsl = compileResult.wgsl;

    // Remove texture sampling stub
    dctlWgsl = removeSampleTextureStub(dctlWgsl);

    // Detect transform signature BEFORE modifying
    const transformType = detectTransformSignature(dctlWgsl);

    // Rewrite texture-based transform signature
    if (transformType === 'texture') {
        dctlWgsl = rewriteTextureTransformSignature(dctlWgsl);
    }

    // Inject parameters
    dctlWgsl = injectParameters(dctlWgsl, paramValues);

    // Build shader
    let wgsl = `// DCTL Export Shader (WGSL)
// Transform type: ${transformType}
// Working space: ${workingColorSpace}
// RGC: ${applyRGC}

// Built-in parameters
const p_Width: i32 = ${width};
const p_Height: i32 = ${height};

// Texture bindings
@group(0) @binding(0) var u_image_tex: texture_2d<f32>;
@group(0) @binding(1) var u_image_samp: sampler;

`;

    // Add color space code
    wgsl += generateColorSpaceCode(workingColorSpace);

    // Add RGC code if enabled
    if (applyRGC && rgcWgslCode) {
        wgsl += `// ACES 2.0 Reference Gamut Compression
${rgcWgslCode}

`;
    }

    // Add texture sampling function
    wgsl += generateFragmentTextureSampler(workingColorSpace, applyRGC, rgcFunctionName);

    // Add DCTL functions
    wgsl += '\n// DCTL Functions\n';
    wgsl += dctlWgsl;

    // Add entry point
    wgsl += generateFragmentEntryPoint(transformType, workingColorSpace);

    // Build bindings
    const bindings: TextureBinding[] = [
        { binding: 0, type: 'texture2D', name: 'u_image_tex' },
        { binding: 1, type: 'sampler', name: 'u_image_samp' },
    ];

    return {
        wgsl,
        bindings,
    };
}

// =============================================================================
// Compute Shader Builder (Buffer-based for CLI)
// =============================================================================

/**
 * Color space conversion matrices (WGSL) for compute shader
 */
const COMPUTE_COLOR_MATRICES_WGSL = `
// AP0 (ACES 2065-1) to AP1 (ACEScg)
const mat_ap0_to_ap1: mat3x3<f32> = mat3x3<f32>(
    vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
    vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
    vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
);

// AP1 (ACEScg) to AP0 (ACES 2065-1)
const mat_ap1_to_ap0: mat3x3<f32> = mat3x3<f32>(
    vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
    vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
    vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
);
`;

/**
 * Transfer functions (WGSL) for compute shader
 */
const COMPUTE_TRANSFER_FUNCTIONS_WGSL = `
// ACEScct encoding
fn lin_to_ACEScct(lin: f32) -> f32 {
    let cut: f32 = 0.0078125;
    let a: f32 = 10.5402377416545;
    let b: f32 = 0.0729055341958355;
    if (lin <= cut) {
        return a * lin + b;
    } else {
        return (log2(lin) + 9.72) / 17.52;
    }
}

fn lin_to_ACEScct_vec(lin: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(lin_to_ACEScct(lin.x), lin_to_ACEScct(lin.y), lin_to_ACEScct(lin.z));
}

// ACEScct decoding
fn ACEScct_to_lin(cct: f32) -> f32 {
    let cut: f32 = 0.155251141552511;
    let a: f32 = 10.5402377416545;
    let b: f32 = 0.0729055341958355;
    if (cct <= cut) {
        return (cct - b) / a;
    } else {
        return pow(2.0, cct * 17.52 - 9.72);
    }
}

fn ACEScct_to_lin_vec(cct: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(ACEScct_to_lin(cct.x), ACEScct_to_lin(cct.y), ACEScct_to_lin(cct.z));
}
`;

/**
 * Options for building compute shader
 */
export interface ComputeShaderOptions extends ShaderBuildOptions {
    /** Input color space */
    inputColorSpace?: string;
    /** Output color space */
    outputColorSpace?: string;
    /** RGC WGSL functions (from OCIO via Naga) */
    rgcWgslFunctions?: string;
    /** RGC main function name */
    rgcMainFunctionName?: string;
    /** RGC texture bindings (WGSL) */
    rgcTextureBindings?: string;
}

/**
 * Generate texture sampler for compute shader (buffer-based)
 */
function generateComputeTextureSampler(
    inputColorSpace: string,
    workingColorSpace: DctlColorSpace,
    applyRgc: boolean = false,
    rgcMainFunctionName: string = ''
): string {
    const isLog = isLogColorSpace(workingColorSpace);

    let code = `
// Texture sampling for compute shader (buffer-based)
var<private> current_pixel_x: i32 = 0;
var<private> current_pixel_y: i32 = 0;

fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let px = clamp(x, 0, p_Width - 1);
    let py = clamp(y, 0, p_Height - 1);
    let idx = (py * p_Width + px) * 3;
    var rgb = vec3<f32>(input_buffer[idx], input_buffer[idx + 1], input_buffer[idx + 2]);
`;

    // Convert input to AP1 linear
    if (inputColorSpace === 'AP0') {
        code += `    // Convert AP0 -> AP1 linear\n    rgb = mat_ap0_to_ap1 * rgb;\n`;
    }

    // Apply RGC if enabled
    if (applyRgc && rgcMainFunctionName) {
        code += `    // Apply ACES 2.0 RGC\n    rgb = ${rgcMainFunctionName}(vec4<f32>(rgb, 1.0)).rgb;\n`;
    }

    // Convert to working space
    if (isLog) {
        code += `    // Encode to ACEScct\n    rgb = lin_to_ACEScct_vec(rgb);\n`;
    }

    code += `    return vec4<f32>(rgb, 1.0);\n}\n`;

    return code;
}

/**
 * Build a compute shader for CLI rendering
 *
 * Uses storage buffers instead of textures for WebGPU compute.
 * Pipeline: AP0 -> [RGC] -> AP1 (linear) -> DCTL -> AP1 -> AP0
 *
 * NOTE: Uses linear AP1 (ACEScg) by default for export to ensure
 * mathematically correct linear operations (gain, multiply, etc.)
 */
export function buildComputeShader(
    compileResult: CompileResult,
    options: ComputeShaderOptions
): ShaderBuildResult {
    const {
        width,
        height,
        paramValues = {},
        workingColorSpace = 'ACEScct',
        inputColorSpace = 'AP0',
        outputColorSpace = 'AP0',
        applyRGC = false,
        rgcWgslFunctions = '',
        rgcMainFunctionName = '',
        rgcTextureBindings = '',
    } = options;

    const isLog = isLogColorSpace(workingColorSpace);

    // Process DCTL WGSL
    let dctlWgsl = compileResult.wgsl;

    // Remove texture sampling stub
    dctlWgsl = removeSampleTextureStub(dctlWgsl);

    // Detect transform signature BEFORE modifying
    const transformType = detectTransformSignature(dctlWgsl);

    // Rewrite texture-based transform signature for compute (uses i32 dummy params)
    if (transformType === 'texture') {
        dctlWgsl = rewriteTextureTransformForCompute(dctlWgsl);
    }

    // Inject parameters
    dctlWgsl = injectParameters(dctlWgsl, paramValues);

    // Build shader
    let wgsl = `// DCTL Compute Shader (WGSL)
// Transform type: ${transformType}
// Input: ${inputColorSpace}, Working: ${workingColorSpace}, Output: ${outputColorSpace}
// RGC: ${applyRGC}

// Built-in parameters
const p_Width: i32 = ${width};
const p_Height: i32 = ${height};

// Storage buffers (RGB float32)
@group(0) @binding(0) var<storage, read> input_buffer: array<f32>;
@group(0) @binding(1) var<storage, read_write> output_buffer: array<f32>;

`;

    // Add RGC texture bindings if present
    if (applyRGC && rgcTextureBindings) {
        wgsl += `// RGC LUT Textures\n${rgcTextureBindings}\n\n`;
    }

    // Add color matrices and transfer functions
    wgsl += `// Color space matrices\n${COMPUTE_COLOR_MATRICES_WGSL}\n`;
    wgsl += `// Transfer functions\n${COMPUTE_TRANSFER_FUNCTIONS_WGSL}\n`;

    // Add RGC functions if present
    if (applyRGC && rgcWgslFunctions) {
        wgsl += `// ACES 2.0 RGC Functions\n${rgcWgslFunctions}\n\n`;
    }

    // Add texture sampler
    wgsl += generateComputeTextureSampler(inputColorSpace, workingColorSpace, applyRGC, rgcMainFunctionName);

    // Add DCTL functions
    wgsl += '\n// DCTL Functions\n';
    wgsl += dctlWgsl;

    // Add compute entry point
    wgsl += `
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let x = i32(global_id.x);
    let y = i32(global_id.y);

    if (x >= p_Width || y >= p_Height) {
        return;
    }

    current_pixel_x = x;
    current_pixel_y = y;

    // Read input pixel
    let idx = (y * p_Width + x) * 3;
    var rgb = vec3<f32>(input_buffer[idx], input_buffer[idx + 1], input_buffer[idx + 2]);

    // Convert input to AP1 linear
    ${inputColorSpace === 'AP0' ? 'rgb = mat_ap0_to_ap1 * rgb;' : ''}

    ${applyRGC && rgcMainFunctionName ? `// Apply RGC\n    rgb = ${rgcMainFunctionName}(vec4<f32>(rgb, 1.0)).rgb;` : ''}

    ${isLog ? '// Encode to ACEScct\n    rgb = lin_to_ACEScct_vec(rgb);' : ''}

    // Call DCTL transform
    ${transformType === 'texture'
        ? 'let result = transform(p_Width, p_Height, x, y, 0, 0, 0);'
        : 'let result = transform(p_Width, p_Height, x, y, rgb.x, rgb.y, rgb.z);'}

    ${isLog ? '// Decode from ACEScct\n    var out_rgb = ACEScct_to_lin_vec(result);' : 'var out_rgb = result;'}

    ${outputColorSpace === 'AP0' ? '// Convert AP1 -> AP0\n    out_rgb = mat_ap1_to_ap0 * out_rgb;' : ''}

    // Write output
    output_buffer[idx] = out_rgb.x;
    output_buffer[idx + 1] = out_rgb.y;
    output_buffer[idx + 2] = out_rgb.z;
}
`;

    // Build bindings
    const bindings: TextureBinding[] = [];

    return {
        wgsl,
        bindings,
    };
}


// Re-export shader builders
export * from "./ocio-compute-wgsl-builder.js";
export * from "./ocio-wgsl-builder.js";
export * from "./dctl-shader-builder.js";
export * from "./dctl-compute-wgsl-builder.js";
export * from "./aces-rgc-shader-builder.js";
export * from "./dctl-export-shader-builder.js";
export * from "./integrated-shader-builder.js";
export * from "./custom-ocio-shader-builder.js";
