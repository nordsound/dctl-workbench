/**
 * DCTL Workbench Runtime - Type Definitions
 *
 * Common types shared across all modules.
 */

// =============================================================================
// Color Space Types
// =============================================================================

/**
 * Working color space for DCTL transforms
 */
export type DctlColorSpace = 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB';

// =============================================================================
// Parameter Types
// =============================================================================

/**
 * DCTL UI Parameter types
 */
export type DctlParamType =
    | 'DCTL_SLIDER_FLOAT'
    | 'DCTL_SLIDER_INT'
    | 'DCTL_VALUE_BOX'
    | 'DCTL_CHECK_BOX'
    | 'DCTL_COMBO_BOX'
    | 'DCTL_COLOR_PICKER';

/**
 * Base DCTL UI Parameter
 */
export interface DctlParamBase {
    name: string;
    label: string;
    type: DctlParamType;
}

/**
 * Float slider parameter
 */
export interface DctlSliderFloat extends DctlParamBase {
    type: 'DCTL_SLIDER_FLOAT';
    default: number;
    min: number;
    max: number;
    step: number;
}

/**
 * Integer slider parameter
 */
export interface DctlSliderInt extends DctlParamBase {
    type: 'DCTL_SLIDER_INT';
    default: number;
    min: number;
    max: number;
    step: number;
}

/**
 * Checkbox parameter
 */
export interface DctlCheckBox extends DctlParamBase {
    type: 'DCTL_CHECK_BOX';
    default: boolean;
}

/**
 * Value box parameter
 */
export interface DctlValueBox extends DctlParamBase {
    type: 'DCTL_VALUE_BOX';
    default: number;
}

/**
 * Combo box parameter
 */
export interface DctlComboBox extends DctlParamBase {
    type: 'DCTL_COMBO_BOX';
    default: number;
    options: string[];
}

/**
 * Color picker parameter
 */
export interface DctlColorPicker extends DctlParamBase {
    type: 'DCTL_COLOR_PICKER';
    default: DctlColorValue;
}

/**
 * Union type for all DCTL parameters
 */
export type DctlParam =
    | DctlSliderFloat
    | DctlSliderInt
    | DctlValueBox
    | DctlCheckBox
    | DctlComboBox
    | DctlColorPicker;

/**
 * RGB color value
 */
export interface DctlColorValue {
    r: number;
    g: number;
    b: number;
}

/**
 * Current values for DCTL parameters
 */
export type DctlParamValues = Record<string, number | boolean | DctlColorValue>;

// =============================================================================
// Compiler Types
// =============================================================================

/**
 * Diagnostic severity level
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * A diagnostic message from the compiler
 */
export interface CompilerDiagnostic {
    severity: DiagnosticSeverity;
    message: string;
    line: number;
    column: number;
}

/**
 * Parameter type definitions (from Rust compiler)
 */
export type ParameterType =
    | { type: 'float'; default: number; min: number; max: number; step: number }
    | { type: 'int'; default: number; min: number; max: number; step: number }
    | { type: 'bool'; default: boolean }
    | { type: 'combo'; default: number; options: string[] };

/**
 * A DCTL UI parameter definition (from Rust compiler)
 */
export interface CompilerParameter {
    name: string;
    label: string;
    param_type: ParameterType;
}

/**
 * Result of compiling DCTL source code
 */
export interface CompileResult {
    wgsl: string;
    diagnostics: CompilerDiagnostic[];
    parameters: CompilerParameter[];
    entry_point: string;
}

/**
 * Error result from the compiler
 */
export interface CompileError {
    error: true;
    message: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
    diagnostics: CompilerDiagnostic[];
}

// =============================================================================
// DCTL Info Types
// =============================================================================

/**
 * DCTL information for shader building (Rust compiler path)
 *
 * This is a simplified type that contains only the fields needed
 * for the Rust WASM compiler path. Unlike the legacy DctlShaderInfo,
 * it does not include GLSL code since the Rust compiler generates WGSL directly.
 */
export interface DctlInfo {
    /** Original DCTL source code */
    source: string;
    /** Working color space for the transform */
    workingColorSpace: DctlColorSpace;
    /** File path (for #include resolution) */
    filePath?: string;
    /** UI parameters extracted from DEFINE_UI_PARAMS */
    params: DctlParam[];
    /** Return type of the transform function */
    returnType?: 'float3' | 'float4';
}

/**
 * Source mapping entry for error reporting
 */
export interface SourceMapping {
    /** Line number in generated code (1-based) */
    glslLine: number;
    /** Original DCTL line number (1-based) */
    dctlLine: number;
    /** Original DCTL column (1-based, optional) */
    dctlColumn?: number;
}

/**
 * DCTL shader information (backwards-compatible)
 *
 * This extends DctlInfo to provide backwards compatibility with code
 * that expects the legacy DctlShaderInfo type with GLSL code.
 *
 * When using the Rust compiler path (recommended), only the DctlInfo
 * fields (source, workingColorSpace, filePath, params) are used.
 */
export interface DctlShaderInfo extends DctlInfo {
    /** Generated GLSL code (deprecated, not used in Rust compiler path) */
    glslCode?: string;
    /** Main transform function name */
    mainFunction?: string;
    /** Source mappings for error reporting */
    sourceMap?: SourceMapping[];
}

/**
 * Create a DctlShaderInfo from preprocessor result (without transpilation)
 *
 * This creates a minimal DctlShaderInfo for the Rust compiler path.
 * The glslCode field is left empty since it's not needed.
 */
export function createDctlInfo(
    source: string,
    workingColorSpace: DctlColorSpace,
    params: DctlParam[],
    filePath?: string
): DctlShaderInfo {
    return {
        source,
        workingColorSpace,
        filePath,
        params,
        returnType: 'float3',
        // These fields are optional and not needed for Rust compiler path
        glslCode: '',
        mainFunction: 'transform',
    };
}

// =============================================================================
// Shader Types
// =============================================================================

/**
 * Shader build options
 */
export interface ShaderBuildOptions {
    /** Image width */
    width: number;
    /** Image height */
    height: number;
    /** Parameter values to inject */
    paramValues?: DctlParamValues;
    /** Working color space */
    workingColorSpace?: DctlColorSpace;
    /** Apply ACES 2.0 Reference Gamut Compression */
    applyRGC?: boolean;
    /** Peak luminance for RGC */
    peakLuminance?: number;
}

/**
 * Shader build result
 */
export interface ShaderBuildResult {
    /** Generated WGSL code */
    wgsl: string;
    /** Texture/sampler bindings */
    bindings: TextureBinding[];
    /** RGC textures (if RGC enabled) */
    rgcTextures?: unknown[];
}

/**
 * Texture binding information
 */
export interface TextureBinding {
    binding: number;
    type: 'texture2D' | 'texture3D' | 'sampler' | 'uniform';
    name: string;
    originalName?: string;
}

// =============================================================================
// EXR Types
// =============================================================================

/**
 * EXR image data
 */
export interface ExrImageData {
    width: number;
    height: number;
    channels: string[];
    data: Float32Array;
}

/**
 * EXR write options
 */
export interface ExrWriteOptions {
    width: number;
    height: number;
    channels?: string[];
    data: Float32Array;
    compression?: 'NONE' | 'RLE' | 'ZIPS' | 'ZIP' | 'PIZ' | 'PXR24' | 'B44' | 'B44A' | 'DWAA' | 'DWAB';
    /** Chromaticity metadata */
    chromaticities?: {
        redX: number; redY: number;
        greenX: number; greenY: number;
        blueX: number; blueY: number;
        whiteX: number; whiteY: number;
    };
}

// =============================================================================
// Runtime Types
// =============================================================================

/**
 * Runtime initialization options
 */
export interface RuntimeInitOptions {
    /** Path to WASM files */
    wasmPath: string;
}

/**
 * Type guard for compile errors
 */
export function isCompileError(result: CompileResult | CompileError): result is CompileError {
    return 'error' in result && result.error === true;
}
