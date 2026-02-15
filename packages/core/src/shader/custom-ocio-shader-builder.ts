/**
 * Custom OCIO Shader Builder
 *
 * Extracts GPU shaders from a custom OCIO config for the dual-mode pipeline.
 * Generates two OCIO shaders:
 *   A) source → working (for dctl_sampleTexture)
 *   B) working → display (chained via GroupTransform for main())
 *
 * Both shaders' LUT textures share bind group 2 with sequential binding indices.
 * Functions are prefixed: sw_ (source→working), wd_ (working→display).
 */

import { OCIOProcessor } from '../ocio/index.js';
import { getNagaProcessor } from '../naga/index.js';
import type { GpuTexture, GpuTexture3D } from '../ocio/types.js';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
} from './glsl-utils.js';

export interface CustomOcioShaderInfo {
    /** GLSL shader code extracted from OCIO */
    glsl: string;
    /** WGSL shader code (converted from GLSL) — empty until WGSL conversion is done */
    wgsl: string;
    /** Main function name (prefixed) */
    mainFunction: string;
    /** 2D LUT textures */
    textures: GpuTexture[];
    /** 3D LUT textures */
    textures3D: GpuTexture3D[];
}

export interface CustomOcioShaderResult {
    /** Source → Working color space shader */
    sourceToWorking: CustomOcioShaderInfo;
    /** Working → Display shader (chained via GroupTransform) */
    workingToDisplay: CustomOcioShaderInfo;
    /** Success flag */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

export interface CustomOcioShaderOptions {
    /** Source color space name in the OCIO config (e.g. 'reference') */
    sourceColorSpace: string;
    /** Working color space name (e.g. 'linear_working') */
    workingColorSpace: string;
    /** Display name (e.g. 'sRGB') */
    display: string;
    /** View name (e.g. 'Film') */
    view: string;
}

const EMPTY_SHADER: CustomOcioShaderInfo = {
    glsl: '',
    wgsl: '',
    mainFunction: '',
    textures: [],
    textures3D: [],
};

function failResult(error: string): CustomOcioShaderResult {
    return {
        sourceToWorking: { ...EMPTY_SHADER },
        workingToDisplay: { ...EMPTY_SHADER },
        success: false,
        error,
    };
}

/**
 * Extract GPU shader info from an OCIOProcessor, deep-copying texture data.
 * Returns the GLSL code and texture arrays with data copied from WASM heap.
 */
function extractShaderWithTextures(
    processor: OCIOProcessor,
    prefix: string,
): { glsl: string; textures: GpuTexture[]; textures3D: GpuTexture3D[] } | null {
    if (!processor.setupGpuProcessor()) {
        return null;
    }

    const shaderInfo = processor.extractGpuShaderInfo();

    // Deep-copy texture data from WASM heap before processor is reused/disposed
    const textures = shaderInfo.textures.map((t: GpuTexture) => ({
        ...t,
        samplerName: `${prefix}_${t.samplerName}`,
        data: Array.from(t.data),
    }));
    const textures3D = shaderInfo.textures3D.map((t: GpuTexture3D) => ({
        ...t,
        samplerName: `${prefix}_${t.samplerName}`,
        data: Array.from(t.data),
    }));

    // Prefix all ocio_ function references in the GLSL
    let glsl = shaderInfo.shaderText;
    // Prefix function definitions and calls: ocio_xxx → {prefix}_ocio_xxx
    glsl = glsl.replace(/\bocio_/g, `${prefix}_ocio_`);
    // Prefix the main OCIODisplay function
    glsl = glsl.replace(/\bOCIODisplay\b/g, `${prefix}_OCIODisplay`);

    return { glsl, textures, textures3D };
}

/**
 * Extract GPU shaders from a custom OCIO config file.
 *
 * Creates two OCIO GPU shader pipelines:
 *   A) source → working: for dctl_sampleTexture()
 *   B) working → display: chained GroupTransform for main()
 *
 * @param configPath Path to the .ocio config file
 * @param options Color space, display, and view settings
 * @returns Extracted shader info with GLSL, WGSL, and LUT textures
 */
export function extractCustomOcioShaders(
    configPath: string,
    options: CustomOcioShaderOptions,
): CustomOcioShaderResult {
    // === Shader A: source → working ===
    const processorA = new OCIOProcessor();
    let sourceToWorking: CustomOcioShaderInfo;

    try {
        if (!processorA.initFromFile(configPath)) {
            return failResult(`Failed to load config: ${processorA.getLastError()}`);
        }

        if (!processorA.createTransform(options.sourceColorSpace, options.workingColorSpace)) {
            return failResult(
                `Failed to create source→working transform (${options.sourceColorSpace} → ${options.workingColorSpace}): ${processorA.getLastError()}`
            );
        }

        const swResult = extractShaderWithTextures(processorA, 'sw');
        if (!swResult) {
            return failResult(`Failed to setup GPU processor for source→working: ${processorA.getLastError()}`);
        }

        sourceToWorking = {
            glsl: swResult.glsl,
            wgsl: '',
            mainFunction: 'sw_OCIODisplay',
            textures: swResult.textures,
            textures3D: swResult.textures3D,
        };
    } catch (e) {
        return failResult(`Exception in source→working shader extraction: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        processorA.dispose();
    }

    // === Shader B: working → display (chained) ===
    const processorB = new OCIOProcessor();
    let workingToDisplay: CustomOcioShaderInfo;

    try {
        if (!processorB.initFromFile(configPath)) {
            return failResult(`Failed to load config for display transform: ${processorB.getLastError()}`);
        }

        if (!processorB.createChainedDisplayTransform(
            options.workingColorSpace,
            options.sourceColorSpace,
            options.display,
            options.view,
        )) {
            return failResult(
                `Failed to create chained working→display transform: ${processorB.getLastError()}`
            );
        }

        const wdResult = extractShaderWithTextures(processorB, 'wd');
        if (!wdResult) {
            return failResult(`Failed to setup GPU processor for working→display: ${processorB.getLastError()}`);
        }

        workingToDisplay = {
            glsl: wdResult.glsl,
            wgsl: '',
            mainFunction: 'wd_OCIODisplay',
            textures: wdResult.textures,
            textures3D: wdResult.textures3D,
        };
    } catch (e) {
        return failResult(`Exception in working→display shader extraction: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        processorB.dispose();
    }

    return {
        sourceToWorking,
        workingToDisplay,
        success: true,
    };
}

export interface CustomOcioComputeShaderResult {
    /** Complete WGSL compute shader code */
    computeWgsl: string;
    /** Combined 2D LUT textures (sw_ + wd_) */
    textures: GpuTexture[];
    /** Combined 3D LUT textures (sw_ + wd_) */
    textures3D: GpuTexture3D[];
    /** Whether DCTL is included */
    hasDctl: boolean;
    /** Success flag */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

// Workgroup size for compute shaders
const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;

/**
 * Convert prefixed OCIO GLSL to a Vulkan 4.50 fragment shader suitable for Naga conversion.
 * Handles sampler declaration splitting and texture call rewriting.
 * Supports prefixed function names (sw_OCIODisplay, wd_OCIODisplay).
 */
function buildFragmentGlslForNaga(glsl: string): string {
    let code = fixGlslForNaga(glsl);

    const samplerResult = processSamplerDeclarations(code, 0);
    code = samplerResult.code;

    code = replaceSamplerTextureCalls(code, samplerResult.declarations);

    // Find the main OCIO function — supports both prefixed and unprefixed names
    const mainFuncMatch = code.match(
        /vec4\s+((?:sw_|wd_)?(?:OCIODisplay|ocio_main|OCIOMain))\s*\(/
    );
    const mainFunc = mainFuncMatch ? mainFuncMatch[1] : findOcioMainFunction(code);

    return `#version 450

layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

${code}

void main() {
    fragColor = ${mainFunc}(vec4(0.0));
}
`;
}

/**
 * Extract WGSL functions from Naga-converted code, removing
 * binding declarations, struct definitions, and main entry point.
 */
function extractWgslFunctionsOnly(wgslCode: string): string {
    // Find main function and extract everything before it
    const mainMatch = wgslCode.match(/fn\s+main\s*\(/);
    let functions: string;
    if (mainMatch && mainMatch.index !== undefined) {
        functions = wgslCode.substring(0, mainMatch.index);
    } else {
        functions = wgslCode;
    }

    // Remove binding declarations (texture, sampler, uniform)
    functions = functions.replace(
        /@group\(\d+\)\s*@binding\(\d+\)\s*var\s+\w+\s*:\s*(texture_2d|texture_3d|sampler)[^;]*;/g,
        ''
    );
    // Remove any uniform declarations
    functions = functions.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var<uniform>[^;]+;/g, '');
    // Remove struct declarations (FragmentOutput, VertexOutput, etc.)
    functions = functions.replace(/struct\s+(FragmentOutput|VertexOutput)\s*\{[^}]*\}\s*/g, '');
    // Remove fragment I/O var<private> declarations
    functions = functions.replace(/var<private>\s+(v_texCoord_\d*|fragColor|gl_\w+)\s*:\s*[^;]+;/g, '');
    // Remove @fragment decorator
    functions = functions.replace(/@fragment\s*/g, '');
    // Remove main_1 helper that naga might generate
    functions = functions.replace(/fn\s+main_1\s*\([^)]*\)\s*\{[\s\S]*?\n\}\s*/g, '');
    // Clean up empty lines
    functions = functions.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

    return functions;
}

/**
 * Replace textureSample with textureSampleLevel in WGSL code.
 * textureSample uses implicit derivatives which aren't available in compute shaders.
 */
function replaceTextureSampleWithLevel(code: string): string {
    let result = '';
    let i = 0;

    while (i < code.length) {
        const match = code.substring(i).match(/^textureSample\s*\(/);
        if (match && !code.substring(i).startsWith('textureSampleLevel')) {
            i += match[0].length;
            let parenCount = 1;
            const argsStart = i;
            while (i < code.length && parenCount > 0) {
                if (code[i] === '(') parenCount++;
                else if (code[i] === ')') parenCount--;
                i++;
            }
            if (parenCount === 0) {
                const args = code.substring(argsStart, i - 1);
                result += 'textureSampleLevel(' + args + ', 0.0)';
            } else {
                result += code.substring(i - match[0].length, i);
            }
        } else {
            result += code[i];
            i++;
        }
    }

    return result;
}

/**
 * Build a complete compute shader WGSL for custom OCIO mode.
 *
 * Converts the extracted GLSL shaders to WGSL via Naga, then assembles
 * the complete compute shader with:
 *   - sw_ OCIO functions for source→working in dctl_sampleTexture()
 *   - wd_ OCIO functions for working→display in main()
 *   - Optional DCTL transform
 *   - No RGC (not applicable in custom mode)
 *
 * @param wasmPath Path to WASM modules directory
 * @param extractedShaders Result from extractCustomOcioShaders()
 * @returns Complete compute shader WGSL with LUT texture data
 */
export async function buildCustomOcioComputeShader(
    wasmPath: string,
    extractedShaders: CustomOcioShaderResult,
): Promise<CustomOcioComputeShaderResult> {
    if (!extractedShaders.success) {
        return {
            computeWgsl: '',
            textures: [],
            textures3D: [],
            hasDctl: false,
            success: false,
            error: `Input shaders not valid: ${extractedShaders.error}`,
        };
    }

    const naga = getNagaProcessor();
    if (!naga.isInitialized) {
        await naga.init(wasmPath);
    }

    // === Convert source→working (sw_) GLSL to WGSL ===
    const swFragmentGlsl = buildFragmentGlslForNaga(extractedShaders.sourceToWorking.glsl);
    const swWgslResult = naga.convertFragmentToWGSL(swFragmentGlsl);
    if (!swWgslResult.success) {
        return {
            computeWgsl: '',
            textures: [],
            textures3D: [],
            hasDctl: false,
            success: false,
            error: `Source→working GLSL→WGSL conversion failed: ${swWgslResult.error}`,
        };
    }
    let swFunctions = extractWgslFunctionsOnly(swWgslResult.wgsl);
    swFunctions = replaceTextureSampleWithLevel(swFunctions);

    // === Convert working→display (wd_) GLSL to WGSL ===
    const wdFragmentGlsl = buildFragmentGlslForNaga(extractedShaders.workingToDisplay.glsl);
    const wdWgslResult = naga.convertFragmentToWGSL(wdFragmentGlsl);
    if (!wdWgslResult.success) {
        return {
            computeWgsl: '',
            textures: [],
            textures3D: [],
            hasDctl: false,
            success: false,
            error: `Working→display GLSL→WGSL conversion failed: ${wdWgslResult.error}`,
        };
    }
    let wdFunctions = extractWgslFunctionsOnly(wdWgslResult.wgsl);
    wdFunctions = replaceTextureSampleWithLevel(wdFunctions);

    // === Build combined LUT texture bindings for Group 2 ===
    const allTextures = [
        ...extractedShaders.sourceToWorking.textures,
        ...extractedShaders.workingToDisplay.textures,
    ];
    const allTextures3D = [
        ...extractedShaders.sourceToWorking.textures3D,
        ...extractedShaders.workingToDisplay.textures3D,
    ];

    let lutBindings = '';
    let bindingIndex = 0;

    for (const tex of allTextures) {
        const texName = `${tex.samplerName}_tex`;
        const samplerName = `${tex.samplerName}_samp`;
        lutBindings += `@group(2) @binding(${bindingIndex++}) var ${texName}: texture_2d<f32>;\n`;
        lutBindings += `@group(2) @binding(${bindingIndex++}) var ${samplerName}: sampler;\n`;
    }
    for (const tex of allTextures3D) {
        const texName = `${tex.samplerName}_tex`;
        const samplerName = `${tex.samplerName}_samp`;
        lutBindings += `@group(2) @binding(${bindingIndex++}) var ${texName}: texture_3d<f32>;\n`;
        lutBindings += `@group(2) @binding(${bindingIndex++}) var ${samplerName}: sampler;\n`;
    }

    // Find the sw_ and wd_ main function names in the WGSL
    const swMainMatch = swFunctions.match(/fn\s+(sw_OCIODisplay|sw_ocio_main|sw_OCIOMain)\s*\(/);
    const swMainName = swMainMatch ? swMainMatch[1] : extractedShaders.sourceToWorking.mainFunction;
    const wdMainMatch = wdFunctions.match(/fn\s+(wd_OCIODisplay|wd_ocio_main|wd_OCIOMain)\s*\(/);
    const wdMainName = wdMainMatch ? wdMainMatch[1] : extractedShaders.workingToDisplay.mainFunction;

    // === Assemble complete compute shader ===
    const computeWgsl = `/**
 * Custom OCIO Compute Shader
 * Generated by custom-ocio-shader-builder
 * Mode: Custom OCIO (non-ACES)
 * DCTL: Disabled
 * RGC: Disabled (not applicable in custom OCIO mode)
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
// Bind Group 2: OCIO LUT Textures (sw_ + wd_)
// ============================================================================
${lutBindings}

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
// Source → Working Transform Functions (sw_)
// ============================================================================
${swFunctions}

// ============================================================================
// Working → Display Transform Functions (wd_)
// ============================================================================
${wdFunctions}

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

    // Load source pixel
    let source_color = textureLoad(source_texture, coords, 0);

    // Apply source → working color space transform
    let working_color = ${swMainName}(source_color);

    // Apply working → display color space transform (chained)
    let display_color = ${wdMainName}(working_color);

    // Store result (only clamp negative values, allow HDR values > 1.0)
    textureStore(output_texture, coords, max(display_color, vec4<f32>(0.0)));
}
`;

    return {
        computeWgsl,
        textures: allTextures,
        textures3D: allTextures3D,
        hasDctl: false,
        success: true,
    };
}

export interface CustomOcioExportShaderResult {
    /** Source → Working color space shader (for dctl_sampleTexture) */
    sourceToWorking: CustomOcioShaderInfo;
    /** Working → Source color space shader (for export conversion) */
    workingToSource: CustomOcioShaderInfo;
    /** Success flag */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

export interface CustomOcioExportOptions {
    /** Source color space name in the OCIO config */
    sourceColorSpace: string;
    /** Working color space name */
    workingColorSpace: string;
}

/**
 * Extract GPU shaders for the custom OCIO export pipeline.
 *
 * Creates two OCIO GPU shader pipelines for EXR export:
 *   A) source → working: for dctl_sampleTexture() (sw_ prefix)
 *   B) working → source: for converting DCTL output back to source CS (ws_ prefix)
 *
 * @param configPath Path to the .ocio config file
 * @param options Source and working color space names
 * @returns Extracted shader info for export pipeline
 */
export function extractCustomOcioExportShaders(
    configPath: string,
    options: CustomOcioExportOptions,
): CustomOcioExportShaderResult {
    // === Shader A: source → working (sw_) ===
    const processorA = new OCIOProcessor();
    let sourceToWorking: CustomOcioShaderInfo;

    try {
        if (!processorA.initFromFile(configPath)) {
            return {
                sourceToWorking: { ...EMPTY_SHADER },
                workingToSource: { ...EMPTY_SHADER },
                success: false,
                error: `Failed to load config: ${processorA.getLastError()}`,
            };
        }

        if (!processorA.createTransform(options.sourceColorSpace, options.workingColorSpace)) {
            return {
                sourceToWorking: { ...EMPTY_SHADER },
                workingToSource: { ...EMPTY_SHADER },
                success: false,
                error: `Failed to create source→working transform: ${processorA.getLastError()}`,
            };
        }

        const swResult = extractShaderWithTextures(processorA, 'sw');
        if (!swResult) {
            return {
                sourceToWorking: { ...EMPTY_SHADER },
                workingToSource: { ...EMPTY_SHADER },
                success: false,
                error: `Failed to extract source→working GPU shader: ${processorA.getLastError()}`,
            };
        }

        sourceToWorking = {
            glsl: swResult.glsl,
            wgsl: '',
            mainFunction: 'sw_OCIODisplay',
            textures: swResult.textures,
            textures3D: swResult.textures3D,
        };
    } catch (e) {
        return {
            sourceToWorking: { ...EMPTY_SHADER },
            workingToSource: { ...EMPTY_SHADER },
            success: false,
            error: `Exception in source→working extraction: ${e instanceof Error ? e.message : String(e)}`,
        };
    } finally {
        processorA.dispose();
    }

    // === Shader B: working → source (ws_) — inverse of sw_ ===
    const processorB = new OCIOProcessor();
    let workingToSource: CustomOcioShaderInfo;

    try {
        if (!processorB.initFromFile(configPath)) {
            return {
                sourceToWorking: { ...EMPTY_SHADER },
                workingToSource: { ...EMPTY_SHADER },
                success: false,
                error: `Failed to load config for working→source: ${processorB.getLastError()}`,
            };
        }

        if (!processorB.createTransform(options.workingColorSpace, options.sourceColorSpace)) {
            return {
                sourceToWorking: { ...EMPTY_SHADER },
                workingToSource: { ...EMPTY_SHADER },
                success: false,
                error: `Failed to create working→source transform: ${processorB.getLastError()}`,
            };
        }

        const wsResult = extractShaderWithTextures(processorB, 'ws');
        if (!wsResult) {
            return {
                sourceToWorking: { ...EMPTY_SHADER },
                workingToSource: { ...EMPTY_SHADER },
                success: false,
                error: `Failed to extract working→source GPU shader: ${processorB.getLastError()}`,
            };
        }

        workingToSource = {
            glsl: wsResult.glsl,
            wgsl: '',
            mainFunction: 'ws_OCIODisplay',
            textures: wsResult.textures,
            textures3D: wsResult.textures3D,
        };
    } catch (e) {
        return {
            sourceToWorking: { ...EMPTY_SHADER },
            workingToSource: { ...EMPTY_SHADER },
            success: false,
            error: `Exception in working→source extraction: ${e instanceof Error ? e.message : String(e)}`,
        };
    } finally {
        processorB.dispose();
    }

    return {
        sourceToWorking,
        workingToSource,
        success: true,
    };
}
