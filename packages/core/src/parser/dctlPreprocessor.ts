/**
 * DCTL Preprocessor
 *
 * Transforms DCTL-specific syntax into C-compatible code for tree-sitter parsing.
 * This allows the C parser to correctly parse DCTL files and detect real syntax errors.
 */

/**
 * Mapping of line/column positions between original and preprocessed code
 */
export interface PositionMapping {
    originalLine: number;
    originalColumn: number;
    preprocessedLine: number;
    preprocessedColumn: number;
}

/**
 * Result of preprocessing
 */
export interface PreprocessResult {
    /** The preprocessed C-compatible code */
    code: string;
    /** Number of lines added as type definitions header */
    headerLineCount: number;
    /** Original source for error mapping */
    originalSource: string;
}

/**
 * C-compatible type definitions for DCTL types
 * These are prepended to the source so tree-sitter understands DCTL types
 */
const DCTL_TYPE_DEFINITIONS = `
// DCTL Type Definitions (auto-generated for parsing)
typedef struct { float x, y; } float2;
typedef struct { float x, y, z; } float3;
typedef struct { float x, y, z, w; } float4;
typedef struct { int x, y; } int2;
typedef struct { int x, y, z; } int3;
typedef struct { int x, y, z, w; } int4;
typedef struct { unsigned char x, y; } uchar2;
typedef struct { unsigned char x, y, z; } uchar3;
typedef struct { unsigned char x, y, z, w; } uchar4;
typedef struct { short x, y; } half2;
typedef struct { short x, y, z; } half3;
typedef struct { short x, y, z, w; } half4;
typedef float mat2[4];
typedef float mat3[9];
typedef float mat4[16];
typedef struct { float3 c0, c1, c2; } float3x3;
typedef struct { float4 c0, c1, c2, c3; } float4x4;
typedef void* __TEXTURE__;
typedef void* __TEXTURE2D__;
typedef void* __TEXTURE3D__;

// DCTL built-in function declarations
float2 make_float2(float x, float y);
float3 make_float3(float x, float y, float z);
float4 make_float4(float x, float y, float z, float w);
int2 make_int2(int x, int y);
int3 make_int3(int x, int y, int z);
int4 make_int4(int x, int y, int z, int w);
float4 _tex2D(__TEXTURE2D__ tex, float x, float y);
float4 _tex3D(__TEXTURE3D__ tex, float x, float y, float z);

// Math functions
float _saturatef(float x);
float _hypotf(float x, float y);
float _sqrtf(float x);
float _powf(float x, float y);
float _expf(float x);
float _exp2f(float x);
float _logf(float x);
float _log2f(float x);
float _log10f(float x);
float _sinf(float x);
float _cosf(float x);
float _tanf(float x);
float _asinf(float x);
float _acosf(float x);
float _atanf(float x);
float _atan2f(float y, float x);
float _fabs(float x);
float _fabsf(float x);
float _floorf(float x);
float _ceilf(float x);
float _roundf(float x);
float _truncf(float x);
float _fmodf(float x, float y);
float _fminf(float x, float y);
float _fmaxf(float x, float y);
float _mix(float x, float y, float a);
float _clampf(float x, float minVal, float maxVal);
float _copysignf(float x, float y);
int min(int x, int y);
int max(int x, int y);
float fmin(float x, float y);
float fmax(float x, float y);
float3 cross(float3 a, float3 b);
float dot(float3 a, float3 b);
float length(float3 v);
float3 normalize(float3 v);

// Matrix functions
float3x3 make_float3x3(float3 c0, float3 c1, float3 c2);
float4x4 make_float4x4(float4 c0, float4 c1, float4 c2, float4 c3);
float3 mult_f3_f33(float3 v, float3x3 m);
float3 mult_f3_f44(float3 v, float4x4 m);
float3x3 transpose_f33(float3x3 m);
float3x3 invert_f33(float3x3 m);
float determinant_f33(float3x3 m);

// End of DCTL Type Definitions
`;

// Count lines in the header
const HEADER_LINE_COUNT = DCTL_TYPE_DEFINITIONS.split('\n').length;

/**
 * Convert DEFINE_UI_PARAMS macro to a variable declaration
 * Format: DEFINE_UI_PARAMS(name, label, type, default, ...)
 * Output: float name; or int name; etc.
 * For COMBO_BOX: Also outputs enum value definitions (e.g., int logc = 0;)
 */
function convertDefineUiParams(match: string, indent: string, args: string): string {
    const argList = args.split(',').map(s => s.trim());
    if (argList.length < 3) {
        // Invalid macro, just comment it out
        return `${indent}// [DCTL_MACRO] DEFINE_UI_PARAMS (invalid)`;
    }

    const varName = argList[0];
    const uiType = argList[2];

    // Determine variable type based on UI type
    let varType = 'float';
    if (uiType.includes('INT')) {
        varType = 'int';
    } else if (uiType.includes('CHECK_BOX')) {
        varType = 'int'; // DCTL uses int for booleans
    } else if (uiType.includes('COMBO_BOX')) {
        varType = 'int';
    } else if (uiType.includes('COLOR_PICKER')) {
        varType = 'float3'; // Color picker is a vec3 with r,g,b components
    }

    let result = '';

    // Handle COMBO_BOX enum values
    // Format: DEFINE_UI_PARAMS(name, label, DCTLUI_COMBO_BOX, default, {enum1, enum2, ...}, {label1, label2, ...})
    // All declarations are placed on a single line to preserve line count mapping
    if (uiType.includes('COMBO_BOX') && argList.length >= 5) {
        // Find the enum list (enclosed in braces)
        const fullArgs = args;
        const enumMatch = fullArgs.match(/\{([^}]+)\}/);
        if (enumMatch) {
            const enumValues = enumMatch[1].split(',').map(s => s.trim());
            // Generate integer constants for each enum value (on same line)
            enumValues.forEach((enumName, index) => {
                if (enumName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(enumName)) {
                    result += `int ${enumName} = ${index}; `;
                }
            });
        }
    }

    // Return variable declaration (all on one line to preserve line mapping)
    result += `${varType} ${varName}; // [DCTL_MACRO] DEFINE_UI_PARAMS`;
    return `${indent}${result}`;

}

/**
 * Patterns to transform in the source code
 */
const DCTL_TRANSFORMS: Array<{ pattern: RegExp; replacement: string | ((match: string, ...args: string[]) => string) }> = [
    // Convert DEFINE_UI_PARAMS to variable declarations
    // Note: Using .+ instead of [\s\S]*? to stay on single line (. doesn't match newlines)
    // Pattern allows for trailing // comments after the closing paren
    // IMPORTANT: Use [ \t]* (not \s*) after ')' to avoid consuming newlines across line boundaries
    {
        pattern: /^([ \t]*)DEFINE_UI_PARAMS\s*\((.+)\)[ \t]*;?[ \t]*(?:\/\/.*)?$/gm,
        replacement: (match: string, indent: string, args: string) => convertDefineUiParams(match, indent, args)
    },
    // Remove other DEFINE_* macros by converting to comments
    // IMPORTANT: Use [ \t]* (not \s*) at end to avoid consuming newlines
    { pattern: /^([ \t]*)DEFINE_UI_TOOLTIP\s*\(.+\)[ \t]*;?[ \t]*$/gm, replacement: '$1// [DCTL_MACRO] DEFINE_UI_TOOLTIP' },
    { pattern: /^([ \t]*)DEFINE_ACES_PARAM\s*\(.+\)[ \t]*;?[ \t]*$/gm, replacement: '$1// [DCTL_MACRO] DEFINE_ACES_PARAM' },
    // DEFINE_DCTL_ALPHA_MODE macros (e.g., DEFINE_DCTL_ALPHA_MODE_STRAIGHT)
    { pattern: /^([ \t]*)DEFINE_DCTL_ALPHA_MODE\w*[ \t]*$/gm, replacement: '$1// [DCTL_MACRO] DEFINE_DCTL_ALPHA_MODE' },
    // Handle DEFINE_DCTL_ALPHA_MODE at start of file without leading whitespace
    { pattern: /^DEFINE_DCTL_ALPHA_MODE\w*[ \t]*$/m, replacement: '// [DCTL_MACRO] DEFINE_DCTL_ALPHA_MODE' },

    // Replace __DEVICE__, __GLOBAL__, __LOCAL__ with spaces to preserve column positions
    { pattern: /__DEVICE__\s+/g, replacement: (m: string) => ' '.repeat(m.length) },
    { pattern: /__CONSTANT__\s+/g, replacement: (m: string) => 'const ' + ' '.repeat(m.length - 6) },
    { pattern: /__GLOBAL__\s+/g, replacement: (m: string) => ' '.repeat(m.length) },
    { pattern: /__LOCAL__\s+/g, replacement: (m: string) => ' '.repeat(m.length) },
];

/**
 * Represents a function-like macro with parameters
 */
interface FunctionMacro {
    params: string[];
    body: string;
}

/**
 * Strip inline comments from a string (for macro values)
 * Handles both // and block comment style comments
 */
function stripInlineComment(value: string): string {
    // Handle // style comments - but be careful not to strip inside string literals
    let result = '';
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        const nextCh = value[i + 1] || '';

        // Handle string literals
        if (!inString && (ch === '"' || ch === "'")) {
            inString = true;
            stringChar = ch;
            result += ch;
        } else if (inString && ch === stringChar && value[i - 1] !== '\\') {
            inString = false;
            stringChar = '';
            result += ch;
        } else if (!inString && ch === '/' && nextCh === '/') {
            // Found // comment, stop here
            break;
        } else if (!inString && ch === '/' && nextCh === '*') {
            // Find end of /* */ comment
            const endIdx = value.indexOf('*/', i + 2);
            if (endIdx === -1) {
                // Unclosed comment, stop here
                break;
            }
            // Skip the comment
            i = endIdx + 1;
        } else {
            result += ch;
        }
    }

    return result.trim();
}

/**
 * Join lines that end with backslash (line continuation)
 */
function joinBackslashLines(source: string): string {
    const lines = source.split('\n');
    const result: string[] = [];
    let currentLine = '';

    for (const line of lines) {
        // Check if line ends with backslash (possibly with trailing whitespace)
        const trimmedEnd = line.trimEnd();
        if (trimmedEnd.endsWith('\\')) {
            // Append this line without the backslash to currentLine
            currentLine += trimmedEnd.slice(0, -1) + ' ';
        } else {
            // No continuation, complete the line
            currentLine += line;
            result.push(currentLine);
            currentLine = '';
        }
    }

    // Handle any remaining content
    if (currentLine) {
        result.push(currentLine);
    }

    return result.join('\n');
}

/**
 * Process C preprocessor #define macros
 * Handles both object-like macros (#define NAME value) and
 * function-like macros (#define NAME(a, b) expression)
 */
function processDefines(source: string): string {
    // First, join lines that end with backslash (line continuation)
    source = joinBackslashLines(source);

    const objectMacros = new Map<string, string>();
    const functionMacros = new Map<string, FunctionMacro>();
    const definedFlags = new Set<string>(); // Track #define without value (flags)
    const lines = source.split('\n');
    const resultLines: string[] = [];

    // Stack for conditional compilation: true = include code, false = exclude code
    const conditionalStack: boolean[] = [];
    let currentlyIncluding = true;

    for (const line of lines) {
        const trimmed = line.trim();

        // Handle conditional compilation directives
        const ifdefMatch = trimmed.match(/^#\s*ifdef\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (ifdefMatch) {
            const macroName = ifdefMatch[1];
            conditionalStack.push(currentlyIncluding);
            // Include if currently including AND macro is defined
            currentlyIncluding = currentlyIncluding && (definedFlags.has(macroName) || objectMacros.has(macroName) || functionMacros.has(macroName));
            resultLines.push('// ' + line);
            continue;
        }

        const ifndefMatch = trimmed.match(/^#\s*ifndef\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (ifndefMatch) {
            const macroName = ifndefMatch[1];
            conditionalStack.push(currentlyIncluding);
            // Include if currently including AND macro is NOT defined
            currentlyIncluding = currentlyIncluding && !(definedFlags.has(macroName) || objectMacros.has(macroName) || functionMacros.has(macroName));
            resultLines.push('// ' + line);
            continue;
        }

        // Handle #if (very basic: only handles #if 0 and #if 1)
        const ifMatch = trimmed.match(/^#\s*if\s+(.+)/);
        if (ifMatch && !trimmed.match(/^#\s*ifdef/) && !trimmed.match(/^#\s*ifndef/)) {
            conditionalStack.push(currentlyIncluding);
            const condition = ifMatch[1].trim();
            // Very basic evaluation: only handle "0" and "1" for now
            if (condition === '0') {
                currentlyIncluding = false;
            } else if (condition === '1') {
                // Keep currentlyIncluding as is
            }
            // For other conditions, we assume true (include the code)
            resultLines.push('// ' + line);
            continue;
        }

        const elseMatch = trimmed.match(/^#\s*else\b/);
        if (elseMatch) {
            if (conditionalStack.length > 0) {
                // Flip the inclusion state, but only if parent was including
                const parentIncluding = conditionalStack[conditionalStack.length - 1];
                currentlyIncluding = parentIncluding && !currentlyIncluding;
            }
            resultLines.push('// ' + line);
            continue;
        }

        // Handle #elif (treat as #else followed by #if)
        const elifMatch = trimmed.match(/^#\s*elif\s+(.+)/);
        if (elifMatch) {
            // For simplicity, treat #elif as #else (flip state)
            if (conditionalStack.length > 0) {
                const parentIncluding = conditionalStack[conditionalStack.length - 1];
                currentlyIncluding = parentIncluding && !currentlyIncluding;
            }
            resultLines.push('// ' + line);
            continue;
        }

        const endifMatch = trimmed.match(/^#\s*endif\b/);
        if (endifMatch) {
            if (conditionalStack.length > 0) {
                currentlyIncluding = conditionalStack.pop()!;
            }
            resultLines.push('// ' + line);
            continue;
        }

        // Skip lines when not including (in a false #ifdef/#ifndef/#else block)
        if (!currentlyIncluding) {
            resultLines.push('// [excluded] ' + line);
            continue;
        }

        // Parse function-like macro: #define NAME(params) body
        // NOTE: In C preprocessor, there must be NO space between the name and '('.
        // "#define FOO(x) x*2" is function-like, but "#define FOO (x)" is object-like with value "(x)".
        const funcMacroMatch = trimmed.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\(\s*([^)]*)\s*\)\s*(.*)$/);
        if (funcMacroMatch) {
            const [, name, paramsStr, body] = funcMacroMatch;
            const params = paramsStr.split(',').map(p => p.trim()).filter(p => p.length > 0);
            // Strip inline comments from macro body
            const cleanBody = stripInlineComment(body);
            functionMacros.set(name, { params, body: cleanBody });
            resultLines.push('// ' + line);
            continue;
        }

        // Parse object-like macro: #define NAME value
        const objMacroMatch = trimmed.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
        if (objMacroMatch) {
            const [, name, value] = objMacroMatch;
            // Strip inline comments from macro value
            const cleanValue = stripInlineComment(value);
            objectMacros.set(name, cleanValue);
            definedFlags.add(name); // Also track as defined for #ifdef
            resultLines.push('// ' + line);
            continue;
        }

        // Parse #define without value (flag)
        const defineFlagMatch = trimmed.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
        if (defineFlagMatch) {
            const [, name] = defineFlagMatch;
            objectMacros.set(name, '1');
            definedFlags.add(name);
            resultLines.push('// ' + line);
            continue;
        }

        // Remove #line directives
        if (/^#\s*line\b/.test(trimmed)) {
            resultLines.push('// ' + line);
            continue;
        }

        resultLines.push(line);
    }

    // Join lines
    let result = resultLines.join('\n');

    // Expand function-like macros first (they have arguments)
    // Sort by name length (longest first) to avoid partial replacements
    const sortedFuncMacros = [...functionMacros.entries()].sort((a, b) => b[0].length - a[0].length);

    for (const [name, macro] of sortedFuncMacros) {
        // Match macro invocation with arguments: NAME(arg1, arg2, ...)
        // Handle nested parentheses in arguments
        const macroCallRegex = new RegExp(`\\b${name}\\s*\\(`, 'g');
        let match;

        while ((match = macroCallRegex.exec(result)) !== null) {
            const startIdx = match.index;
            const argsStartIdx = startIdx + match[0].length;

            // Find matching closing parenthesis
            let depth = 1;
            let endIdx = argsStartIdx;
            while (depth > 0 && endIdx < result.length) {
                if (result[endIdx] === '(') depth++;
                else if (result[endIdx] === ')') depth--;
                endIdx++;
            }

            if (depth !== 0) continue; // Unbalanced parentheses

            const argsStr = result.substring(argsStartIdx, endIdx - 1);
            const args = parseArguments(argsStr);

            if (args.length !== macro.params.length && macro.params.length > 0) {
                // Argument count mismatch, skip
                continue;
            }

            // Replace parameters with arguments in macro body
            let expanded = macro.body;
            for (let i = 0; i < macro.params.length; i++) {
                const paramRegex = new RegExp(`\\b${macro.params[i]}\\b`, 'g');
                expanded = expanded.replace(paramRegex, args[i] || '');
            }

            // Replace the macro call with expanded body
            result = result.substring(0, startIdx) + expanded + result.substring(endIdx);

            // Reset regex to continue searching from the replacement position
            macroCallRegex.lastIndex = startIdx + expanded.length;
        }
    }

    // Expand object-like macros
    const sortedObjMacros = [...objectMacros.entries()].sort((a, b) => b[0].length - a[0].length);

    // Expand macro values recursively
    const expandedValues = new Map<string, string>();
    const expandMacroValue = (value: string, visited: Set<string>): string => {
        let expandedResult = value;
        for (const [macroName, macroValue] of sortedObjMacros) {
            if (visited.has(macroName)) continue;
            const regex = new RegExp(`\\b${macroName}\\b`, 'g');
            if (regex.test(expandedResult)) {
                visited.add(macroName);
                const expandedDefValue = expandedValues.get(macroName) ?? expandMacroValue(macroValue, new Set(visited));
                expandedValues.set(macroName, expandedDefValue);
                expandedResult = expandedResult.replace(new RegExp(`\\b${macroName}\\b`, 'g'), expandedDefValue);
            }
        }
        return expandedResult;
    };

    // Pre-expand all macro values
    for (const [name, value] of sortedObjMacros) {
        if (!expandedValues.has(name)) {
            expandedValues.set(name, expandMacroValue(value, new Set([name])));
        }
    }

    // Expand macros in code
    for (const [name] of sortedObjMacros) {
        const expandedValue = expandedValues.get(name) ?? objectMacros.get(name) ?? '';
        const regex = new RegExp(`\\b${name}\\b`, 'g');
        result = result.replace(regex, expandedValue);
    }

    return result;
}

/**
 * Parse comma-separated arguments, handling nested parentheses
 */
function parseArguments(argsStr: string): string[] {
    const args: string[] = [];
    let depth = 0;
    let current = '';

    for (let i = 0; i < argsStr.length; i++) {
        const ch = argsStr[i];
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            current += ch;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
            current += ch;
        } else if (ch === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim().length > 0) {
        args.push(current.trim());
    }

    return args;
}

/**
 * Preprocess DCTL source code for C parser compatibility
 */
export function preprocessDctl(source: string): PreprocessResult {
    let code = source;

    // First, process C preprocessor #define macros
    code = processDefines(code);

    // Apply transforms
    for (const transform of DCTL_TRANSFORMS) {
        if (typeof transform.replacement === 'function') {
            code = code.replace(transform.pattern, transform.replacement as (...args: string[]) => string);
        } else {
            code = code.replace(transform.pattern, transform.replacement);
        }
    }

    // Prepend type definitions
    code = DCTL_TYPE_DEFINITIONS + code;

    return {
        code,
        headerLineCount: HEADER_LINE_COUNT,
        originalSource: source,
    };
}

/**
 * Map a position from preprocessed code back to original source
 */
export function mapPositionToOriginal(
    preprocessedLine: number,
    preprocessedColumn: number,
    result: PreprocessResult
): { line: number; column: number } {
    // Subtract header lines to get original position
    const originalLine = preprocessedLine - result.headerLineCount;

    // If position is in the header, return line 0
    if (originalLine < 0) {
        return { line: 0, column: 0 };
    }

    // Column stays the same (transforms preserve column positions on same line)
    return {
        line: originalLine,
        column: preprocessedColumn,
    };
}

/**
 * Check if a line number is in the generated header
 */
export function isHeaderLine(line: number, result: PreprocessResult): boolean {
    return line < result.headerLineCount;
}
