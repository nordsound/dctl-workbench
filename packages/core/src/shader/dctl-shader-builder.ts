/**
 * DCTL Shader Builder
 *
 * Builds GLSL shader code that integrates DCTL transforms
 * with the OCIO display pipeline.
 *
 * Pipeline:
 * EXR (AP0) → [Color Space Convert] → [DCTL Transform] → [Color Space Convert] → [OCIO Display]
 */

import type {
    DctlShaderInfo,
    DctlParam,
    DctlColorSpace,
    DctlColorValue,
    DctlComboBox,
} from '../types/index.js';
import {
    type Matrix3x3,
    getConversionMatrix,
    matrixToGlsl,
    AP0_TO_AP1,
    AP1_TO_AP0,
    isLogColorSpace,
    getLinearBase,
    generateLinToACESccGlsl,
    generateACESccToLinGlsl,
    generateLinToACEScctGlsl,
    generateACEScctToLinGlsl,
} from '../color-space/index.js';

// GLSL reserved keywords that need renaming
const GLSL_RESERVED_KEYWORDS = new Set([
    'input', 'output', 'texture', 'sampler', 'image', 'atomic_uint',
    'attribute', 'varying', 'uniform', 'buffer',
    'in', 'out', 'inout', 'flat', 'smooth', 'noperspective',
    'layout', 'shared', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly',
    'discard', 'return', 'break', 'continue',
    'if', 'else', 'switch', 'case', 'default', 'for', 'while', 'do',
    'struct', 'void', 'bool', 'int', 'uint', 'float', 'double',
    'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
    'mat2', 'mat3', 'mat4', 'sampler2D', 'sampler3D', 'samplerCube',
    'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max',
    'clamp', 'mix', 'step', 'smoothstep', 'length', 'distance',
    'dot', 'cross', 'normalize', 'pow', 'exp', 'log', 'exp2', 'log2',
    'sqrt', 'inversesqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'round', 'trunc',
    'radians', 'degrees', 'reflect', 'refract',
]);

/**
 * Rename GLSL reserved keywords if used as identifiers.
 */
export function renameGlslReserved(name: string): string {
    if (GLSL_RESERVED_KEYWORDS.has(name)) {
        return `_${name}_`;
    }
    return name;
}

/**
 * DCTL Shader Build Options
 */
export interface DctlShaderBuildOptions {
    /** Source color space of input (default: ACES2065-1) */
    inputColorSpace?: DctlColorSpace;
    /** Target color space for output (default: ACES2065-1 for OCIO) */
    outputColorSpace?: DctlColorSpace;
    /** Override working color space (default: from DCTL transpiler) */
    workingColorSpace?: DctlColorSpace;
    /** Prefix for uniform names */
    uniformPrefix?: string;
    /** Current parameter values (if provided, generates constants instead of uniforms) */
    paramValues?: Record<string, number | boolean | DctlColorValue>;
    /** Whether DCTL is currently enabled (default: true) */
    enabled?: boolean;
}

/**
 * Result of building DCTL shader code
 */
export interface DctlShaderBuildResult {
    /** DCTL uniform declarations */
    uniformDeclarations: string;
    /** Color space conversion matrices */
    matrixDeclarations: string;
    /** DCTL function code */
    dctlFunctionCode: string;
    /** applyDCTL wrapper function */
    applyDctlFunction: string;
    /** Complete GLSL code fragment to insert into shader */
    completeFragment: string;
}

const DEFAULT_OPTIONS = {
    inputColorSpace: 'ACES2065-1' as DctlColorSpace,
    outputColorSpace: 'ACES2065-1' as DctlColorSpace,
    uniformPrefix: 'u_dctl_',
    paramValues: undefined as Record<string, number | boolean | DctlColorValue> | undefined,
    enabled: true,
};

/**
 * Build DCTL shader code for integration with OCIO
 *
 * @param shaderInfo - DCTL shader information from transpiler
 * @param options - Build options
 * @returns DCTL shader code fragments
 */
export function buildDctlShaderCode(
    shaderInfo: DctlShaderInfo,
    options?: DctlShaderBuildOptions
): DctlShaderBuildResult {
    // This function requires GLSL code from the transpiler
    if (!shaderInfo.glslCode) {
        throw new Error('buildDctlShaderCode requires glslCode in shaderInfo. Use the WGSL path for Rust compiler output.');
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const useConstants = opts.paramValues !== undefined;

    // Use override working color space if provided, otherwise from transpiler
    const workingColorSpace = opts.workingColorSpace ?? shaderInfo.workingColorSpace;

    // Build uniform/constant declarations for DCTL parameters
    const uniformDeclarations = buildUniformDeclarations(
        shaderInfo.params,
        opts.uniformPrefix,
        opts.paramValues
    );

    // Build enabled declaration - always use constant for Naga compatibility
    // (Naga requires layout bindings for uniforms, and for the integrated shader
    // the enabled state is controlled by whether DCTL is included at all)
    const enabledDecl = `const bool ${opts.uniformPrefix}enabled = ${opts.enabled};`;

    // Build color space conversion matrices
    const matrixDeclarations = buildMatrixDeclarations(
        opts.inputColorSpace,
        workingColorSpace,
        opts.outputColorSpace
    );

    // The DCTL function code (from transpiler)
    // Strip directives and uniform declarations that we'll generate ourselves
    let dctlFunctionCode = shaderInfo.glslCode;
    // Strip #version directive since it's added by the integrated shader builder
    dctlFunctionCode = dctlFunctionCode.replace(/^#version\s+\d+(\s+es)?\s*\n/m, '');
    // Also strip precision directive if present
    dctlFunctionCode = dctlFunctionCode.replace(/^precision\s+\w+\s+\w+;\s*\n/m, '');
    // Strip the "// DCTL UI Parameters" section and uniform block
    // This section is generated by the transpiler but we generate our own constants/uniforms
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*DCTL UI Parameters\s*\nlayout\([^)]+\)\s*uniform\s+DctlUIParams\s*\{[^}]*\};\s*\n/g,
        ''
    );
    // Strip #define aliases for UI parameters
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*DCTL parameter aliases\s*\n(#define\s+\w+\s+[^\n]*\n)*/g,
        ''
    );
    // Strip the "// DCTL Built-in Parameters" section and uniform block
    // This is generated by the transpiler for standalone validation but not needed here
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*DCTL Built-in Parameters\s*\nlayout\([^)]+\)\s*uniform\s+DctlParams\s*\{[^}]*\};\s*\n/g,
        ''
    );
    // Strip the dctl_sampleTexture stub (defined by the integrated shader builder with proper implementation)
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*Texture sampling stub[^\n]*\nvec4 dctl_sampleTexture\([^)]*\)\s*\{[^}]*\}\s*\n/g,
        ''
    );
    // Note: main() entry point stripping removed - glslCodegen no longer generates it
    // Strip variable declarations for UI parameters added by preprocessor
    // These are declared as constants by buildUniformDeclarations
    for (const param of shaderInfo.params) {
        const paramName = renameGlslReserved(param.name);
        // Match: float contrast; or int mode; or bool enabled; or vec3 color;
        const declPattern = new RegExp(
            `^(float|int|bool|vec3)\\s+${paramName}\\s*;\\s*\\n`,
            'gm'
        );
        dctlFunctionCode = dctlFunctionCode.replace(declPattern, '');
    }

    // Build the applyDCTL wrapper function
    const applyDctlFunction = buildApplyDctlFunction(
        shaderInfo,
        opts.inputColorSpace,
        opts.outputColorSpace,
        workingColorSpace,
        opts.uniformPrefix
    );

    // Combine all fragments
    const completeFragment = `
// =============================================================================
// DCTL Transform Section
// =============================================================================

// DCTL Parameters${useConstants ? ' (constants)' : ' (uniforms)'}
${enabledDecl}
${uniformDeclarations}

// Color Space Matrices
${matrixDeclarations}

// DCTL Functions
${dctlFunctionCode}

// DCTL Wrapper
${applyDctlFunction}
`;

    return {
        uniformDeclarations,
        matrixDeclarations,
        dctlFunctionCode,
        applyDctlFunction,
        completeFragment,
    };
}

/**
 * Build uniform/constant declarations for DCTL UI parameters
 *
 * Note: DCTL UI params are declared WITHOUT prefix because the transpiled
 * DCTL code references them by their original names (e.g., 'contrast', not 'u_dctl_contrast').
 * The prefix is only used for internal uniforms like 'u_dctl_enabled'.
 *
 * @param params - DCTL parameters
 * @param _prefix - Unused, kept for API compatibility
 * @param paramValues - If provided, generates constants with these values instead of uniforms
 */
function buildUniformDeclarations(
    params: DctlParam[],
    _prefix: string,
    paramValues?: Record<string, number | boolean | DctlColorValue>
): string {
    const lines: string[] = [];
    const useConstants = paramValues !== undefined;

    for (const param of params) {
        // Use original param name without prefix - matches transpiled DCTL code
        // Apply GLSL reserved keyword renaming to match codegen behavior
        const uniformName = renameGlslReserved(param.name);
        const value = paramValues?.[param.name] ?? param.default;

        switch (param.type) {
            case 'DCTL_SLIDER_FLOAT':
            case 'DCTL_VALUE_BOX':
                if (useConstants) {
                    const floatVal = typeof value === 'number' ? value : 0.0;
                    lines.push(`const float ${uniformName} = ${floatVal.toFixed(6)};`);
                } else {
                    lines.push(`uniform float ${uniformName};`);
                }
                break;
            case 'DCTL_SLIDER_INT':
                if (useConstants) {
                    const intVal = typeof value === 'number' ? Math.round(value) : 0;
                    lines.push(`const int ${uniformName} = ${intVal};`);
                } else {
                    lines.push(`uniform int ${uniformName};`);
                }
                break;
            case 'DCTL_COMBO_BOX': {
                if (useConstants) {
                    const intVal = typeof value === 'number' ? Math.round(value) : 0;
                    lines.push(`const int ${uniformName} = ${intVal};`);
                } else {
                    lines.push(`uniform int ${uniformName};`);
                }
                // Generate #define constants for each combo box option
                const comboParam = param as DctlComboBox;
                if (comboParam.options && comboParam.options.length > 0) {
                    for (let i = 0; i < comboParam.options.length; i++) {
                        lines.push(`#define ${comboParam.options[i]} ${i}`);
                    }
                }
                break;
            }
            case 'DCTL_CHECK_BOX':
                if (useConstants) {
                    const boolVal = typeof value === 'boolean' ? value : false;
                    lines.push(`const bool ${uniformName} = ${boolVal};`);
                } else {
                    lines.push(`uniform bool ${uniformName};`);
                }
                break;
            case 'DCTL_COLOR_PICKER':
                if (useConstants) {
                    const colorVal = (typeof value === 'object' && value !== null && 'r' in value)
                        ? value as DctlColorValue
                        : { r: 1.0, g: 1.0, b: 1.0 };
                    lines.push(`const vec3 ${uniformName} = vec3(${colorVal.r.toFixed(6)}, ${colorVal.g.toFixed(6)}, ${colorVal.b.toFixed(6)});`);
                } else {
                    lines.push(`uniform vec3 ${uniformName};`);
                }
                break;
        }
    }

    return lines.join('\n');
}

/**
 * Build color space conversion matrix and function declarations
 */
function buildMatrixDeclarations(
    inputColorSpace: DctlColorSpace,
    workingColorSpace: DctlColorSpace,
    outputColorSpace: DctlColorSpace
): string {
    const lines: string[] = [];

    // Get linear bases for log color spaces
    const inputLinear = getLinearBase(inputColorSpace);
    const workingLinear = getLinearBase(workingColorSpace);
    const outputLinear = getLinearBase(outputColorSpace);

    // Input to working: linear matrix part
    if (inputLinear !== workingLinear) {
        const inputToWorking = getConversionMatrix(inputLinear, workingLinear);
        lines.push(matrixToGlsl(inputToWorking, 'dctl_inputToWorking'));
    }

    // Working to output: linear matrix part
    if (workingLinear !== outputLinear) {
        const workingToOutput = getConversionMatrix(workingLinear, outputLinear);
        lines.push(matrixToGlsl(workingToOutput, 'dctl_workingToOutput'));
    }

    // Add log conversion functions if needed
    if (workingColorSpace === 'ACEScc') {
        lines.push(generateLinToACESccGlsl());
        lines.push(generateACESccToLinGlsl());
    } else if (workingColorSpace === 'ACEScct') {
        lines.push(generateLinToACEScctGlsl());
        lines.push(generateACEScctToLinGlsl());
    }

    return lines.join('\n');
}

/**
 * Build the applyDCTL wrapper function
 */
function buildApplyDctlFunction(
    shaderInfo: DctlShaderInfo,
    inputColorSpace: DctlColorSpace,
    outputColorSpace: DctlColorSpace,
    workingColorSpace: DctlColorSpace,
    uniformPrefix: string
): string {
    const mainFunc = `dctl_${shaderInfo.mainFunction}`;

    // Get linear bases for matrix conversions
    const inputLinear = getLinearBase(inputColorSpace);
    const workingLinear = getLinearBase(workingColorSpace);
    const outputLinear = getLinearBase(outputColorSpace);

    // Determine if we need conversions
    const needsInputMatrix = inputLinear !== workingLinear;
    const needsOutputMatrix = workingLinear !== outputLinear;
    const inputIsLog = isLogColorSpace(inputColorSpace);
    const workingIsLog = isLogColorSpace(workingColorSpace);
    const outputIsLog = isLogColorSpace(outputColorSpace);

    let body = '';

    // Early exit if DCTL is disabled
    body += `    if (!${uniformPrefix}enabled) {\n`;
    body += `        return color;\n`;
    body += `    }\n\n`;

    // Step 1: Apply input matrix (linear to linear)
    // Skip if input is already log (matrix applies to linear primaries)
    if (needsInputMatrix && !inputIsLog) {
        body += `    vec3 linear = dctl_inputToWorking * color;\n`;
    } else {
        body += `    vec3 linear = color;\n`;
    }

    // Step 2: Apply log encoding if working space is log AND input is not already log
    // (If input is already in log space, skip encoding)
    if (workingIsLog && !inputIsLog) {
        if (workingColorSpace === 'ACEScc') {
            body += `    vec3 working = lin_to_ACEScc(linear);\n`;
        } else if (workingColorSpace === 'ACEScct') {
            body += `    vec3 working = lin_to_ACEScct(linear);\n`;
            // ACEScct has a minimum value of ~0.0729 even for linear 0 (black)
            // This is the standard ACEScct behavior - black encodes to 0.0729, not 0
        }
    } else {
        body += `    vec3 working = linear;\n`;
    }

    // Step 3: Apply DCTL transform
    if (shaderInfo.returnType === 'float4') {
        body += `    vec4 transformed4 = ${mainFunc}(vec4(working, 1.0));\n`;
        body += `    vec3 transformed = transformed4.rgb;\n`;
    } else {
        body += `    vec3 transformed = ${mainFunc}(working);\n`;
    }

    // Step 4: Apply log decoding if working space is log AND output is not log
    // (If output is log, keep the log-encoded values as-is)
    if (workingIsLog && !outputIsLog) {
        if (workingColorSpace === 'ACEScc') {
            body += `    vec3 linearOut = ACEScc_to_lin(transformed);\n`;
        } else if (workingColorSpace === 'ACEScct') {
            body += `    vec3 linearOut = ACEScct_to_lin(transformed);\n`;
        }
    } else {
        body += `    vec3 linearOut = transformed;\n`;
    }

    // Step 5: Apply output matrix (linear to linear)
    if (needsOutputMatrix) {
        body += `    vec3 result = dctl_workingToOutput * linearOut;\n`;
    } else {
        body += `    vec3 result = linearOut;\n`;
    }

    body += `    return result;\n`;

    return `vec3 applyDCTL(vec3 color) {\n${body}}`;
}

/**
 * Generate a complete GLSL shader with DCTL and OCIO integration
 *
 * @param dctlInfo - DCTL shader info (or null if no DCTL)
 * @param ocioCode - OCIO generated shader code
 * @param ocioMainFunc - OCIO main function name
 * @returns Complete GLSL shader code
 */
export function buildIntegratedGlslShader(
    dctlInfo: DctlShaderInfo | null,
    ocioCode: string,
    ocioMainFunc: string
): string {
    const hasDctl = dctlInfo !== null;

    let shader = `#version 450

// Input/Output
layout(location = 0) in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor;

// Image texture (source EXR)
layout(set = 0, binding = 0) uniform texture2D u_image_tex;
layout(set = 0, binding = 1) uniform sampler u_image_samp;
`;

    // Add DCTL section if present
    if (hasDctl) {
        // Add DCTL built-in parameters uniform block with proper binding
        shader += `
// DCTL Built-in Parameters
layout(set = 0, binding = 2) uniform DctlBuiltinParams {
    int p_Width;
    int p_Height;
    int p_X;
    int p_Y;
    int TIMELINE_FRAME_INDEX;
    float TRANSITION_PROGRESS;
    int __RESOLVE_VER_MAJOR__;
    int __RESOLVE_VER_MINOR__;
};

// AP0 to ACEScg (Working Color Space) Matrix
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
        // Generate default param values to bake as constants (required for Naga - uniform blocks need layout bindings)
        const defaultParamValues: Record<string, number | boolean | DctlColorValue> = {};
        for (const param of dctlInfo.params) {
            defaultParamValues[param.name] = param.default;
        }
        const dctlResult = buildDctlShaderCode(dctlInfo, { paramValues: defaultParamValues });
        shader += dctlResult.completeFragment;
    }

    // Add OCIO section
    shader += `
// =============================================================================
// OCIO Display Transform Section
// =============================================================================

${ocioCode}
`;

    // Add main function
    shader += `
void main() {
    vec4 color = texture(sampler2D(u_image_tex, u_image_samp), v_texCoord);
`;

    if (hasDctl) {
        shader += `    color.rgb = applyDCTL(color.rgb);
`;
    }

    shader += `    vec4 result = ${ocioMainFunc}(color);
    fragColor = clamp(result, 0.0, 1.0);
}
`;

    return shader;
}

/**
 * Get default parameter values for DCTL shader
 */
export function getDctlDefaultUniforms(
    params: DctlParam[],
    prefix: string = 'u_dctl_'
): Record<string, number | boolean | DctlColorValue> {
    const uniforms: Record<string, number | boolean | DctlColorValue> = {
        [`${prefix}enabled`]: true,
    };

    for (const param of params) {
        uniforms[`${prefix}${param.name}`] = param.default;
    }

    return uniforms;
}

// =============================================================================
// Uniform Buffer Support (for fast parameter updates)
// =============================================================================

/**
 * Parameter mapping for uniform buffer
 */
export interface ShaderParamMapping {
    name: string;
    glslName: string;
    type: 'float' | 'int' | 'bool' | 'color';
    bufferType: 'float_params' | 'int_params' | 'color_params';
    index: number;
    /** Default value for GPU buffer initialization */
    default: number | boolean | { r: number; g: number; b: number };
}

/**
 * Buffer layout constants (must match dctl-param-buffer.ts)
 */
const BUFFER_LAYOUT = {
    FLOAT_PARAMS_COUNT: 32,
    INT_PARAMS_COUNT: 16,
    COLOR_PARAMS_COUNT: 8,
} as const;

/**
 * Build parameter mapping for shader generation
 */
export function buildShaderParamMapping(params: DctlParam[]): ShaderParamMapping[] {
    const mapping: ShaderParamMapping[] = [];
    let floatIndex = 0;
    let intIndex = 0;
    let colorIndex = 0;

    for (const param of params) {
        const glslName = renameGlslReserved(param.name);

        switch (param.type) {
            case 'DCTL_SLIDER_FLOAT':
            case 'DCTL_VALUE_BOX':
                if (floatIndex >= BUFFER_LAYOUT.FLOAT_PARAMS_COUNT) continue;
                mapping.push({
                    name: param.name,
                    glslName,
                    type: 'float',
                    bufferType: 'float_params',
                    index: floatIndex++,
                    default: param.default as number,
                });
                break;

            case 'DCTL_SLIDER_INT':
            case 'DCTL_COMBO_BOX':
                if (intIndex >= BUFFER_LAYOUT.INT_PARAMS_COUNT) continue;
                mapping.push({
                    name: param.name,
                    glslName,
                    type: 'int',
                    bufferType: 'int_params',
                    index: intIndex++,
                    default: param.default as number,
                });
                break;

            case 'DCTL_CHECK_BOX':
                if (intIndex >= BUFFER_LAYOUT.INT_PARAMS_COUNT) continue;
                mapping.push({
                    name: param.name,
                    glslName,
                    type: 'bool',
                    bufferType: 'int_params',
                    index: intIndex++,
                    default: param.default as boolean,
                });
                break;

            case 'DCTL_COLOR_PICKER':
                if (colorIndex >= BUFFER_LAYOUT.COLOR_PARAMS_COUNT) continue;
                mapping.push({
                    name: param.name,
                    glslName,
                    type: 'color',
                    bufferType: 'color_params',
                    index: colorIndex++,
                    default: param.default as { r: number; g: number; b: number },
                });
                break;
        }
    }

    return mapping;
}

/**
 * Generate GLSL uniform buffer struct declaration
 *
 * @param binding - Binding index for the uniform buffer
 * @param set - Descriptor set index (default 0)
 */
export function buildUniformBufferStruct(binding: number, set: number = 0): string {
    return `
// DCTL UI Parameters (Uniform Buffer)
layout(set = ${set}, binding = ${binding}) uniform DctlUIParams {
    uint dctl_enabled;
    uint _pad0;
    uint _pad1;
    uint _pad2;
    float dctl_float_params[${BUFFER_LAYOUT.FLOAT_PARAMS_COUNT}];
    int dctl_int_params[${BUFFER_LAYOUT.INT_PARAMS_COUNT}];
    vec4 dctl_color_params[${BUFFER_LAYOUT.COLOR_PARAMS_COUNT}];
};
`;
}

/**
 * Generate variable aliases that reference the uniform buffer
 */
export function buildUniformBufferReferences(
    params: DctlParam[],
    mapping: ShaderParamMapping[]
): string {
    const lines: string[] = [];

    for (const param of mapping) {
        switch (param.type) {
            case 'float':
                lines.push(`#define ${param.glslName} dctl_float_params[${param.index}]`);
                break;
            case 'int':
                lines.push(`#define ${param.glslName} dctl_int_params[${param.index}]`);
                break;
            case 'bool':
                lines.push(`#define ${param.glslName} (dctl_int_params[${param.index}] != 0)`);
                break;
            case 'color':
                lines.push(`#define ${param.glslName} dctl_color_params[${param.index}].rgb`);
                break;
        }
    }

    // Add combo box option defines
    for (const param of params) {
        if (param.type === 'DCTL_COMBO_BOX') {
            const comboParam = param as DctlComboBox;
            if (comboParam.options && comboParam.options.length > 0) {
                for (let i = 0; i < comboParam.options.length; i++) {
                    lines.push(`#define ${comboParam.options[i]} ${i}`);
                }
            }
        }
    }

    return lines.join('\n');
}

/**
 * Build DCTL shader code using uniform buffer (fast path)
 *
 * This version generates shader code that references a uniform buffer
 * instead of baking parameter values as constants.
 */
export function buildDctlShaderCodeWithUniformBuffer(
    shaderInfo: DctlShaderInfo,
    uniformBufferBinding: number,
    options?: Omit<DctlShaderBuildOptions, 'paramValues'>
): DctlShaderBuildResult & { paramMapping: ShaderParamMapping[] } {
    // This function requires GLSL code from the transpiler
    if (!shaderInfo.glslCode) {
        throw new Error('buildDctlShaderCodeWithUniformBuffer requires glslCode in shaderInfo. Use the WGSL path for Rust compiler output.');
    }

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const workingColorSpace = opts.workingColorSpace ?? shaderInfo.workingColorSpace;

    // Build parameter mapping
    const paramMapping = buildShaderParamMapping(shaderInfo.params);

    // Build uniform buffer struct
    const uniformBufferStruct = buildUniformBufferStruct(uniformBufferBinding);

    // Build uniform buffer references (defines)
    const uniformReferences = buildUniformBufferReferences(shaderInfo.params, paramMapping);

    // Build enabled declaration using uniform buffer
    const enabledDecl = `#define ${opts.uniformPrefix}enabled (dctl_enabled != 0u)`;

    // Build color space conversion matrices
    const matrixDeclarations = buildMatrixDeclarations(
        opts.inputColorSpace!,
        workingColorSpace,
        opts.outputColorSpace!
    );

    // Process DCTL function code (same as before)
    let dctlFunctionCode = shaderInfo.glslCode;
    dctlFunctionCode = dctlFunctionCode.replace(/^#version\s+\d+(\s+es)?\s*\n/m, '');
    dctlFunctionCode = dctlFunctionCode.replace(/^precision\s+\w+\s+\w+;\s*\n/m, '');
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*DCTL UI Parameters\s*\nlayout\([^)]+\)\s*uniform\s+DctlUIParams\s*\{[^}]*\};\s*\n/g,
        ''
    );
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*DCTL parameter aliases\s*\n(#define\s+\w+\s+[^\n]*\n)*/g,
        ''
    );
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*DCTL Built-in Parameters\s*\nlayout\([^)]+\)\s*uniform\s+DctlParams\s*\{[^}]*\};\s*\n/g,
        ''
    );
    dctlFunctionCode = dctlFunctionCode.replace(
        /\/\/\s*Texture sampling stub[^\n]*\nvec4 dctl_sampleTexture\([^)]*\)\s*\{[^}]*\}\s*\n/g,
        ''
    );
    for (const param of shaderInfo.params) {
        const paramName = renameGlslReserved(param.name);
        const declPattern = new RegExp(
            `^(float|int|bool|vec3)\\s+${paramName}\\s*;\\s*\\n`,
            'gm'
        );
        dctlFunctionCode = dctlFunctionCode.replace(declPattern, '');
    }

    // Build the applyDCTL wrapper function
    const applyDctlFunction = buildApplyDctlFunction(
        shaderInfo,
        opts.inputColorSpace!,
        opts.outputColorSpace!,
        workingColorSpace,
        opts.uniformPrefix!
    );

    // Combine all fragments
    const completeFragment = `
// =============================================================================
// DCTL Transform Section (Uniform Buffer Mode)
// =============================================================================

${uniformBufferStruct}

// DCTL Parameter References
${enabledDecl}
${uniformReferences}

// Color Space Matrices
${matrixDeclarations}

// DCTL Functions
${dctlFunctionCode}

// DCTL Wrapper
${applyDctlFunction}
`;

    return {
        uniformDeclarations: uniformBufferStruct + '\n' + enabledDecl + '\n' + uniformReferences,
        matrixDeclarations,
        dctlFunctionCode,
        applyDctlFunction,
        completeFragment,
        paramMapping,
    };
}
