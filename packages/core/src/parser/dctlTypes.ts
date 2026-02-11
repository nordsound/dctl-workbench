/**
 * DCTL-specific type definitions
 */

/**
 * DCTL Entry Point Types
 */
export type DctlEntryPointType = 'transform' | 'transition';

/**
 * Transform function signature variants
 */
export type TransformSignature =
    | 'rgb_buffer'      // float3 transform(..., float p_R, float p_G, float p_B)
    | 'rgb_texture'     // float3 transform(..., __TEXTURE__ p_TexR, ...)
    | 'rgba_buffer'     // float4 transform(..., float p_R, ..., float p_A)
    | 'rgba_texture';   // float4 transform(..., __TEXTURE__ p_TexR, ..., __TEXTURE__ p_TexA)

/**
 * UI Parameter types
 */
export type DctlUIType =
    | 'DCTLUI_SLIDER_FLOAT'
    | 'DCTLUI_SLIDER_INT'
    | 'DCTLUI_VALUE_BOX'
    | 'DCTLUI_CHECK_BOX'
    | 'DCTLUI_COMBO_BOX'
    | 'DCTLUI_COLOR_PICKER';

/**
 * DCTL Modifiers/Qualifiers
 */
export const DCTL_MODIFIERS = [
    '__DEVICE__',
    '__CONSTANT__',
    '__CONSTANTREF__',
    '__TEXTURE__',
] as const;

export type DctlModifier = typeof DCTL_MODIFIERS[number];

/**
 * DCTL Vector Types
 */
export const DCTL_VECTOR_TYPES = [
    'float2', 'float3', 'float4',
    'int2', 'int3', 'int4',
] as const;

export type DctlVectorType = typeof DCTL_VECTOR_TYPES[number];

/**
 * DCTL Global Constants
 */
export const DCTL_GLOBAL_CONSTANTS = [
    '__RESOLVE_VER_MAJOR__',
    '__RESOLVE_VER_MINOR__',
    'DEVICE_IS_CUDA',
    'DEVICE_IS_OPENCL',
    'DEVICE_IS_METAL',
    'TRANSITION_PROGRESS',
    'TIMELINE_FRAME_INDEX',
    // Note: Math constants (PI, M_PI, etc.) are NOT included here.
    // They are not built-in constants in DCTL - users must define them.
] as const;

/**
 * DCTL Built-in Functions (Intrinsics)
 */
export const DCTL_BUILTIN_FUNCTIONS = [
    // Vector constructors
    'make_float2', 'make_float3', 'make_float4',
    'make_int2', 'make_int3', 'make_int4',
    'make_half2', 'make_half3', 'make_half4',

    // Math functions (float) - from official DaVinci CTL README.txt
    // Note: Most functions use 'f' suffix, but some exceptions exist
    '_fabs',      // float _fabs(float x) - no 'f' suffix version
    '_powf', '_logf', '_log2f', '_log10f',
    '_expf', '_exp2f', '_exp10f',
    '_copysignf', '_fmaxf', '_fminf', '_clampf', '_saturatef',
    '_sqrtf', '_ceilf', '_floorf', '_truncf',
    '_ceil', '_floor',  // Deprecated (Resolve 17.0+), use _ceilf/_floorf instead
    '_round',     // float _round(float x) - no 'f' suffix version
    '_fmod',      // float _fmod(float x, float y) - no 'f' suffix version
    '_hypotf',
    '_cosf', '_sinf', '_cospif', '_sinpif', '_tanf',
    '_acosf', '_asinf', '_atanf', '_atan2f',
    '_acoshf', '_asinhf', '_atanhf',
    '_coshf', '_sinhf', '_tanhf',
    '_fdimf', '_fmaf', '_rsqrtf', 'inversesqrt',
    '_fractf', 'fractf',
    '_fdivide', '_frecip',  // float _fdivide/_frecip - no 'f' suffix
    '_frexp', '_ldexp',     // float _frexp/_ldexp - no 'f' suffix
    'isinf', 'isnan', 'signbit',

    // Generic math (works with multiple types)
    'abs', 'min', 'minf', 'max', 'maxf', 'clamp', 'clampf', 'mix', 'mixf', '_mix', 'step', 'stepf', '_stepf', 'smoothstep', 'smoothstepf', '_smoothstepf',
    'dot', 'cross', 'length', 'normalize', 'distance', 'reflect',
    'fract', 'mod', 'sign', 'lerp', 'lerpf',
    '_sign_', '_signf',  // sign function variants

    // Angle conversion
    'degree', 'degrees', 'radian', 'radians',

    // Standard math functions (without underscore prefix)
    'pow', 'powf', 'log', 'logf', 'log2', 'log10', 'log10f',
    'exp', 'expf', 'exp2', 'exp10',
    'sqrt', 'sqrtf', 'rsqrt', 'rsqrtf', 'ceil', 'ceilf', 'floor', 'floorf', 'round', 'roundf', 'trunc', 'truncf',
    'sin', 'sinf', 'cos', 'cosf', 'tan', 'tanf',
    'asin', 'asinf', 'acos', 'acosf', 'atan', 'atanf', 'atan2', 'atan2f',
    'sinh', 'sinhf', 'cosh', 'coshf', 'tanh', 'tanhf',
    'asinh', 'acosh', 'atanh',
    'fmin', 'fminf', 'fmax', 'fmaxf', 'fabs', 'fabsf',
    'saturate', 'copysign', 'copysignf', 'hypot', 'hypotf',
    'fma', 'fmaf',

    // Type constructors used as functions
    'float', 'int', 'uint', 'double', 'bool',

    // Uppercase variants (some DCTL code uses these)
    'ABS', 'MIN', 'MAX', 'CLAMP', 'FLOOR', 'CEIL', 'ROUND',
    'SQRT', 'POW', 'EXP', 'LOG', 'SIN', 'COS', 'TAN',

    // Texture functions
    '_tex2D', '_tex2DVec4', '_tex2DVecN',
    '_tex3D', '_tex3DVec4',

    // Type conversion
    '_uint_as_float', '_float_as_uint',
    '_int_as_float', '_float_as_int',
    '_half_to_float', '_float_to_half',

    // Bit operations
    '__float_as_int', '__int_as_float',
    '__clz', '__popc', '__brev',

    // Random
    'RAND',

    // LUT functions
    'APPLY_LUT', 'APPLY_CUBE_LUT',

    // Matrix operations
    'mult_f3_f33', 'mult_f3_f44', 'mult_f44_f44', 'mult_f33_f33',
    'invert_f33', 'invert_f44', 'transpose_f33', 'transpose_f44',
    'identity_f33', 'identity_f44',
] as const;

export type DctlBuiltinFunction = typeof DCTL_BUILTIN_FUNCTIONS[number];

/**
 * Standard C functions that should be replaced with DCTL equivalents
 */
export const FORBIDDEN_C_FUNCTIONS: Record<string, string> = {
    'pow': '_powf',
    'sin': '_sinf',
    'cos': '_cosf',
    'tan': '_tanf',
    'sqrt': '_sqrtf',
    'log': '_logf',
    'log2': '_log2f',
    'log10': '_log10f',
    'exp': '_expf',
    'exp2': '_exp2f',
    'fabs': '_fabs',
    'floor': '_floorf',
    'ceil': '_ceilf',
    'round': '_round',
    'fmod': '_fmod',
    'fmax': '_fmaxf',
    'fmin': '_fminf',
    'asin': '_asinf',
    'acos': '_acosf',
    'atan2': '_atan2f',
    'sinh': '_sinhf',
    'cosh': '_coshf',
    'tanh': '_tanhf',
};

/**
 * DCTL Macros
 */
export const DCTL_MACROS = [
    'DEFINE_UI_PARAMS',
    'DEFINE_UI_TOOLTIP',
    'DEFINE_LUT',
    'DEFINE_CUBE_LUT',
    'APPLY_LUT',
    'DEFINE_ACES_PARAM',
    'DEFINE_ACES_V2_PARAM',
    'DEFINE_DCTL_ALPHA_MODE_STRAIGHT',
    'DEFINE_DCTL_ALPHA_MODE_PREMULTIPLY',
] as const;

export type DctlMacro = typeof DCTL_MACROS[number];

/**
 * UI Parameter count limits (per type)
 */
export const UI_PARAM_LIMIT = 64;

/**
 * Parsed UI Parameter
 */
export interface DctlUIParam {
    name: string;
    label: string;
    type: DctlUIType;
    defaultValue: number | string;
    min?: number;
    max?: number;
    step?: number;
    enumList?: string[];
    enumLabels?: string[];
    line: number;
    column: number;
}

/**
 * Parsed Entry Point Function
 */
export interface DctlEntryPoint {
    type: DctlEntryPointType;
    signature: TransformSignature | 'transition';
    returnType: 'float3' | 'float4';
    line: number;
    column: number;
}

/**
 * ACES Parameter keys for V1
 */
export const ACES_V1_REQUIRED_PARAMS = [
    'Y_MIN', 'Y_MID', 'Y_MAX',
    'DISPLAY_PRI', 'LIMITING_PRI',
    'EOTF', 'INVERSE_EOTF',
    'SURROUND', 'STRETCH_BLACK',
    'D60_SIM', 'LEGAL_RANGE',
] as const;

/**
 * ACES Parameter keys for V2
 */
export const ACES_V2_REQUIRED_PARAMS = [
    'PEAK_LUMINANCE', 'LINEAR_SCALE_FACTOR',
    'LIMITING_PRI', 'ENCODING_PRI',
    'EOTF', 'IS_SCALE_WHITE',
] as const;
