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
import type { DctlParam, TextureBinding } from '../types/index.js';
import type { CompileResult } from '../compiler/index.js';
import { getDctlCompiler, isCompileError } from '../compiler/index.js';
import { buildShaderParamMapping, type ShaderParamMapping } from './dctl-shader-builder.js';
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
    /** Texture and sampler bindings */
    bindings: TextureBinding[];
    /** Whether DCTL is included */
    hasDctl: boolean;
    /** DCTL parameter mapping (when hasDctl is true) */
    paramMapping: ShaderParamMapping[];
    /** Uniform buffer binding index */
    uniformBufferBinding: number;
    /** Success flag */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

export interface CustomOcioDctlOptions {
    /** Raw DCTL source code */
    dctlSource: string;
    /** DCTL parameter definitions */
    params: DctlParam[];
    /** Use uniform buffer for fast parameter updates */
    useUniformBuffer?: boolean;
    /** Parameter values (baked as constants when not using UB) */
    paramValues?: Record<string, number | boolean>;
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
    dctlOptions?: CustomOcioDctlOptions,
): Promise<CustomOcioComputeShaderResult> {
    const failResult: CustomOcioComputeShaderResult = {
        computeWgsl: '',
        textures: [],
        textures3D: [],
        bindings: [],
        hasDctl: false,
        paramMapping: [],
        uniformBufferBinding: 0,
        success: false,
    };

    if (!extractedShaders.success) {
        return { ...failResult, error: `Input shaders not valid: ${extractedShaders.error}` };
    }

    const naga = getNagaProcessor();
    if (!naga.isInitialized) {
        await naga.init(wasmPath);
    }

    // === Convert source→working (sw_) GLSL to WGSL ===
    const swFragmentGlsl = buildFragmentGlslForNaga(extractedShaders.sourceToWorking.glsl);
    const swWgslResult = naga.convertFragmentToWGSL(swFragmentGlsl);
    if (!swWgslResult.success) {
        return { ...failResult, error: `Source→working GLSL→WGSL conversion failed: ${swWgslResult.error}` };
    }
    let swFunctions = extractWgslFunctionsOnly(swWgslResult.wgsl);
    swFunctions = replaceTextureSampleWithLevel(swFunctions);

    // === Convert working→display (wd_) GLSL to WGSL ===
    const wdFragmentGlsl = buildFragmentGlslForNaga(extractedShaders.workingToDisplay.glsl);
    const wdWgslResult = naga.convertFragmentToWGSL(wdFragmentGlsl);
    if (!wdWgslResult.success) {
        return { ...failResult, error: `Working→display GLSL→WGSL conversion failed: ${wdWgslResult.error}` };
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
    const bindings: TextureBinding[] = [];
    let bindingIndex = 0;

    for (const tex of allTextures) {
        const texName = `${tex.samplerName}_tex`;
        const samplerName = `${tex.samplerName}_samp`;
        lutBindings += `@group(2) @binding(${bindingIndex}) var ${texName}: texture_2d<f32>;\n`;
        bindings.push({ binding: bindingIndex++, type: 'texture2D', name: texName });
        lutBindings += `@group(2) @binding(${bindingIndex}) var ${samplerName}: sampler;\n`;
        bindings.push({ binding: bindingIndex++, type: 'sampler', name: samplerName });
    }
    for (const tex of allTextures3D) {
        const texName = `${tex.samplerName}_tex`;
        const samplerName = `${tex.samplerName}_samp`;
        lutBindings += `@group(2) @binding(${bindingIndex}) var ${texName}: texture_3d<f32>;\n`;
        bindings.push({ binding: bindingIndex++, type: 'texture3D', name: texName });
        lutBindings += `@group(2) @binding(${bindingIndex}) var ${samplerName}: sampler;\n`;
        bindings.push({ binding: bindingIndex++, type: 'sampler', name: samplerName });
    }

    // Find the sw_ and wd_ main function names in the WGSL
    const swMainMatch = swFunctions.match(/fn\s+(sw_OCIODisplay|sw_ocio_main|sw_OCIOMain)\s*\(/);
    const swMainName = swMainMatch ? swMainMatch[1] : extractedShaders.sourceToWorking.mainFunction;
    const wdMainMatch = wdFunctions.match(/fn\s+(wd_OCIODisplay|wd_ocio_main|wd_OCIOMain)\s*\(/);
    const wdMainName = wdMainMatch ? wdMainMatch[1] : extractedShaders.workingToDisplay.mainFunction;

    // === Compile DCTL if provided ===
    let dctlFunctionsWgsl = '';
    let dctlMainSection = '';
    let dctlSampleTextureWgsl = '';
    let paramMapping: ShaderParamMapping[] = [];
    let uniformBufferBinding = 0;
    let hasDctl = false;
    let paramStructFields = '';
    let paramInitCode = '';

    if (dctlOptions?.dctlSource) {
        const dctlResult = await compileDctlForCustomOcio(wasmPath, dctlOptions);
        if (!dctlResult.success) {
            return { ...failResult, error: `DCTL compilation failed: ${dctlResult.error}` };
        }

        hasDctl = true;
        dctlFunctionsWgsl = dctlResult.functions;
        paramMapping = dctlResult.paramMapping;
        uniformBufferBinding = dctlResult.uniformBufferBinding;

        // Build dctl_sampleTexture that uses sw_ transform
        dctlSampleTextureWgsl = `
// DCTL Built-in: Sample texture at (x, y) → working color space
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let clamped_x = u32(clamp(x, 0, i32(params.width) - 1));
    let clamped_y = u32(clamp(y, 0, i32(params.height) - 1));
    let coords = vec2<u32>(clamped_x, clamped_y);
    let source_color = textureLoad(source_texture, coords, 0);
    return ${swMainName}(source_color);
}
`;

        // Detect transform signature type
        const usesTextureSampling = /fn\s+dctl_transform\s*\([^)]*texture_2d/.test(dctlFunctionsWgsl);
        const dctlEntryPoint = dctlResult.entryPoint;

        // Build param init code for uniform buffer
        if (dctlOptions.useUniformBuffer && paramMapping.length > 0) {
            // Extract actual var<private> names from generated WGSL
            const actualVarNames = new Map<string, string>();
            const privateVarRegex = /var<private>\s+(\w+)\s*:\s*(?:f32|i32|bool);/g;
            let m;
            while ((m = privateVarRegex.exec(dctlFunctionsWgsl)) !== null) {
                for (const param of paramMapping) {
                    if (m[1] === param.glslName || m[1].startsWith(`${param.glslName}_`)) {
                        actualVarNames.set(param.glslName, m[1]);
                        break;
                    }
                }
            }
            const initLines = paramMapping.map(p => {
                const actualName = actualVarNames.get(p.glslName) || p.glslName;
                return `    ${actualName} = get_${p.glslName}();`;
            });
            paramInitCode = `\n    // Initialize DCTL parameters from uniform buffer\n${initLines.join('\n')}\n`;

            // Build struct fields for uniform buffer params
            paramStructFields = paramMapping.map(p => {
                const wgslType = p.type === 'float' ? 'f32' : p.type === 'int' ? 'i32' : 'u32';
                return `    ${p.glslName}: ${wgslType},`;
            }).join('\n');
        }

        // Build transform call
        let transformCall: string;
        if (usesTextureSampling) {
            transformCall = `let dctl_result = ${dctlEntryPoint}(p_Width, p_Height, p_X, p_Y, source_texture, source_texture, source_texture);`;
        } else {
            transformCall = `let dctl_result = ${dctlEntryPoint}(p_Width, p_Height, p_X, p_Y, working_color.r, working_color.g, working_color.b);`;
        }

        // Main function with DCTL
        dctlMainSection = `
@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    let p_Width = i32(params.width);
    let p_Height = i32(params.height);
    let p_X = i32(coords.x);
    let p_Y = i32(coords.y);
${paramInitCode}
    // Load source pixel and convert to working color space
    let source_color = textureLoad(source_texture, coords, 0);
    let working_color = ${swMainName}(source_color);

    // Apply DCTL transform (operates in working color space)
    ${transformCall}

    // Apply working → display transform
    let display_color = ${wdMainName}(vec4<f32>(dctl_result.x, dctl_result.y, dctl_result.z, 1.0));

    textureStore(output_texture, coords, max(display_color, vec4<f32>(0.0)));
}
`;
    }

    // Build Params struct
    const paramsStruct = hasDctl && paramStructFields
        ? `struct Params {
    width: u32,
    height: u32,
${paramStructFields}
}` : `struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}`;

    // Non-DCTL main function
    const mainFunction = hasDctl ? dctlMainSection : `
@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    let source_color = textureLoad(source_texture, coords, 0);
    let working_color = ${swMainName}(source_color);
    let display_color = ${wdMainName}(working_color);

    textureStore(output_texture, coords, max(display_color, vec4<f32>(0.0)));
}
`;

    // === Assemble complete compute shader ===
    const computeWgsl = `/**
 * Custom OCIO Compute Shader
 * Generated by custom-ocio-shader-builder
 * Mode: Custom OCIO (non-ACES)
 * DCTL: ${hasDctl ? 'Enabled' : 'Disabled'}
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
${paramsStruct}
@group(3) @binding(0) var<uniform> params: Params;

// ============================================================================
// Source → Working Transform Functions (sw_)
// ============================================================================
${swFunctions}

// ============================================================================
// Working → Display Transform Functions (wd_)
// ============================================================================
${wdFunctions}
${dctlSampleTextureWgsl}
${dctlFunctionsWgsl}
// ============================================================================
// Compute Shader Main
// ============================================================================
${mainFunction}
`;

    return {
        computeWgsl,
        textures: allTextures,
        textures3D: allTextures3D,
        bindings,
        hasDctl,
        paramMapping,
        uniformBufferBinding,
        success: true,
    };
}

/**
 * Compile DCTL source to WGSL for use in custom OCIO compute shader.
 * Handles function renaming (dctl_ prefix) and stub removal.
 */
async function compileDctlForCustomOcio(
    wasmPath: string,
    options: CustomOcioDctlOptions,
): Promise<{
    functions: string;
    paramMapping: ShaderParamMapping[];
    entryPoint: string;
    uniformBufferBinding: number;
    success: boolean;
    error?: string;
}> {
    const compiler = getDctlCompiler();
    if (!compiler.isInitialized) {
        await compiler.init(wasmPath);
    }

    const paramMapping = buildShaderParamMapping(options.params);

    const result = compiler.compile(options.dctlSource);
    if (isCompileError(result)) {
        return {
            functions: '',
            paramMapping,
            entryPoint: 'transform',
            uniformBufferBinding: 0,
            success: false,
            error: result.message,
        };
    }

    const compileResult = result as CompileResult;
    const errors = compileResult.diagnostics.filter(d => d.severity === 'error');
    if (errors.length > 0) {
        return {
            functions: '',
            paramMapping,
            entryPoint: compileResult.entry_point || 'transform',
            uniformBufferBinding: 0,
            success: false,
            error: errors.map(e => `Line ${e.line}: ${e.message}`).join('\n'),
        };
    }

    let wgsl = compileResult.wgsl;

    // Collect user-defined function names for renaming
    const userFunctionNames: Set<string> = new Set();
    const fnDefRegex = /fn\s+(\w+)\s*\(/g;
    let match;
    while ((match = fnDefRegex.exec(wgsl)) !== null) {
        const fnName = match[1];
        if (!fnName.startsWith('dctl_') && fnName !== 'main') {
            userFunctionNames.add(fnName);
        }
    }

    // Add dctl_ prefix to function definitions
    for (const fnName of userFunctionNames) {
        const defRegex = new RegExp(`\\bfn\\s+${fnName}\\s*\\(`, 'g');
        wgsl = wgsl.replace(defRegex, `fn dctl_${fnName}(`);
    }

    // Add dctl_ prefix to function calls
    for (const fnName of userFunctionNames) {
        const callRegex = new RegExp(`(?<!\\.|dctl_)\\b${fnName}\\s*\\(`, 'g');
        wgsl = wgsl.replace(callRegex, `dctl_${fnName}(`);
    }

    // Remove the Rust-generated dctl_sampleTexture stub
    wgsl = wgsl.replace(
        /fn\s+dctl_sampleTexture\([^)]*\)\s*->\s*vec4<f32>\s*\{[^}]*return\s+vec4<f32>\(0f,\s*0f,\s*0f,\s*0f\);[^}]*\}/g,
        ''
    );

    const entryPoint = compileResult.entry_point || 'transform';
    const dctlEntryPoint = entryPoint.startsWith('dctl_') ? entryPoint : `dctl_${entryPoint}`;

    // Build uniform buffer accessor functions
    let ubAccessors = '';
    if (options.useUniformBuffer && paramMapping.length > 0) {
        ubAccessors = paramMapping.map(p => {
            const wgslType = p.type === 'float' ? 'f32' : p.type === 'int' ? 'i32' : 'u32';
            return `fn get_${p.glslName}() -> ${wgslType} { return params.${p.glslName}; }`;
        }).join('\n');
    }

    return {
        functions: ubAccessors + '\n' + wgsl,
        paramMapping,
        entryPoint: dctlEntryPoint,
        uniformBufferBinding: 0,
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
