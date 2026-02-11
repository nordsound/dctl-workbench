/**
 * OCIO Compute Shader WGSL Builder
 *
 * Generates compute shader WGSL code for OCIO color transforms.
 * Uses textureLoad for source image and textureSample for LUT interpolation.
 */

import { getNagaProcessor } from '../naga/index.js';
import type { GpuShaderInfo, GpuTexture, GpuTexture3D } from '../ocio/types.js';
import type { TextureBinding } from '../types/index.js';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
} from './glsl-utils.js';

// Workgroup size for compute shaders
const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;

export interface ComputeShaderInfo {
    /** Complete WGSL compute shader code */
    computeWgsl: string;
    /** OCIO transform function WGSL (extracted from naga conversion) */
    ocioFunctionWgsl: string;
    /** 2D textures (LUTs) */
    textures: GpuTexture[];
    /** 3D textures (LUTs) */
    textures3D: GpuTexture3D[];
    /** Texture and sampler bindings for compute shader */
    bindings: TextureBinding[];
    /** Conversion success flag */
    success: boolean;
    /** Error message if conversion failed */
    error?: string;
}

/**
 * Build a compute shader WGSL from OCIO GLSL shader info
 *
 * The compute shader structure:
 * - Group 0: Source texture (texture_2d<f32>)
 * - Group 1: Output storage texture (texture_storage_2d<rgba32float, write>)
 * - Group 2: OCIO LUT textures and samplers
 * - Group 3: Parameters (width, height)
 */
export async function buildOcioComputeShader(
    wasmPath: string,
    shaderInfo: GpuShaderInfo
): Promise<ComputeShaderInfo> {
    const naga = getNagaProcessor();

    // Initialize naga if not already done
    if (!naga.isInitialized) {
        await naga.init(wasmPath);
    }

    // First, build a fragment shader GLSL to get the OCIO functions converted
    const { glsl: fragmentGlsl, bindings: fragmentBindings } = buildHelperFragmentGlsl(shaderInfo);

    // Convert to WGSL using naga
    const conversionResult = naga.convertFragmentToWGSL(fragmentGlsl);

    if (!conversionResult.success) {
        console.error('OCIO GLSL to WGSL conversion failed:', conversionResult.error);
        return {
            computeWgsl: '',
            ocioFunctionWgsl: '',
            textures: shaderInfo.textures,
            textures3D: shaderInfo.textures3D,
            bindings: [],
            success: false,
            error: conversionResult.error,
        };
    }

    // Extract OCIO functions from the converted WGSL
    const ocioFunctions = extractOcioFunctions(conversionResult.wgsl);

    // Build compute shader bindings (different layout from fragment)
    const computeBindings = buildComputeBindings(shaderInfo);

    // Build complete compute shader
    const computeWgsl = buildComputeShaderCode(
        ocioFunctions.functions,
        ocioFunctions.mainFunctionName,
        computeBindings,
        shaderInfo
    );

    return {
        computeWgsl,
        ocioFunctionWgsl: ocioFunctions.functions,
        textures: shaderInfo.textures,
        textures3D: shaderInfo.textures3D,
        bindings: computeBindings,
        success: true,
    };
}

/**
 * Build a helper fragment shader for naga conversion
 * This is similar to ocio-wgsl-builder but we'll extract just the functions
 */
function buildHelperFragmentGlsl(shaderInfo: GpuShaderInfo): {
    glsl: string;
    bindings: TextureBinding[];
} {
    // Apply GLSL fixes for naga compatibility
    let code = fixGlslForNaga(shaderInfo.shaderText);

    // Process sampler declarations (start at binding 0 for compute shader)
    const samplerResult = processSamplerDeclarations(code, 0);
    code = samplerResult.code;
    const bindings = samplerResult.bindings;

    // Replace texture() calls to use combined sampler constructor
    code = replaceSamplerTextureCalls(code, samplerResult.declarations);

    // Find the main OCIO function name
    const ocioMainFunc = findOcioMainFunction(code);

    // Build minimal fragment shader just for conversion
    const completeGlsl = `#version 450

// Dummy input for fragment shader (needed for naga)
layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

// OCIO Generated Code
${code}

void main() {
    fragColor = ${ocioMainFunc}(vec4(0.0));
}
`;

    return { glsl: completeGlsl, bindings };
}

/**
 * Extract OCIO functions from converted WGSL
 */
function extractOcioFunctions(wgslCode: string): {
    functions: string;
    mainFunctionName: string;
} {
    // Find the main function and everything before it (the OCIO functions)
    const mainMatch = wgslCode.match(/fn\s+main\s*\(/);
    if (!mainMatch || mainMatch.index === undefined) {
        return { functions: wgslCode, mainFunctionName: 'OCIODisplay' };
    }

    // Extract everything before main()
    let functions = wgslCode.substring(0, mainMatch.index);

    // Remove the @fragment decorator if present (we're building compute shader)
    functions = functions.replace(/@fragment\s*/g, '');

    // Find the OCIO main function name (OCIODisplay, ocio_main, etc.)
    const ocioMainMatch = functions.match(/fn\s+(OCIODisplay|ocio_main|OCIOMain)\s*\(/);
    const mainFunctionName = ocioMainMatch ? ocioMainMatch[1] : 'OCIODisplay';

    return { functions, mainFunctionName };
}

/**
 * Build compute shader bindings
 *
 * Layout:
 * Group 0: Source texture
 * Group 1: Output storage texture
 * Group 2: OCIO LUT textures and samplers
 * Group 3: Parameters
 */
function buildComputeBindings(shaderInfo: GpuShaderInfo): TextureBinding[] {
    const bindings: TextureBinding[] = [];
    let bindingIndex = 0;

    // Group 2: OCIO textures (we'll remap these in the shader)
    for (const tex of shaderInfo.textures) {
        bindings.push({
            binding: bindingIndex++,
            type: 'texture2D',
            name: `${tex.samplerName}_tex`,
            originalName: tex.samplerName,
        });
        bindings.push({
            binding: bindingIndex++,
            type: 'sampler',
            name: `${tex.samplerName}_samp`,
            originalName: tex.samplerName,
        });
    }

    for (const tex of shaderInfo.textures3D) {
        bindings.push({
            binding: bindingIndex++,
            type: 'texture3D',
            name: `${tex.samplerName}_tex`,
            originalName: tex.samplerName,
        });
        bindings.push({
            binding: bindingIndex++,
            type: 'sampler',
            name: `${tex.samplerName}_samp`,
            originalName: tex.samplerName,
        });
    }

    return bindings;
}

/**
 * Replace textureSample with textureSampleLevel in WGSL code
 * Properly handles nested parentheses in function arguments
 */
function replaceTextureSampleWithLevel(code: string): string {
    let result = '';
    let i = 0;

    while (i < code.length) {
        // Look for textureSample( but not textureSampleLevel(
        const match = code.substring(i).match(/^textureSample\s*\(/);
        if (match && !code.substring(i).startsWith('textureSampleLevel')) {
            // Found textureSample(, need to find the matching closing paren
            const startIdx = i;
            i += match[0].length;

            // Find the closing parenthesis, counting nested parens
            let parenCount = 1;
            const argsStart = i;
            while (i < code.length && parenCount > 0) {
                if (code[i] === '(') parenCount++;
                else if (code[i] === ')') parenCount--;
                i++;
            }

            if (parenCount === 0) {
                // Extract the arguments (without the final closing paren)
                const args = code.substring(argsStart, i - 1);
                // Add textureSampleLevel with LOD 0.0
                result += 'textureSampleLevel(' + args + ', 0.0)';
            } else {
                // Malformed - keep original
                result += code.substring(startIdx, i);
            }
        } else {
            result += code[i];
            i++;
        }
    }

    return result;
}

/**
 * Build complete compute shader WGSL code
 */
function buildComputeShaderCode(
    ocioFunctions: string,
    ocioMainFunction: string,
    bindings: TextureBinding[],
    shaderInfo: GpuShaderInfo
): string {
    // Build OCIO texture bindings for Group 2
    let ocioBindings = '';
    let bindingIndex = 0;

    for (const tex of shaderInfo.textures) {
        const texName = `${tex.samplerName}_tex`;
        const samplerName = `${tex.samplerName}_samp`;
        ocioBindings += `@group(2) @binding(${bindingIndex++}) var ${texName}: texture_2d<f32>;\n`;
        ocioBindings += `@group(2) @binding(${bindingIndex++}) var ${samplerName}: sampler;\n`;
    }

    for (const tex of shaderInfo.textures3D) {
        const texName = `${tex.samplerName}_tex`;
        const samplerName = `${tex.samplerName}_samp`;
        ocioBindings += `@group(2) @binding(${bindingIndex++}) var ${texName}: texture_3d<f32>;\n`;
        ocioBindings += `@group(2) @binding(${bindingIndex++}) var ${samplerName}: sampler;\n`;
    }

    // Process OCIO functions to fix group bindings
    // The naga-converted code uses @group(0), we need to change to @group(2)
    let processedFunctions = ocioFunctions;
    processedFunctions = processedFunctions.replace(/@group\(0\)/g, '@group(2)');

    // Remove any existing texture/sampler declarations (we'll add our own)
    processedFunctions = processedFunctions.replace(
        /@group\(2\)\s*@binding\(\d+\)\s*var\s+\w+\s*:\s*(texture_2d|texture_3d|sampler)[^;]*;/g,
        ''
    );

    // CRITICAL: Replace textureSample with textureSampleLevel for compute shaders
    // textureSample is NOT allowed in compute shaders (requires implicit derivatives)
    // textureSampleLevel with explicit LOD (0.0) is the compute shader equivalent
    processedFunctions = replaceTextureSampleWithLevel(processedFunctions);

    // Build complete compute shader
    return `/**
 * OCIO Color Transform Compute Shader
 * Generated by ocio-compute-wgsl-builder
 */

// ============================================================================
// Bind Group 0: Source Texture
// ============================================================================
@group(0) @binding(0) var source_texture: texture_2d<f32>;

// ============================================================================
// Bind Group 1: Output Storage Texture
// ============================================================================
@group(1) @binding(0) var output_texture: texture_storage_2d<rgba32float, write>;

// ============================================================================
// Bind Group 2: OCIO LUT Textures
// ============================================================================
${ocioBindings}

// ============================================================================
// Bind Group 3: Parameters
// ============================================================================
struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(3) @binding(0) var<uniform> params: Params;

// ============================================================================
// OCIO Transform Functions
// ============================================================================
${processedFunctions}

// ============================================================================
// Compute Shader Main
// ============================================================================
@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel (no interpolation needed for exact pixel processing)
    let source_color = textureLoad(source_texture, coords, 0);

    // Apply OCIO color transform
    let transformed = ${ocioMainFunction}(source_color);

    // Store result (only clamp negative values, allow HDR values > 1.0)
    textureStore(output_texture, coords, max(transformed, vec4<f32>(0.0)));
}
`;
}

/**
 * Create a simple passthrough compute shader (for testing)
 */
export function createPassthroughComputeShader(): string {
    return `/**
 * Passthrough Compute Shader (for testing)
 */

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(1) @binding(0) var output_texture: texture_storage_2d<rgba32float, write>;

struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(2) @binding(0) var<uniform> params: Params;

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    let color = textureLoad(source_texture, coords, 0);
    textureStore(output_texture, coords, color);
}
`;
}

/**
 * Create a Zone System compute shader with passthrough color transform
 * Uses Group 4 for Zone System buffers
 */
export function createZoneSystemComputeShader(): string {
    return `/**
 * Zone System Compute Shader
 * Applies false color / zone overlay based on luminance
 */

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(1) @binding(0) var output_texture: texture_storage_2d<rgba32float, write>;

struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(3) @binding(0) var<uniform> params: Params;

// ============================================================================
// Zone System (Group 4)
// ============================================================================
struct ZoneParams {
    enabled: u32,
    style: u32,
    opacity: f32,
    zone_count: u32,
    middle_gray: f32,
    _padding: vec3<f32>,
}

struct ZoneDefinition {
    color: vec3<f32>,
    min_stop: f32,
    max_stop: f32,
    _padding: vec3<f32>,
}

@group(4) @binding(0) var<uniform> zone_params: ZoneParams;
@group(4) @binding(1) var<storage, read> zones: array<ZoneDefinition>;

// Calculate luminance using Rec. 709 coefficients
fn zone_calculate_luminance(color: vec3<f32>) -> f32 {
    return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Calculate stops from middle gray
fn zone_calculate_stops(luminance: f32, middle_gray: f32) -> f32 {
    if (luminance <= 0.0) {
        return -100.0;
    }
    return log2(luminance / middle_gray);
}

// Get zone color based on stops
fn zone_get_color(stops: f32) -> vec3<f32> {
    for (var i = 0u; i < zone_params.zone_count; i++) {
        let zone = zones[i];
        if (stops >= zone.min_stop && stops < zone.max_stop) {
            return zone.color;
        }
    }
    if (zone_params.zone_count > 0u) {
        return zones[zone_params.zone_count - 1u].color;
    }
    return vec3<f32>(1.0, 0.0, 1.0); // Magenta fallback
}

// Apply zone blend
fn zone_apply_blend(original: vec3<f32>, zone_color: vec3<f32>) -> vec3<f32> {
    switch (zone_params.style) {
        case 0u, 1u: {
            // False color / Bars: mix blend
            return mix(original, zone_color, zone_params.opacity);
        }
        case 2u: {
            // Overlay: additive blend
            return original + zone_color * zone_params.opacity;
        }
        default: {
            return original;
        }
    }
}

@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    let source_color = textureLoad(source_texture, coords, 0);
    var color = source_color.rgb;

    // Apply Zone System if enabled
    if (zone_params.enabled == 1u) {
        let luminance = zone_calculate_luminance(source_color.rgb);
        let stops = zone_calculate_stops(luminance, zone_params.middle_gray);
        let zone_color = zone_get_color(stops);
        color = zone_apply_blend(color, zone_color);
    }

    textureStore(output_texture, coords, vec4<f32>(color, 1.0));
}
`;
}
