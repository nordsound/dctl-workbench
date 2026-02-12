/**
 * DCTL Function Documentation
 * Based on DaVinci Resolve DCTL Reference
 */

export interface DctlFunctionDoc {
    name: string;
    signature: string;
    description: string;
    parameters?: { name: string; type: string; description: string }[];
    returns?: string;
    category: string;
    example?: string;
}

export const DCTL_FUNCTION_DOCS: DctlFunctionDoc[] = [
    // Math - Basic
    {
        name: '_fabs',
        signature: 'float _fabs(float x)',
        description: 'Returns the absolute value of x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value' }],
        returns: 'Absolute value of x',
        category: 'Math',
        example: 'float diff = _fabs(r - g); // absolute difference between channels'
    },
    {
        name: '_powf',
        signature: 'float _powf(float x, float y)',
        description: 'Computes x raised to the power of y',
        parameters: [
            { name: 'x', type: 'float', description: 'Base value' },
            { name: 'y', type: 'float', description: 'Exponent value' }
        ],
        returns: 'x^y',
        category: 'Math',
        example: 'float gamma = _powf(r, 1.0f / 2.2f); // apply gamma correction'
    },
    {
        name: '_sqrtf',
        signature: 'float _sqrtf(float x)',
        description: 'Computes the non-negative square root of x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value (must be >= 0)' }],
        returns: 'Square root of x',
        category: 'Math',
        example: 'float luma = _sqrtf(r * r * 0.2126f + g * g * 0.7152f + b * b * 0.0722f);'
    },
    {
        name: '_rsqrtf',
        signature: 'float _rsqrtf(float x)',
        description: 'Computes the reciprocal of square root of x (1/sqrt(x))',
        parameters: [{ name: 'x', type: 'float', description: 'Input value' }],
        returns: '1/sqrt(x)',
        category: 'Math',
        example: 'float invLen = _rsqrtf(x * x + y * y + z * z); // fast normalize'
    },

    // Math - Exponential/Logarithmic
    {
        name: '_logf',
        signature: 'float _logf(float x)',
        description: 'Computes the natural logarithm (base e) of x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value (must be > 0)' }],
        returns: 'Natural log of x',
        category: 'Math',
        example: 'float logVal = _logf(r + 0.001f); // natural log with offset to avoid log(0)'
    },
    {
        name: '_log2f',
        signature: 'float _log2f(float x)',
        description: 'Computes the base-2 logarithm of x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value (must be > 0)' }],
        returns: 'Log base 2 of x',
        category: 'Math',
        example: 'float stops = _log2f(exposure); // convert exposure ratio to stops'
    },
    {
        name: '_log10f',
        signature: 'float _log10f(float x)',
        description: 'Computes the base-10 logarithm of x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value (must be > 0)' }],
        returns: 'Log base 10 of x',
        category: 'Math',
        example: 'float cv = _log10f(x * 1023.0f + 1.0f) / _log10f(1024.0f); // Cineon-style log encoding'
    },
    {
        name: '_expf',
        signature: 'float _expf(float x)',
        description: 'Computes e^x, the base-e exponential of x',
        parameters: [{ name: 'x', type: 'float', description: 'Exponent value' }],
        returns: 'e^x',
        category: 'Math',
        example: 'float linear = _expf(logVal); // inverse of _logf'
    },
    {
        name: '_exp2f',
        signature: 'float _exp2f(float x)',
        description: 'Computes 2^x, the base-2 exponential of x',
        parameters: [{ name: 'x', type: 'float', description: 'Exponent value' }],
        returns: '2^x',
        category: 'Math',
        example: 'float gain = _exp2f(stops); // convert stops to linear gain multiplier'
    },
    {
        name: '_exp10f',
        signature: 'float _exp10f(float x)',
        description: 'Computes 10^x, the base-10 exponential of x',
        parameters: [{ name: 'x', type: 'float', description: 'Exponent value' }],
        returns: '10^x',
        category: 'Math',
        example: 'float linear = (_exp10f(cv * _log10f(1024.0f)) - 1.0f) / 1023.0f; // Cineon log decode'
    },

    // Math - Trigonometric
    {
        name: '_sinf',
        signature: 'float _sinf(float x)',
        description: 'Computes the sine of x (measured in radians)',
        parameters: [{ name: 'x', type: 'float', description: 'Angle in radians' }],
        returns: 'Sine of x',
        category: 'Trigonometry',
        example: 'float hue_shift = _sinf(angle) * saturation; // sinusoidal hue rotation'
    },
    {
        name: '_cosf',
        signature: 'float _cosf(float x)',
        description: 'Computes the cosine of x (measured in radians)',
        parameters: [{ name: 'x', type: 'float', description: 'Angle in radians' }],
        returns: 'Cosine of x',
        category: 'Trigonometry',
        example: 'float rr = r * _cosf(angle) - g * _sinf(angle); // 2D color rotation'
    },
    {
        name: '_tanf',
        signature: 'float _tanf(float x)',
        description: 'Computes the tangent of x (measured in radians)',
        parameters: [{ name: 'x', type: 'float', description: 'Angle in radians' }],
        returns: 'Tangent of x',
        category: 'Trigonometry',
        example: 'float slope = _tanf(angle); // convert angle to slope'
    },
    {
        name: '_asinf',
        signature: 'float _asinf(float x)',
        description: 'Computes the principal value of the arc sine of x',
        parameters: [{ name: 'x', type: 'float', description: 'Value in range [-1, 1]' }],
        returns: 'Arc sine of x in radians',
        category: 'Trigonometry',
        example: 'float angle = _asinf(_clampf(y / radius, -1.0f, 1.0f));'
    },
    {
        name: '_acosf',
        signature: 'float _acosf(float x)',
        description: 'Computes the principal value of the arc cosine of x',
        parameters: [{ name: 'x', type: 'float', description: 'Value in range [-1, 1]' }],
        returns: 'Arc cosine of x in radians',
        category: 'Trigonometry',
        example: 'float angle = _acosf(_clampf(dot, -1.0f, 1.0f)); // angle between vectors'
    },
    {
        name: '_atan2f',
        signature: 'float _atan2f(float y, float x)',
        description: 'Computes the principal value of arc tangent of y/x, using signs to determine quadrant',
        parameters: [
            { name: 'y', type: 'float', description: 'Y coordinate' },
            { name: 'x', type: 'float', description: 'X coordinate' }
        ],
        returns: 'Arc tangent of y/x in radians',
        category: 'Trigonometry',
        example: 'float hue = _atan2f(b - g, r - 0.5f * (g + b)); // compute hue angle'
    },
    {
        name: '_sinpif',
        signature: 'float _sinpif(float x)',
        description: 'Computes the sine of (x * pi)',
        parameters: [{ name: 'x', type: 'float', description: 'Value to multiply by pi' }],
        returns: 'sin(x * pi)',
        category: 'Trigonometry',
        example: 'float wave = _sinpif(2.0f * x); // sine wave with period 1.0'
    },
    {
        name: '_cospif',
        signature: 'float _cospif(float x)',
        description: 'Computes the cosine of (x * pi)',
        parameters: [{ name: 'x', type: 'float', description: 'Value to multiply by pi' }],
        returns: 'cos(x * pi)',
        category: 'Trigonometry',
        example: 'float window = 0.5f * (1.0f - _cospif(2.0f * t)); // Hann window function'
    },

    // Math - Rounding
    {
        name: '_ceilf',
        signature: 'float _ceilf(float x)',
        description: 'Returns the smallest integral value greater than or equal to x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value' }],
        returns: 'Ceiling of x',
        category: 'Math',
        example: 'int lutSize = (int)_ceilf(size); // round up to next whole LUT entry'
    },
    {
        name: '_floorf',
        signature: 'float _floorf(float x)',
        description: 'Returns the largest integral value less than or equal to x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value' }],
        returns: 'Floor of x',
        category: 'Math',
        example: 'float frac = x - _floorf(x); // extract fractional part for interpolation'
    },
    {
        name: '_truncf',
        signature: 'float _truncf(float x)',
        description: 'Returns the integral value nearest to but no larger in magnitude than x',
        parameters: [{ name: 'x', type: 'float', description: 'Input value' }],
        returns: 'Truncated value of x',
        category: 'Math',
        example: 'float whole = _truncf(value); // discard fractional part towards zero'
    },
    {
        name: '_round',
        signature: 'float _round(float x)',
        description: 'Returns the integral value nearest to x, rounding half-way cases away from zero',
        parameters: [{ name: 'x', type: 'float', description: 'Input value' }],
        returns: 'Rounded value of x',
        category: 'Math',
        example: 'int cv = (int)_round(value * 1023.0f); // quantize to 10-bit code value'
    },

    // Math - Min/Max/Clamp
    {
        name: '_fmaxf',
        signature: 'float _fmaxf(float x, float y)',
        description: 'Returns x or y, whichever is larger',
        parameters: [
            { name: 'x', type: 'float', description: 'First value' },
            { name: 'y', type: 'float', description: 'Second value' }
        ],
        returns: 'Maximum of x and y',
        category: 'Math',
        example: 'float maxChan = _fmaxf(r, _fmaxf(g, b)); // max RGB channel'
    },
    {
        name: '_fminf',
        signature: 'float _fminf(float x, float y)',
        description: 'Returns x or y, whichever is smaller',
        parameters: [
            { name: 'x', type: 'float', description: 'First value' },
            { name: 'y', type: 'float', description: 'Second value' }
        ],
        returns: 'Minimum of x and y',
        category: 'Math',
        example: 'float minChan = _fminf(r, _fminf(g, b)); // min RGB channel'
    },
    {
        name: '_clampf',
        signature: 'float _clampf(float x, float min, float max)',
        description: 'Clamps x to be within the interval [min, max]',
        parameters: [
            { name: 'x', type: 'float', description: 'Value to clamp' },
            { name: 'min', type: 'float', description: 'Minimum bound' },
            { name: 'max', type: 'float', description: 'Maximum bound' }
        ],
        returns: 'Clamped value',
        category: 'Math',
        example: 'float safe = _clampf(input, 0.0f, 1.0f); // keep in display range'
    },
    {
        name: '_saturatef',
        signature: 'float _saturatef(float x)',
        description: 'Clamps x to be within the interval [0.0, 1.0]',
        parameters: [{ name: 'x', type: 'float', description: 'Value to saturate' }],
        returns: 'Value clamped to [0.0, 1.0]',
        category: 'Math',
        example: 'float mask = _saturatef(luma * contrast); // create soft mask'
    },

    // Math - Misc
    {
        name: '_mix',
        signature: 'T _mix(T x, T y, float a)',
        description: 'Returns (x + (y - x) * a). Linear interpolation between x and y.',
        parameters: [
            { name: 'x', type: 'T', description: 'Start value (float, float2, float3, or float4)' },
            { name: 'y', type: 'T', description: 'End value' },
            { name: 'a', type: 'float', description: 'Interpolation factor [0.0, 1.0]' }
        ],
        returns: 'Interpolated value',
        category: 'Math',
        example: '_mix(0.0f, 1.0f, 0.5f) // returns 0.5'
    },
    {
        name: '_copysignf',
        signature: 'float _copysignf(float x, float y)',
        description: 'Returns x with its sign changed to match y',
        parameters: [
            { name: 'x', type: 'float', description: 'Magnitude value' },
            { name: 'y', type: 'float', description: 'Sign value' }
        ],
        returns: 'x with sign of y',
        category: 'Math',
        example: 'float result = _copysignf(_fabs(val), direction); // magnitude of val, sign of direction'
    },
    {
        name: '_fmod',
        signature: 'float _fmod(float x, float y)',
        description: 'Computes the floating-point remainder of x/y',
        parameters: [
            { name: 'x', type: 'float', description: 'Dividend' },
            { name: 'y', type: 'float', description: 'Divisor' }
        ],
        returns: 'Remainder of x/y',
        category: 'Math',
        example: 'float hue = _fmod(h + shift, 360.0f); // wrap hue angle to [0, 360)'
    },
    {
        name: '_hypotf',
        signature: 'float _hypotf(float x, float y)',
        description: 'Computes sqrt(x*x + y*y) - the hypotenuse',
        parameters: [
            { name: 'x', type: 'float', description: 'First leg' },
            { name: 'y', type: 'float', description: 'Second leg' }
        ],
        returns: 'Hypotenuse length',
        category: 'Math',
        example: 'float chroma = _hypotf(a, b); // CIELab chroma from a*, b*'
    },

    // Texture
    {
        name: '_tex2D',
        signature: 'float _tex2D(__TEXTURE__ tex, int x, int y)',
        description: 'Reads a single channel value from a texture at the specified coordinates',
        parameters: [
            { name: 'tex', type: '__TEXTURE__', description: 'Texture reference (p_TexR, p_TexG, p_TexB, etc.)' },
            { name: 'x', type: 'int', description: 'X coordinate (column)' },
            { name: 'y', type: 'int', description: 'Y coordinate (row)' }
        ],
        returns: 'Float value at the specified pixel',
        category: 'Texture',
        example: 'float r = _tex2D(p_TexR, p_X, p_Y);'
    },

    // Vector construction
    {
        name: 'make_float2',
        signature: 'float2 make_float2(float x, float y)',
        description: 'Constructs a float2 vector from two float values',
        parameters: [
            { name: 'x', type: 'float', description: 'X component' },
            { name: 'y', type: 'float', description: 'Y component' }
        ],
        returns: 'float2 vector',
        category: 'Vector',
        example: 'float2 uv = make_float2((float)p_X / p_Width, (float)p_Y / p_Height);'
    },
    {
        name: 'make_float3',
        signature: 'float3 make_float3(float x, float y, float z)',
        description: 'Constructs a float3 vector from three float values',
        parameters: [
            { name: 'x', type: 'float', description: 'X/R component' },
            { name: 'y', type: 'float', description: 'Y/G component' },
            { name: 'z', type: 'float', description: 'Z/B component' }
        ],
        returns: 'float3 vector',
        category: 'Vector',
        example: 'float3 rgb = make_float3(1.0f, 0.5f, 0.0f);'
    },
    {
        name: 'make_float4',
        signature: 'float4 make_float4(float x, float y, float z, float w)',
        description: 'Constructs a float4 vector from four float values',
        parameters: [
            { name: 'x', type: 'float', description: 'X/R component' },
            { name: 'y', type: 'float', description: 'Y/G component' },
            { name: 'z', type: 'float', description: 'Z/B component' },
            { name: 'w', type: 'float', description: 'W/A component' }
        ],
        returns: 'float4 vector',
        category: 'Vector',
        example: 'float4 rgba = make_float4(r, g, b, 1.0f); // RGBA with full opacity'
    },

    // LUT
    {
        name: 'APPLY_LUT',
        signature: 'float3 APPLY_LUT(float r, float g, float b, lutName)',
        description: 'Applies a defined LUT to RGB values',
        parameters: [
            { name: 'r', type: 'float', description: 'Red channel value' },
            { name: 'g', type: 'float', description: 'Green channel value' },
            { name: 'b', type: 'float', description: 'Blue channel value' },
            { name: 'lutName', type: 'identifier', description: 'Name of LUT defined with DEFINE_LUT' }
        ],
        returns: 'Transformed RGB values',
        category: 'LUT',
        example: 'DEFINE_LUT(myLut, 65)\nfloat3 result = APPLY_LUT(r, g, b, myLut);'
    },

    // Random
    {
        name: 'RAND',
        signature: 'float RAND(uint seed)',
        description: 'Generates a pseudo-random float value between 0.0 and 1.0 with uniform distribution (Resolve 19.1+)',
        parameters: [{ name: 'seed', type: 'uint', description: 'Random seed value' }],
        returns: 'Random float in [0.0, 1.0]',
        category: 'Utility',
        example: 'float noise = (RAND(p_Y * p_Width + p_X) - 0.5f) * amount; // per-pixel dither'
    },

    // Check functions
    {
        name: 'isinf',
        signature: 'int isinf(float x)',
        description: 'Returns a non-zero value if and only if x is an infinite value',
        parameters: [{ name: 'x', type: 'float', description: 'Value to check' }],
        returns: 'Non-zero if x is infinite',
        category: 'Utility',
        example: 'if (isinf(r)) r = 0.0f; // replace infinity with zero'
    },
    {
        name: 'isnan',
        signature: 'int isnan(float x)',
        description: 'Returns a non-zero value if and only if x is NaN (Not a Number)',
        parameters: [{ name: 'x', type: 'float', description: 'Value to check' }],
        returns: 'Non-zero if x is NaN',
        category: 'Utility',
        example: 'if (isnan(r)) r = 0.0f; // sanitize NaN values'
    },
    {
        name: 'signbit',
        signature: 'int signbit(float x)',
        description: 'Returns a non-zero value if and only if the sign bit of x is set',
        parameters: [{ name: 'x', type: 'float', description: 'Value to check' }],
        returns: 'Non-zero if x is negative',
        category: 'Utility',
        example: 'if (signbit(val)) val = 0.0f; // clamp negative values to zero'
    },
];

// Create lookup map for quick access
export const DCTL_FUNCTION_MAP = new Map<string, DctlFunctionDoc>(
    DCTL_FUNCTION_DOCS.map(doc => [doc.name, doc])
);

/**
 * DCTL Keywords and Types documentation
 */
export interface DctlKeywordDoc {
    name: string;
    description: string;
    category: string;
}

export const DCTL_KEYWORD_DOCS: DctlKeywordDoc[] = [
    { name: '__DEVICE__', description: 'Qualifier to define a GPU device function', category: 'Qualifier' },
    { name: '__TEXTURE__', description: 'Type for a texture reference parameter', category: 'Type' },
    { name: '__CONSTANT__', description: 'Qualifier to define constant memory', category: 'Qualifier' },
    { name: '__CONSTANTREF__', description: 'Qualifier for constant memory parameter passed to a function', category: 'Qualifier' },
    { name: 'float2', description: 'Vector type of 2 float values', category: 'Type' },
    { name: 'float3', description: 'Vector type of 3 float values (commonly used for RGB)', category: 'Type' },
    { name: 'float4', description: 'Vector type of 4 float values (commonly used for RGBA)', category: 'Type' },
    { name: 'TRANSITION_PROGRESS', description: 'Global read-only variable holding transition progress (0.0 to 1.0)', category: 'Variable' },
    { name: 'TIMELINE_FRAME_INDEX', description: 'Current frame index on timeline (Resolve 19.1+)', category: 'Variable' },
];

export const DCTL_KEYWORD_MAP = new Map<string, DctlKeywordDoc>(
    DCTL_KEYWORD_DOCS.map(doc => [doc.name, doc])
);

/**
 * UI Parameter types
 */
export const DCTL_UI_TYPES = [
    { name: 'DCTLUI_SLIDER_FLOAT', description: 'Float slider control', params: 'default, min, max, step' },
    { name: 'DCTLUI_SLIDER_INT', description: 'Integer slider control', params: 'default, min, max, step' },
    { name: 'DCTLUI_VALUE_BOX', description: 'Numeric value input box', params: 'default' },
    { name: 'DCTLUI_CHECK_BOX', description: 'Checkbox toggle', params: 'default (0 or 1)' },
    { name: 'DCTLUI_COMBO_BOX', description: 'Dropdown combo box', params: 'default, {enum_list}, {label_list}' },
    { name: 'DCTLUI_COLOR_PICKER', description: 'Color picker (Resolve 19.1+)', params: 'defaultR, defaultG, defaultB' },
];
