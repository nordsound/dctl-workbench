/**
 * DCTL + OCIO Compute Shader WGSL Builder
 *
 * Generates compute shader WGSL code that integrates both DCTL transforms
 * and OCIO color management. Supports fast parameter updates via Uniform Buffer.
 *
 * Processing Order:
 * 1. Load source pixel (ACES2065-1)
 * 2. Apply DCTL transform (if enabled)
 * 3. Apply OCIO display transform
 * 4. Store result
 */

import { getNagaProcessor } from '../naga/index.js';
import type { GpuShaderInfo, GpuTexture, GpuTexture3D } from '../ocio/types.js';
import type { TextureBinding, DctlShaderInfo, DctlColorSpace, DctlParam } from '../types/index.js';
import type { ShaderParamMapping, DctlShaderBuildOptions } from './dctl-shader-builder.js';
import { buildShaderParamMapping } from './dctl-shader-builder.js';
import {
    fixGlslForNaga,
    processSamplerDeclarations,
    replaceSamplerTextureCalls,
    findOcioMainFunction,
} from './glsl-utils.js';
import {
    getDctlCompiler,
    isCompileError,
    type CompileResult,
} from '../compiler/index.js';
import type { ACES2RgcShaderResult } from './aces-rgc-shader-builder.js';
import { writeLog } from '../shared/logger.js';

// Workgroup size for compute shaders
const WORKGROUP_SIZE_X = 16;
const WORKGROUP_SIZE_Y = 16;

// DCTL Uniform Buffer layout constants
// Note: WGSL uniform buffers require 16-byte alignment for array elements
// So we use vec4 arrays instead of scalar arrays
const DCTL_BUFFER_LAYOUT = {
    FLOAT_PARAMS_COUNT: 32,      // Total float params
    FLOAT_VEC4_COUNT: 8,         // 8 vec4s = 32 floats
    INT_PARAMS_COUNT: 16,        // Total int params
    INT_VEC4_COUNT: 4,           // 4 vec4s = 16 ints
    COLOR_PARAMS_COUNT: 8,
} as const;

export interface DctlComputeShaderInfo {
    /** Complete WGSL compute shader code */
    computeWgsl: string;
    /** DCTL function WGSL (if DCTL is included) */
    dctlFunctionWgsl: string;
    /** OCIO function WGSL */
    ocioFunctionWgsl: string;
    /** RGC function WGSL (if full RGC is used) */
    rgcFunctionWgsl?: string;
    /** DCTL parameter mapping for Uniform Buffer */
    paramMapping: ShaderParamMapping[];
    /** DCTL Uniform Buffer binding index */
    uniformBufferBinding: number;
    /** 2D textures (OCIO LUTs) */
    textures: GpuTexture[];
    /** 3D textures (OCIO LUTs) */
    textures3D: GpuTexture3D[];
    /** 2D textures for RGC (if full RGC is used) */
    rgcTextures?: GpuTexture[];
    /** 3D textures for RGC (if full RGC is used) */
    rgcTextures3D?: GpuTexture3D[];
    /** Texture and sampler bindings */
    bindings: TextureBinding[];
    /** RGC texture bindings (Group 4) */
    rgcBindings?: TextureBinding[];
    /** Whether DCTL is included in this shader */
    hasDctl: boolean;
    /** Whether full RGC is enabled */
    hasFullRgc?: boolean;
    /** Conversion success flag */
    success: boolean;
    /** Error message if conversion failed */
    error?: string;
}

export interface DctlComputeOptions {
    /** Whether DCTL is enabled */
    enabled?: boolean;
    /** DCTL working color space */
    workingColorSpace?: DctlColorSpace;
    /** Current parameter values (for constant mode, not used in compute) */
    paramValues?: Record<string, number | boolean | { r: number; g: number; b: number }>;
    /**
     * Use Rust WASM compiler for DCTL → WGSL conversion (default: true)
     * The Rust compiler produces WGSL directly from DCTL source.
     */
    useRustCompiler?: boolean;
    /**
     * Raw DCTL source code (required for compilation)
     * Must be provided for DCTL to work.
     */
    dctlSource?: string;
    /**
     * File path for DCTL (used for #include resolution in Rust compiler)
     */
    dctlFilePath?: string;
    /**
     * Use uniform buffer for DCTL parameters (for fast updates without shader recompilation)
     * When true, generates code to initialize private variables from uniform buffer
     */
    useUniformBuffer?: boolean;
    /**
     * Apply ACES 2.0 Reference Gamut Compression (RGC)
     * When true, applies RGC after DCTL but before OCIO display transform
     * Requires rgcShaderInfo to be provided
     */
    applyACES2GamutCompression?: boolean;
    /**
     * Peak luminance for RGC (default: 100 nits for SDR)
     */
    peakLuminance?: number;
    /**
     * Pre-extracted RGC shader info (required when applyACES2GamutCompression is true)
     * Use buildACES2RgcShader() to generate this
     */
    rgcShaderInfo?: ACES2RgcShaderResult;
}

/**
 * Build a compute shader WGSL that integrates DCTL and OCIO
 *
 * Bind Group Layout:
 * - Group 0: Source texture (texture_2d<f32>)
 * - Group 1: Output storage texture (texture_storage_2d<rgba32float, write>)
 * - Group 2: OCIO LUT textures and samplers
 * - Group 3: Parameters (width, height) + DCTL Uniform Buffer
 */
export async function buildDctlComputeShader(
    extensionPath: string,
    ocioShaderInfo: GpuShaderInfo,
    dctlShaderInfo: DctlShaderInfo | undefined,
    options?: DctlComputeOptions
): Promise<DctlComputeShaderInfo> {
    const naga = getNagaProcessor();

    // Initialize naga if not already done
    if (!naga.isInitialized) {
        await naga.init(extensionPath);
    }

    // Build OCIO WGSL functions
    const ocioResult = await buildOcioWgslFunctions(ocioShaderInfo, naga);
    if (!ocioResult.success) {
        return {
            computeWgsl: '',
            dctlFunctionWgsl: '',
            ocioFunctionWgsl: '',
            paramMapping: [],
            uniformBufferBinding: 1,
            textures: ocioShaderInfo.textures,
            textures3D: ocioShaderInfo.textures3D,
            bindings: [],
            hasDctl: false,
            success: false,
            error: ocioResult.error,
        };
    }

    // Build DCTL WGSL functions (if DCTL is provided and enabled)
    let dctlResult: { functions: string; paramMapping: ShaderParamMapping[] } | null = null;
    let hasDctl = dctlShaderInfo !== undefined && (options?.enabled ?? true);

    if (hasDctl && dctlShaderInfo) {
        // Debug: Log options
        const logMsg = `[DCTL Compute] hasDctl=${hasDctl}, useRustCompiler=${options?.useRustCompiler ?? true}, dctlSource=${options?.dctlSource ? 'exists' : 'undefined'}`;
        console.log(logMsg);
        writeLog(logMsg);

        // Use Rust compiler for DCTL → WGSL conversion
        // Default to Rust compiler if dctlSource is available
        const useRust = options?.useRustCompiler ?? true;
        if (useRust && options?.dctlSource) {
            const msg = '[DCTL Compute] Using Rust WASM compiler for direct WGSL generation';
            console.log(msg);
            writeLog(msg);
            const rustResult = await buildDctlWgslFunctionsWithRust(
                options.dctlSource,
                extensionPath,
                dctlShaderInfo.params,
                options
            );

            if (rustResult.success) {
                dctlResult = {
                    functions: rustResult.functions,
                    paramMapping: rustResult.paramMapping,
                };
                const msg = `[DCTL Compute] Rust path: DCTL functions generated: ${dctlResult.functions.length} chars`;
                console.log(msg);
                writeLog(msg);
            } else {
                // Rust compilation failed - no fallback available
                const errMsg = `[DCTL Compute] Rust compilation failed: ${rustResult.error}`;
                console.error(errMsg);
                writeLog(errMsg);
                throw new Error(`DCTL compilation failed: ${rustResult.error}`);
            }
        } else if (!options?.dctlSource) {
            // No DCTL source provided - cannot compile
            const errMsg = '[DCTL Compute] dctlSource is required for DCTL compilation';
            console.error(errMsg);
            writeLog(errMsg);
            throw new Error('dctlSource is required for DCTL compilation. The TypeScript transpiler has been removed.');
        } else {
            // Legacy GLSL path is no longer supported
            const errMsg = '[DCTL Compute] Legacy GLSL path is no longer supported. Use Rust compiler (useRustCompiler: true).';
            console.error(errMsg);
            writeLog(errMsg);
            throw new Error('Legacy GLSL path is no longer supported. Use Rust compiler with dctlSource.');
        }

        // Debug: Check if DCTL functions were generated
        const funcMsg = `[DCTL Compute] DCTL functions generated: ${dctlResult.functions.length} chars`;
        console.log(funcMsg);
        writeLog(funcMsg);
        if (!dctlResult.functions || dctlResult.functions.length === 0) {
            const warnMsg = '[DCTL Compute] DCTL functions are empty, disabling DCTL in compute shader';
            console.warn(warnMsg);
            writeLog(warnMsg);
            hasDctl = false;
        }
    }

    // Build compute shader bindings
    const bindings = buildComputeBindings(ocioShaderInfo);

    // Build parameter mapping
    const paramMapping = dctlResult?.paramMapping ?? [];

    // Build RGC options (always use full OCIO-based RGC when enabled)
    const rgcEnabled = options?.applyACES2GamutCompression ?? false;
    const rgcShaderInfo = options?.rgcShaderInfo;

    const rgcBuildOptions: RgcBuildOptions = {
        enabled: rgcEnabled && !!rgcShaderInfo,
        rgcWgsl: rgcShaderInfo?.wgslCode,
        rgcMainFunction: 'applyACES2RGC',  // Renamed from OCIODisplay to avoid conflict with main OCIO transform
        rgcTextures: rgcShaderInfo?.textures,
        rgcTextures3D: rgcShaderInfo?.textures3D,
    };

    // Build complete compute shader
    const computeWgsl = buildCompleteComputeShader(
        ocioResult.functions,
        ocioResult.mainFunctionName,
        dctlResult?.functions ?? '',
        hasDctl,
        bindings,
        ocioShaderInfo,
        paramMapping,
        rgcBuildOptions
    );

    return {
        computeWgsl,
        dctlFunctionWgsl: dctlResult?.functions ?? '',
        ocioFunctionWgsl: ocioResult.functions,
        rgcFunctionWgsl: rgcBuildOptions.enabled ? rgcShaderInfo?.wgslCode : undefined,
        paramMapping,
        uniformBufferBinding: 1, // @group(3) @binding(1)
        textures: ocioShaderInfo.textures,
        textures3D: ocioShaderInfo.textures3D,
        rgcTextures: rgcBuildOptions.enabled ? rgcShaderInfo?.textures : undefined,
        rgcTextures3D: rgcBuildOptions.enabled ? rgcShaderInfo?.textures3D : undefined,
        bindings,
        rgcBindings: rgcBuildOptions.enabled ? rgcShaderInfo?.bindings : undefined,
        hasDctl,
        hasFullRgc: rgcBuildOptions.enabled,
        success: true,
    };
}

/**
 * Build OCIO WGSL functions from GLSL
 */
async function buildOcioWgslFunctions(
    shaderInfo: GpuShaderInfo,
    naga: ReturnType<typeof getNagaProcessor>
): Promise<{ success: boolean; functions: string; mainFunctionName: string; error?: string }> {
    // Build helper fragment GLSL for naga conversion
    const { glsl: fragmentGlsl } = buildOcioHelperFragmentGlsl(shaderInfo);

    // Convert to WGSL using naga
    const conversionResult = naga.convertFragmentToWGSL(fragmentGlsl);

    if (!conversionResult.success) {
        const errMsg = `OCIO GLSL to WGSL conversion failed: ${conversionResult.error}`;
        console.error(errMsg);
        writeLog(errMsg);
        return {
            success: false,
            functions: '',
            mainFunctionName: '',
            error: conversionResult.error,
        };
    }

    // Extract OCIO functions
    const extracted = extractWgslFunctions(conversionResult.wgsl, 'OCIO');

    return {
        success: true,
        functions: extracted.functions,
        mainFunctionName: extracted.mainFunctionName,
    };
}

/**
 * Build DCTL WGSL functions using Rust WASM compiler
 *
 * This is the direct path: DCTL source → Rust compiler → WGSL
 * No intermediate GLSL step, more accurate type handling.
 */
async function buildDctlWgslFunctionsWithRust(
    dctlSource: string,
    extensionPath: string,
    params: DctlParam[],
    options?: DctlComputeOptions
): Promise<{ functions: string; paramMapping: ShaderParamMapping[]; entryPoint: string; success: boolean; error?: string }> {
    const rustCompiler = getDctlCompiler();

    // Initialize Rust compiler if needed
    if (!rustCompiler.isInitialized) {
        try {
            await rustCompiler.init(extensionPath);
        } catch (err) {
            const errMsg = `[DCTL Compute] Failed to initialize Rust compiler: ${err}`;
            console.error(errMsg);
            writeLog(errMsg);
            return {
                functions: '',
                paramMapping: [],
                entryPoint: 'transform',
                success: false,
                error: `Rust compiler initialization failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    // Build parameter mapping
    const paramMapping = buildShaderParamMapping(params);

    // Compile DCTL to WGSL using Rust compiler
    try {
        const compileOptions = options?.dctlFilePath ? { mainFilePath: options.dctlFilePath } : undefined;
        const result = rustCompiler.compile(dctlSource, compileOptions);

        if (isCompileError(result)) {
            const errMsg = `[DCTL Compute] Rust compilation failed: ${result.message}`;
            console.error(errMsg);
            writeLog(errMsg);
            return {
                functions: '',
                paramMapping,
                entryPoint: 'transform',
                success: false,
                error: result.message,
            };
        }

        const compileResult = result as CompileResult;

        // Check for errors in diagnostics
        const errors = compileResult.diagnostics.filter(d => d.severity === 'error');
        if (errors.length > 0) {
            const errorMsg = errors.map(e => `Line ${e.line}: ${e.message}`).join('\n');
            const errLogMsg = `[DCTL Compute] Rust compilation errors: ${errorMsg}`;
            console.error(errLogMsg);
            writeLog(errLogMsg);
            return {
                functions: '',
                paramMapping,
                entryPoint: compileResult.entry_point || 'transform',
                success: false,
                error: errorMsg,
            };
        }

        const successMsg1 = `[DCTL Compute] Rust compilation success, WGSL length: ${compileResult.wgsl.length}`;
        console.log(successMsg1);
        writeLog(successMsg1);
        const successMsg2 = `[DCTL Compute] Entry point: ${compileResult.entry_point}`;
        console.log(successMsg2);
        writeLog(successMsg2);

        // Debug: Log first 2000 chars of generated WGSL to check for builtins
        const wgslPreviewMsg = `[DCTL Compute] Rust WGSL preview (first 2000 chars):\n${compileResult.wgsl.substring(0, 2000)}`;
        console.log(wgslPreviewMsg);
        writeLog(wgslPreviewMsg);

        // The Rust compiler generates a complete WGSL module with a stub dctl_sampleTexture
        // We need to:
        // 1. Remove the stub dctl_sampleTexture (returns vec4(0.0))
        // 2. Add built-in variables and working implementation of dctl_sampleTexture
        let wgslFunctions = compileResult.wgsl;

        // Step 1: Collect all user-defined function names (those we need to rename)
        const userFunctionNames: Set<string> = new Set();
        const fnDefRegex = /fn\s+(\w+)\s*\(/g;
        let match;
        while ((match = fnDefRegex.exec(wgslFunctions)) !== null) {
            const fnName = match[1];
            // Skip if already has dctl_ prefix or is a WGSL built-in
            if (!fnName.startsWith('dctl_') && fnName !== 'main') {
                userFunctionNames.add(fnName);
            }
        }

        const funcListMsg = `[DCTL Compute] User-defined functions to rename: ${Array.from(userFunctionNames).join(', ')}`;
        console.log(funcListMsg);
        writeLog(funcListMsg);

        // Step 2: Add dctl_ prefix to function definitions
        for (const fnName of userFunctionNames) {
            // Replace fn <name>( with fn dctl_<name>(
            const defRegex = new RegExp(`\\bfn\\s+${fnName}\\s*\\(`, 'g');
            wgslFunctions = wgslFunctions.replace(defRegex, `fn dctl_${fnName}(`);
        }

        // Step 3: Add dctl_ prefix to function calls
        for (const fnName of userFunctionNames) {
            // Replace <name>( with dctl_<name>(
            // Use word boundary to avoid partial matches
            // Negative lookbehind to avoid matching if already has dctl_ or is after a dot (method call)
            const callRegex = new RegExp(`(?<!\\.|dctl_)\\b${fnName}\\s*\\(`, 'g');
            wgslFunctions = wgslFunctions.replace(callRegex, `dctl_${fnName}(`);
        }

        // Step 3: Remove the Rust-generated dctl_sampleTexture stub function
        // Pattern: fn dctl_sampleTexture(...) { ... return vec4<f32>(0f, 0f, 0f, 0f); }
        const sampleTextureFnRegex = /fn\s+dctl_sampleTexture\([^)]*\)\s*->\s*vec4<f32>\s*\{[^}]*return\s+vec4<f32>\(0f,\s*0f,\s*0f,\s*0f\);[^}]*\}/g;
        wgslFunctions = wgslFunctions.replace(sampleTextureFnRegex, '');

        const logMsg = `[DCTL Compute] Added dctl_ prefix and removed stub, WGSL length: ${wgslFunctions.length}`;
        console.log(logMsg);
        writeLog(logMsg);

        // Get working color space from options
        const workingColorSpace = options?.workingColorSpace || 'ACEScg';

        // Build color-space-dependent WGSL code
        const dctlBuiltins = buildDctlBuiltins(workingColorSpace);

        // Build applyDCTL wrapper that calls the entry point
        const entryPoint = compileResult.entry_point || 'transform';
        // Add dctl_ prefix to entry point to match the renamed function
        const dctlEntryPoint = entryPoint.startsWith('dctl_') ? entryPoint : `dctl_${entryPoint}`;

        // Generate parameter initialization code if using uniform buffer
        // The Rust compiler generates var<private> parameters but doesn't initialize them
        // We need to initialize them from the uniform buffer before calling the transform
        // IMPORTANT: Rust compiler may rename variables (e.g., dmax -> dmax_2) to avoid collisions
        // Extract actual variable names from generated WGSL
        let paramInitCode = '';
        if (options?.useUniformBuffer && paramMapping.length > 0) {
            const actualVarNames = new Map<string, string>();

            // Parse generated WGSL to find actual var<private> declarations
            // Pattern: var<private> varname: type;
            const privateVarRegex = /var<private>\s+(\w+)\s*:\s*(?:f32|i32|bool);/g;
            let match;
            while ((match = privateVarRegex.exec(wgslFunctions)) !== null) {
                const actualVarName = match[1];
                // Check if this matches any parameter name (with possible suffix)
                for (const param of paramMapping) {
                    // Match exact name or name with _N suffix (e.g., dmax or dmax_2)
                    if (actualVarName === param.glslName || actualVarName.startsWith(`${param.glslName}_`)) {
                        actualVarNames.set(param.glslName, actualVarName);
                        break;
                    }
                }
            }

            const initLines = paramMapping.map(param => {
                const actualName = actualVarNames.get(param.glslName) || param.glslName;
                return `    ${actualName} = get_${param.glslName}();`;
            });
            paramInitCode = `\n    // Initialize DCTL parameters from uniform buffer\n${initLines.join('\n')}\n`;
        }

        // Detect transform signature to determine if it uses texture sampling
        const transformSignatureRegex = /fn\s+dctl_transform\s*\([^)]*texture_2d/;
        const usesTextureSampling = transformSignatureRegex.test(wgslFunctions);

        const logMsg2 = `[DCTL Compute] Transform signature: ${usesTextureSampling ? 'Texture sampling' : 'Color values'}`;
        console.log(logMsg2);
        writeLog(logMsg2);

        // Generate appropriate transform call based on signature
        let transformCall;
        if (usesTextureSampling) {
            // Texture sampling version: pass source_texture
            transformCall = `let result = ${dctlEntryPoint}(p_Width, p_Height, p_X, p_Y, source_texture, source_texture, source_texture);`;
        } else {
            // Color values version: pass individual color components
            transformCall = `let result = ${dctlEntryPoint}(p_Width, p_Height, p_X, p_Y, workingColor.r, workingColor.g, workingColor.b);`;
        }

        // Generate applyDCTL wrapper and finalize builtins
        const { applyDctlWrapper, finalBuiltins } = buildApplyDctlAndBuiltins(
            workingColorSpace, dctlBuiltins, dctlEntryPoint, transformCall, paramInitCode, options
        );

        // Combine builtins, WGSL functions, and wrapper
        const completeFunctions = finalBuiltins + '\n' + wgslFunctions + '\n' + applyDctlWrapper;

        return {
            functions: completeFunctions,
            paramMapping,
            entryPoint,
            success: true,
        };
    } catch (err) {
        const errMsg = `[DCTL Compute] Rust compilation threw exception: ${err}`;
        console.error(errMsg);
        writeLog(errMsg);
        return {
            functions: '',
            paramMapping,
            entryPoint: 'transform',
            success: false,
            error: `Rust compilation error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * Build DCTL built-in variables and helper functions based on working color space
 */
function buildDctlBuiltins(workingColorSpace: DctlColorSpace): string {
    let matrixDecl = '';
    let sampleTextureConversion = '';

    // AP0 to AP1 matrix (used by all color spaces for RGC)
    const ap0ToAp1MatrixCode = `
// AP0 to AP1 (ACEScg) Matrix
const dctl_ap0ToAp1: mat3x3<f32> = mat3x3<f32>(
    vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
    vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
    vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
);
`;
    // AP1 to AP0 matrix (used by ACES2065-1 and linear_sRGB for RGC → working conversion)
    const ap1ToAp0MatrixCode = `// AP1 to AP0 Matrix
const dctl_ap1ToAp0: mat3x3<f32> = mat3x3<f32>(
    vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
    vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
    vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
);
`;

    if (workingColorSpace === 'ACES2065-1') {
        // Working space is AP0; route through AP1 for RGC support
        matrixDecl = ap0ToAp1MatrixCode + ap1ToAp0MatrixCode;
        sampleTextureConversion = `    var ap1 = dctl_ap0ToAp1 * sampled.rgb;
    // RGC_TAG: This will be replaced with RGC call when enabled
    var workingRgb = dctl_ap1ToAp0 * ap1;`;
    } else if (workingColorSpace === 'linear_sRGB') {
        matrixDecl = `
// AP0 to linear sRGB Matrix
const dctl_ap0ToWorking: mat3x3<f32> = mat3x3<f32>(
    vec3<f32>(2.5216494298, -0.2752135512, -0.0159250101),
    vec3<f32>(-1.1368885542, 1.3697051510, -0.1478063681),
    vec3<f32>(-0.3849175932, -0.0943924508, 1.1638276817)
);
` + ap0ToAp1MatrixCode + ap1ToAp0MatrixCode;
        // Route through AP1 for RGC, then AP1 → AP0 → sRGB for working space
        sampleTextureConversion = `    var ap1 = dctl_ap0ToAp1 * sampled.rgb;
    // RGC_TAG: This will be replaced with RGC call when enabled
    var workingRgb = dctl_ap0ToWorking * (dctl_ap1ToAp0 * ap1);`;
    } else {
        // ACEScg, ACEScct, ACEScc all use AP1 primaries
        // AP0→AP1 matrix serves as both the working matrix and the RGC matrix
        matrixDecl = `
// AP0 to AP1 (ACEScg) Matrix
const dctl_ap0ToWorking: mat3x3<f32> = mat3x3<f32>(
    vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
    vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
    vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
);
`;
        if (workingColorSpace === 'ACEScct') {
            sampleTextureConversion = `    var ap1 = dctl_ap0ToWorking * sampled.rgb;
    // RGC_TAG: This will be replaced with RGC call when enabled
    var workingRgb = lin_to_ACEScct(ap1);`;
        } else if (workingColorSpace === 'ACEScc') {
            sampleTextureConversion = `    var ap1 = dctl_ap0ToWorking * sampled.rgb;
    // RGC_TAG: This will be replaced with RGC call when enabled
    var workingRgb = lin_to_ACEScc(ap1);`;
        } else {
            // ACEScg - linear AP1
            sampleTextureConversion = `    var ap1 = dctl_ap0ToWorking * sampled.rgb;
    // RGC_TAG: This will be replaced with RGC call when enabled
    var workingRgb = ap1;`;
        }
    }

    // Log conversion functions (only when needed)
    let logFunctions = '';
    if (workingColorSpace === 'ACEScct') {
        logFunctions = `
// ACEScct to Linear (AP1)
fn ACEScct_to_lin(cct: vec3<f32>) -> vec3<f32> {
    const cut = 0.155251141552511;
    const a = 10.5402377416545;
    const b = 0.0729055341958355;
    var result: vec3<f32>;
    for (var i = 0; i < 3; i++) {
        let x = cct[i];
        if (x <= cut) {
            result[i] = (x - b) / a;
        } else {
            result[i] = pow(2.0, x * 17.52 - 9.72);
        }
    }
    return result;
}

// Linear (AP1) to ACEScct
fn lin_to_ACEScct(lin: vec3<f32>) -> vec3<f32> {
    const cut = 0.0078125;
    const a = 10.5402377416545;
    const b = 0.0729055341958355;
    var result: vec3<f32>;
    for (var i = 0; i < 3; i++) {
        let x = lin[i];
        if (x <= cut) {
            result[i] = a * x + b;
        } else {
            result[i] = (log2(x) + 9.72) / 17.52;
        }
    }
    return result;
}
`;
    } else if (workingColorSpace === 'ACEScc') {
        logFunctions = `
// ACEScc to Linear (AP1)
fn ACEScc_to_lin(cc: vec3<f32>) -> vec3<f32> {
    var result: vec3<f32>;
    for (var i = 0; i < 3; i++) {
        let x = cc[i];
        if (x < -0.3013698630) {
            // Below mid-gray
            result[i] = (pow(2.0, x * 17.52 - 9.72) - pow(2.0, -16.0)) * 2.0;
        } else if (x < (log2(65504.0) + 9.72) / 17.52) {
            result[i] = pow(2.0, x * 17.52 - 9.72);
        } else {
            result[i] = 65504.0;
        }
    }
    return result;
}

// Linear (AP1) to ACEScc
fn lin_to_ACEScc(lin: vec3<f32>) -> vec3<f32> {
    var result: vec3<f32>;
    for (var i = 0; i < 3; i++) {
        let x = lin[i];
        if (x <= 0.0) {
            result[i] = (log2(pow(2.0, -15.0)) + 9.72) / 17.52;
        } else if (x < pow(2.0, -15.0)) {
            result[i] = (log2(pow(2.0, -16.0) + x * 0.5) + 9.72) / 17.52;
        } else {
            result[i] = (log2(x) + 9.72) / 17.52;
        }
    }
    return result;
}
`;
    }

    return `
// DCTL built-in variables (set from compute shader main)
var<private> p_X: i32;
var<private> p_Y: i32;
var<private> p_Width: i32;
var<private> p_Height: i32;
var<private> TIMELINE_FRAME_INDEX: i32 = 0i;
var<private> TRANSITION_PROGRESS: f32 = 0f;
var<private> _RESOLVE_VER_MAJOR__: i32 = 19i;
var<private> _RESOLVE_VER_MINOR__: i32 = 0i;
${matrixDecl}${logFunctions}
// DCTL Texture Sampling Function (Working Color Space: ${workingColorSpace})
fn dctl_sampleTexture(x: i32, y: i32) -> vec4<f32> {
    let clampedX = clamp(x, 0i, p_Width - 1i);
    let clampedY = clamp(y, 0i, p_Height - 1i);
    let sampled = textureLoad(source_texture, vec2<u32>(u32(clampedX), u32(clampedY)), 0);
${sampleTextureConversion}
    return vec4<f32>(workingRgb, sampled.a);
}
`;
}

/**
 * Build applyDCTL wrapper function and finalize builtins with RGC/color space tags
 */
function buildApplyDctlAndBuiltins(
    workingColorSpace: DctlColorSpace,
    dctlBuiltins: string,
    dctlEntryPoint: string,
    transformCall: string,
    paramInitCode: string,
    options?: DctlComputeOptions
): { applyDctlWrapper: string; finalBuiltins: string } {
    // Generate color space conversion code for applyDCTL
    let colorSpaceConversion = '';
    let colorSpaceDeconversion = '';
    // AP1 to AP0 matrix (used for ACEScg/ACEScct/ACEScc)
    const ap1ToAp0Code = `    let ap1ToAp0 = mat3x3<f32>(
        vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
        vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
        vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
    );`;
    // sRGB to AP0 matrix
    const srgbToAp0Code = `    let srgbToAp0 = mat3x3<f32>(
        vec3<f32>(0.4395722998, 0.0895766616, 0.0173096404),
        vec3<f32>(0.3839185441, 0.8150065542, 0.1095964685),
        vec3<f32>(0.1765091561, 0.0954167842, 0.8730938911)
    );`;

    switch (workingColorSpace) {
        case 'ACEScct':
            colorSpaceConversion = `    // AP0 -> AP1 (ACEScg) -> ACEScct
    let acescg = dctl_ap0ToWorking * color;
    let workingColor = lin_to_ACEScct(acescg);`;
            colorSpaceDeconversion = `    // ACEScct -> AP1 (ACEScg) -> AP0
    let resultLinear = ACEScct_to_lin(result);
${ap1ToAp0Code}
    return ap1ToAp0 * resultLinear;`;
            break;
        case 'ACEScc':
            colorSpaceConversion = `    // AP0 -> AP1 (ACEScg) -> ACEScc
    let acescg = dctl_ap0ToWorking * color;
    let workingColor = lin_to_ACEScc(acescg);`;
            colorSpaceDeconversion = `    // ACEScc -> AP1 (ACEScg) -> AP0
    let resultLinear = ACEScc_to_lin(result);
${ap1ToAp0Code}
    return ap1ToAp0 * resultLinear;`;
            break;
        case 'ACEScg':
            colorSpaceConversion = `    // AP0 -> AP1 (ACEScg)
    let workingColor = dctl_ap0ToWorking * color;`;
            colorSpaceDeconversion = `    // AP1 (ACEScg) -> AP0
${ap1ToAp0Code}
    return ap1ToAp0 * result;`;
            break;
        case 'ACES2065-1':
            colorSpaceConversion = `    // Already in AP0 (ACES2065-1) - no conversion needed
    let workingColor = color;`;
            colorSpaceDeconversion = `    // Already in AP0 - no conversion needed
    return result;`;
            break;
        case 'linear_sRGB':
            colorSpaceConversion = `    // AP0 -> linear sRGB
    let workingColor = dctl_ap0ToWorking * color;`;
            colorSpaceDeconversion = `    // linear sRGB -> AP0
${srgbToAp0Code}
    return srgbToAp0 * result;`;
            break;
    }

    const applyDctlWrapper = `
// DCTL Wrapper Function (Working Color Space: ${workingColorSpace})
fn applyDCTL(color: vec3<f32>) -> vec3<f32> {
    // Input color is in AP0 (ACES2065-1)
${colorSpaceConversion}
${paramInitCode}
    ${transformCall}

${colorSpaceDeconversion}
}
`;

    // Apply RGC to dctl_sampleTexture when enabled
    let finalBuiltins = dctlBuiltins;
    const rgcEnabled = options?.applyACES2GamutCompression ?? false;
    if (rgcEnabled) {
        finalBuiltins = finalBuiltins.replace(
            '// RGC_TAG: This will be replaced with RGC call when enabled',
            '// Apply ACES 2.0 Reference Gamut Compression (AP1 -> AP1)\n    ap1 = applyACES2RGC(vec4<f32>(ap1, 1.0)).rgb;'
        );
    } else {
        finalBuiltins = finalBuiltins.replace(
            '// RGC_TAG: This will be replaced with RGC call when enabled\n',
            ''
        );
    }

    return { applyDctlWrapper, finalBuiltins };
}

/**
 * Build helper fragment GLSL for OCIO naga conversion
 */
function buildOcioHelperFragmentGlsl(shaderInfo: GpuShaderInfo): {
    glsl: string;
    bindings: TextureBinding[];
} {
    // Apply GLSL fixes for naga compatibility
    let code = fixGlslForNaga(shaderInfo.shaderText);

    // Process sampler declarations
    const samplerResult = processSamplerDeclarations(code, 0);
    code = samplerResult.code;
    const bindings = samplerResult.bindings;

    // Replace texture() calls
    code = replaceSamplerTextureCalls(code, samplerResult.declarations);

    // Find the main OCIO function name
    const ocioMainFunc = findOcioMainFunction(code);

    // Build minimal fragment shader for conversion
    const completeGlsl = `#version 450

layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

${code}

void main() {
    fragColor = ${ocioMainFunc}(vec4(0.0));
}
`;

    return { glsl: completeGlsl, bindings };
}

/**
 * Extract functions from converted WGSL code
 */
function extractWgslFunctions(
    wgslCode: string,
    type: 'OCIO' | 'DCTL'
): { functions: string; mainFunctionName: string } {
    // Find the main function and extract everything before it
    const mainMatch = wgslCode.match(/fn\s+main\s*\(/);
    if (!mainMatch || mainMatch.index === undefined) {
        return { functions: wgslCode, mainFunctionName: type === 'OCIO' ? 'OCIODisplay' : 'applyDCTL' };
    }

    // Extract everything before main()
    let functions = wgslCode.substring(0, mainMatch.index);

    // Remove @fragment and @compute decorators
    functions = functions.replace(/@fragment\s*/g, '');
    functions = functions.replace(/@compute\s*@workgroup_size\([^)]+\)\s*/g, '');

    if (type === 'DCTL') {
        // For DCTL, remove elements that will be redefined in buildCompleteComputeShader:
        // 1. Remove 'struct Params' (we define our own in the complete shader)
        functions = functions.replace(/struct\s+Params\s*\{[^}]*\}\s*/g, '');
        // 2. Remove global uniform binding (we define our own)
        functions = functions.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var<uniform>\s+global\s*:\s*Params\s*;?\s*/g, '');
        // 3. Remove main_1() function (Naga's transformed main)
        functions = functions.replace(/fn\s+main_1\s*\([^)]*\)\s*\{[\s\S]*?\n\}\s*/g, '');
        // 4. Remove source_image and output_image bindings (defined in complete shader as source_texture/output_texture)
        functions = functions.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var\s+source_image\s*:[^;]+;?\s*/g, '');
        functions = functions.replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var\s+output_image\s*:[^;]+;?\s*/g, '');
        // 5. Convert textureLoad(source_image, coords) to textureLoad(source_texture, coords, 0)
        // GLSL imageLoad (storage texture) -> WGSL textureLoad needs mip level 0 for texture_2d
        functions = functions.replace(
            /textureLoad\s*\(\s*source_image\s*,\s*([^)]+)\s*\)/g,
            'textureLoad(source_texture, $1, 0)'
        );
        // 6. Rename remaining source_image/output_image references to match complete shader names
        functions = functions.replace(/\bsource_image\b/g, 'source_texture');
        functions = functions.replace(/\boutput_image\b/g, 'output_texture');
        // 7. Remove gl_GlobalInvocationID variable
        functions = functions.replace(/var<private>\s+gl_GlobalInvocationID_\d+\s*:[^;]+;?\s*/g, '');
    }

    // Find the main function name
    let mainFunctionName: string;
    if (type === 'OCIO') {
        const ocioMatch = functions.match(/fn\s+(OCIODisplay|ocio_main|OCIOMain)\s*\(/);
        mainFunctionName = ocioMatch ? ocioMatch[1] : 'OCIODisplay';
    } else {
        const dctlMatch = functions.match(/fn\s+(applyDCTL|dctl_transform)\s*\(/);
        mainFunctionName = dctlMatch ? dctlMatch[1] : 'applyDCTL';
    }

    return { functions, mainFunctionName };
}

/**
 * Build compute shader bindings
 */
function buildComputeBindings(shaderInfo: GpuShaderInfo): TextureBinding[] {
    const bindings: TextureBinding[] = [];
    let bindingIndex = 0;

    // Group 2: OCIO textures
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
 */
function replaceTextureSampleWithLevel(code: string): string {
    let result = '';
    let i = 0;

    while (i < code.length) {
        const match = code.substring(i).match(/^textureSample\s*\(/);
        if (match && !code.substring(i).startsWith('textureSampleLevel')) {
            const startIdx = i;
            i += match[0].length;

            // Find closing parenthesis
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
 * RGC options for compute shader
 */
interface RgcBuildOptions {
    enabled: boolean;
    /** RGC WGSL code from OCIO (required when enabled) */
    rgcWgsl?: string;
    /** Main RGC function name to call (e.g., 'OCIODisplay') */
    rgcMainFunction?: string;
    /** RGC textures for binding declarations */
    rgcTextures?: GpuTexture[];
    rgcTextures3D?: GpuTexture3D[];
}

/**
 * Build complete compute shader WGSL code
 */
function buildCompleteComputeShader(
    ocioFunctions: string,
    ocioMainFunction: string,
    dctlFunctions: string,
    hasDctl: boolean,
    bindings: TextureBinding[],
    shaderInfo: GpuShaderInfo,
    paramMapping: ShaderParamMapping[],
    rgcOptions: RgcBuildOptions = { enabled: false }
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

    // Process OCIO functions
    let processedOcioFunctions = ocioFunctions;
    processedOcioFunctions = processedOcioFunctions.replace(/@group\(0\)/g, '@group(2)');
    processedOcioFunctions = processedOcioFunctions.replace(
        /@group\(2\)\s*@binding\(\d+\)\s*var\s+\w+\s*:\s*(texture_2d|texture_3d|sampler)[^;]*;/g,
        ''
    );
    processedOcioFunctions = replaceTextureSampleWithLevel(processedOcioFunctions);

    // Build DCTL Uniform Buffer declaration
    const dctlUniformBuffer = hasDctl ? `
// ============================================================================
// DCTL Parameters Uniform Buffer
// ============================================================================
struct DctlParams {
    enabled: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
    // Note: Using vec4 arrays for 16-byte alignment requirement
    float_params: array<vec4<f32>, ${DCTL_BUFFER_LAYOUT.FLOAT_VEC4_COUNT}>,  // 8 vec4s = 32 floats
    int_params: array<vec4<i32>, ${DCTL_BUFFER_LAYOUT.INT_VEC4_COUNT}>,      // 4 vec4s = 16 ints
    color_params: array<vec4<f32>, ${DCTL_BUFFER_LAYOUT.COLOR_PARAMS_COUNT}>,
}
@group(3) @binding(1) var<uniform> dctl_params: DctlParams;

// DCTL parameter accessor macros
${buildDctlParamAccessors(paramMapping)}
` : '';

    // Process DCTL functions
    let processedDctlFunctions = '';
    if (hasDctl && dctlFunctions) {
        processedDctlFunctions = dctlFunctions;
        // Remove any duplicate uniform buffer declarations
        processedDctlFunctions = processedDctlFunctions.replace(
            /@group\(3\)\s*@binding\(\d+\)\s*var<uniform>\s+\w+\s*:\s*\w+[^;]*;/g,
            ''
        );
        processedDctlFunctions = replaceTextureSampleWithLevel(processedDctlFunctions);
    }

    // Build RGC texture bindings (Group 2 - merged with OCIO bindings)
    // Note: RGC bindings use the same group (2) as OCIO, continuing from bindingIndex
    let rgcBindings = '';
    let rgcFunctions = '';
    if (rgcOptions.enabled && rgcOptions.rgcWgsl) {
        // Continue binding index from where OCIO bindings ended
        // Add RGC 2D texture bindings
        if (rgcOptions.rgcTextures) {
            for (const tex of rgcOptions.rgcTextures) {
                const texName = `rgc_${tex.samplerName}_tex`;
                const samplerName = `rgc_${tex.samplerName}_samp`;
                rgcBindings += `@group(2) @binding(${bindingIndex++}) var ${texName}: texture_2d<f32>;\n`;
                rgcBindings += `@group(2) @binding(${bindingIndex++}) var ${samplerName}: sampler;\n`;
            }
        }

        // Add RGC 3D texture bindings
        if (rgcOptions.rgcTextures3D) {
            for (const tex of rgcOptions.rgcTextures3D) {
                const texName = `rgc_${tex.samplerName}_tex`;
                const samplerName = `rgc_${tex.samplerName}_samp`;
                rgcBindings += `@group(2) @binding(${bindingIndex++}) var ${texName}: texture_3d<f32>;\n`;
                rgcBindings += `@group(2) @binding(${bindingIndex++}) var ${samplerName}: sampler;\n`;
            }
        }

        // Process RGC WGSL functions
        // 1. Remove binding declarations (we create our own in rgcBindings)
        // 2. Remove fragment shader entry point and I/O structs
        // 3. Prefix texture/sampler references to use rgc_ names
        // 4. Keep only function code

        // Debug: Check for array declarations before processing
        const hasArrayBefore = rgcOptions.rgcWgsl.includes('hues_array');
        writeLog(`[RGC Debug] Input has hues_array: ${hasArrayBefore}`);
        if (hasArrayBefore) {
            // Extract the actual array declaration line for debugging
            const arrayMatch = rgcOptions.rgcWgsl.match(/var<private>\s+\w*hues_array[^;]+;/);
            writeLog(`[RGC Debug] Array declaration found: ${arrayMatch?.[0]}`);
        }

        // First, extract array declarations to preserve them
        // These are var<private> declarations with array types (e.g., array<i32, 360>)
        const arrayDeclarations: string[] = [];
        const arrayDeclRegex = /var<private>\s+(\w+)\s*:\s*array<[^>]+>[^;]*;/g;
        let arrayMatch;
        while ((arrayMatch = arrayDeclRegex.exec(rgcOptions.rgcWgsl)) !== null) {
            arrayDeclarations.push(arrayMatch[0]);
            writeLog(`[RGC Debug] Extracted array declaration: ${arrayMatch[0]}`);
        }

        rgcFunctions = rgcOptions.rgcWgsl
            // Remove all binding declarations (texture, sampler, uniform)
            .replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var\s+\w+\s*:\s*(texture_2d|texture_3d|sampler)[^;]*;/g, '')
            // Remove any uniform declarations
            .replace(/@group\(\d+\)\s*@binding\(\d+\)\s*var<uniform>[^;]+;/g, '')
            // Remove struct declarations (FragmentOutput, VertexOutput, Params, etc.)
            .replace(/struct\s+(FragmentOutput|VertexOutput|\w+Params)\s*\{[^}]*\}\s*/g, '')
            // Remove only fragment I/O var<private> declarations (not arrays/data)
            // Keep array declarations like ocio_gamut_cusp_table_0_hues_array
            .replace(/var<private>\s+(v_texCoord_\d*|fragColor|gl_\w+)\s*:\s*[^;]+;/g, '')
            // Remove @fragment fn main and everything after (entry point is at the end)
            .replace(/@fragment[\s\S]*$/m, '')
            // Also remove any fn main_1 helper function that naga might generate
            .replace(/fn\s+main_1\s*\(\s*\)\s*\{[\s\S]*?\n\}\s*\n?/gm, '')
            // Clean up any empty lines
            .replace(/\n\s*\n\s*\n/g, '\n\n')
            .trim();

        // Debug: Check if array declaration survived processing
        const hasArrayAfter = rgcFunctions.includes('hues_array');
        writeLog(`[RGC Debug] After processing has hues_array: ${hasArrayAfter}`);

        // If array declarations were removed, add them back
        if (arrayDeclarations.length > 0 && !hasArrayAfter) {
            writeLog(`[RGC Debug] Re-adding ${arrayDeclarations.length} array declarations that were removed`);
            rgcFunctions = arrayDeclarations.join('\n') + '\n\n' + rgcFunctions;
        }

        // Prefix texture/sampler references with rgc_ for RGC textures
        if (rgcOptions.rgcTextures) {
            for (const tex of rgcOptions.rgcTextures) {
                const name = tex.samplerName;
                rgcFunctions = rgcFunctions
                    .replace(new RegExp(`\\b${name}_tex\\b`, 'g'), `rgc_${name}_tex`)
                    .replace(new RegExp(`\\b${name}_samp\\b`, 'g'), `rgc_${name}_samp`);
            }
        }
        if (rgcOptions.rgcTextures3D) {
            for (const tex of rgcOptions.rgcTextures3D) {
                const name = tex.samplerName;
                rgcFunctions = rgcFunctions
                    .replace(new RegExp(`\\b${name}_tex\\b`, 'g'), `rgc_${name}_tex`)
                    .replace(new RegExp(`\\b${name}_samp\\b`, 'g'), `rgc_${name}_samp`);
            }
        }

        // Convert textureSample to textureSampleLevel for compute shader compatibility
        // textureSample uses implicit derivatives which aren't available in compute shaders
        // Use the robust helper function that properly handles nested parentheses
        rgcFunctions = replaceTextureSampleWithLevel(rgcFunctions);

        // Rename OCIODisplay to applyACES2RGC to avoid conflict with main OCIO display transform
        rgcFunctions = rgcFunctions
            .replace(/fn\s+OCIODisplay\s*\(/g, 'fn applyACES2RGC(')
            .replace(/fn\s+ocio_main\s*\(/g, 'fn applyACES2RGC(')
            .replace(/fn\s+OCIOMain\s*\(/g, 'fn applyACES2RGC(');

        // Prefix ALL ocio_ functions with rgc_ to avoid conflicts with OCIO display transform
        // This handles helper functions like ocio_reach_m_table_0_sample, ocio_get_focus_gain0_, etc.
        // Find all ocio_ function names and prefix them
        const ocioFunctionPattern = /\bocio_(\w+)/g;
        rgcFunctions = rgcFunctions.replace(ocioFunctionPattern, 'rgc_ocio_$1');

        // Debug: Log RGC processing results
        writeLog(`[RGC Debug] Input WGSL length: ${rgcOptions.rgcWgsl.length}`);
        writeLog(`[RGC Debug] Processed functions length: ${rgcFunctions.length}`);
        writeLog(`[RGC Debug] Has applyACES2RGC function: ${rgcFunctions.includes('fn applyACES2RGC')}`);
        writeLog(`[RGC Debug] Textures: 2D=${rgcOptions.rgcTextures?.length ?? 0}, 3D=${rgcOptions.rgcTextures3D?.length ?? 0}`);

        // Verify array declarations are present after renaming
        const hasRenamedArray = rgcFunctions.includes('rgc_ocio_gamut_cusp_table_0_hues_array');
        writeLog(`[RGC Debug] Has renamed hues_array: ${hasRenamedArray}`);
        if (!hasRenamedArray && rgcFunctions.includes('hues_array')) {
            // Array exists but wasn't renamed - something went wrong
            writeLog(`[RGC Debug] ERROR: hues_array exists but wasn't renamed to rgc_ocio_`);
        }
        if (!hasRenamedArray && !rgcFunctions.includes('hues_array')) {
            // Array was completely lost
            writeLog(`[RGC Debug] ERROR: hues_array declaration is missing entirely!`);
        }

        writeLog(`[RGC Debug] RGC bindings:\n${rgcBindings}`);
        // Log first 500 chars of processed functions
        writeLog(`[RGC Debug] Processed functions (first 500 chars):\n${rgcFunctions.substring(0, 500)}`);
    }

    // Build main function
    const mainFunction = buildMainFunction(ocioMainFunction, hasDctl, rgcOptions);

    const rgcModeComment = rgcOptions.enabled
        ? 'RGC: Enabled (OCIO-based)'
        : 'RGC: Disabled';

    return `/**
 * DCTL + OCIO Compute Shader
 * Generated by dctl-compute-wgsl-builder
 * DCTL: ${hasDctl ? 'Enabled' : 'Disabled'}
 * ${rgcModeComment}
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

${dctlUniformBuffer}

${rgcOptions.enabled && rgcBindings ? `
// ============================================================================
// Bind Group 4: RGC LUT Textures
// ============================================================================
${rgcBindings}
` : ''}

// ============================================================================
// OCIO Transform Functions
// ============================================================================
${processedOcioFunctions}

${rgcOptions.enabled && rgcFunctions ? `
// ============================================================================
// RGC Transform Functions (ACES 2.0 Reference Gamut Compression)
// ============================================================================
${rgcFunctions}
` : ''}

${hasDctl ? `
// ============================================================================
// DCTL Transform Functions
// ============================================================================
${processedDctlFunctions}
` : ''}

// ============================================================================
// Compute Shader Main
// ============================================================================
${mainFunction}
`;
}

/**
 * Build DCTL parameter accessor functions
 * Note: float_params and int_params use vec4 arrays for 16-byte alignment
 * Access pattern: array[index / 4][index % 4]
 */
export function buildDctlParamAccessors(paramMapping: ShaderParamMapping[]): string {
    const lines: string[] = [];

    for (const param of paramMapping) {
        const vec4Index = Math.floor(param.index / 4);
        const componentIndex = param.index % 4;

        switch (param.type) {
            case 'float':
                // Access vec4 element: float_params[vec4_idx][component_idx]
                lines.push(`fn get_${param.glslName}() -> f32 { return dctl_params.float_params[${vec4Index}][${componentIndex}]; }`);
                break;
            case 'int':
                // Access vec4 element: int_params[vec4_idx][component_idx]
                lines.push(`fn get_${param.glslName}() -> i32 { return dctl_params.int_params[${vec4Index}][${componentIndex}]; }`);
                break;
            case 'bool':
                // Access vec4 element: int_params[vec4_idx][component_idx]
                // Return i32 (not bool) because the Rust compiler declares CHECK_BOX params as var<private>: i32
                lines.push(`fn get_${param.glslName}() -> i32 { return dctl_params.int_params[${vec4Index}][${componentIndex}]; }`);
                break;
            case 'color':
                // Color params are already vec4, no change needed
                lines.push(`fn get_${param.glslName}() -> vec3<f32> { return dctl_params.color_params[${param.index}].rgb; }`);
                break;
        }
    }

    return lines.join('\n');
}

/**
 * Build the main compute function
 */
function buildMainFunction(
    ocioMainFunction: string,
    hasDctl: boolean,
    rgcOptions: RgcBuildOptions = { enabled: false }
): string {
    // Build RGC call (always uses OCIO-based RGC when enabled)
    let rgcCall: string;
    if (!rgcOptions.enabled) {
        rgcCall = 'let rgcColor = ap1Color;';
    } else if (rgcOptions.rgcMainFunction) {
        // RGC uses OCIO-extracted function
        rgcCall = `let rgcColor = ${rgcOptions.rgcMainFunction}(ap1Color);`;
    } else {
        // No RGC function available, pass through
        rgcCall = 'let rgcColor = ap1Color;';
    }

    if (hasDctl) {
        return `
@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel (in AP0 / ACES2065-1)
    var color = textureLoad(source_texture, coords, 0);

    // Apply DCTL transform (if enabled)
    // Note: applyDCTL handles AP0 -> working -> AP0 conversion internally
    if (dctl_params.enabled != 0u) {
        // Set DCTL built-in variables (used by DCTL code for pixel position and image dimensions)
        p_X = i32(coords.x);
        p_Y = i32(coords.y);
        p_Width = i32(params.width);
        p_Height = i32(params.height);

        color = vec4<f32>(applyDCTL(color.rgb), color.a);
    }

    // Convert AP0 -> AP1 (column-major order: each vec3 is a column)
    const ap0ToAp1 = mat3x3<f32>(
        vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
        vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
        vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
    );
    let ap1Color = vec4<f32>(ap0ToAp1 * color.rgb, color.a);

    // Apply Reference Gamut Compression (if enabled)
    ${rgcCall}

    // Apply OCIO color transform
    let transformedAp1 = ${ocioMainFunction}(rgcColor);

    // Convert AP1 -> AP0 (column-major order: each vec3 is a column)
    const ap1ToAp0 = mat3x3<f32>(
        vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
        vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
        vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
    );
    let transformed = vec4<f32>(ap1ToAp0 * transformedAp1.rgb, transformedAp1.a);

    // Store result (only clamp negative values, allow HDR values > 1.0)
    textureStore(output_texture, coords, max(transformed, vec4<f32>(0.0)));
}`;
    } else {
        return `
@compute @workgroup_size(${WORKGROUP_SIZE_X}, ${WORKGROUP_SIZE_Y})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    // Bounds check
    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    // Load source pixel (in AP0 / ACES2065-1)
    let source_color = textureLoad(source_texture, coords, 0);

    // Convert AP0 -> AP1 (column-major order: each vec3 is a column)
    const ap0ToAp1 = mat3x3<f32>(
        vec3<f32>(1.4514393161, -0.0765537734, 0.0083161484),
        vec3<f32>(-0.2365107469, 1.1762296998, -0.0060324498),
        vec3<f32>(-0.2149285693, -0.0996759264, 0.9977163014)
    );
    let ap1Color = vec4<f32>(ap0ToAp1 * source_color.rgb, source_color.a);

    // Apply Reference Gamut Compression (if enabled)
    ${rgcCall}

    // Apply OCIO color transform
    let transformedAp1 = ${ocioMainFunction}(rgcColor);

    // Convert AP1 -> AP0 (column-major order: each vec3 is a column)
    const ap1ToAp0 = mat3x3<f32>(
        vec3<f32>(0.6954522414, 0.0447945634, -0.0055258826),
        vec3<f32>(0.1406786965, 0.8596711185, 0.0040252103),
        vec3<f32>(0.1638690622, 0.0955343182, 1.0015006723)
    );
    let transformed = vec4<f32>(ap1ToAp0 * transformedAp1.rgb, transformedAp1.a);

    // Store result (only clamp negative values, allow HDR values > 1.0)
    textureStore(output_texture, coords, max(transformed, vec4<f32>(0.0)));
}`;
    }
}
