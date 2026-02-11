/**
 * DCTL Define and Conditional Processor
 *
 * Handles:
 * - #define/#undef directives
 * - Conditional compilation (#ifdef, #ifndef, #if, #else, #elif, #endif)
 * - Macro substitution
 *
 * Processing order:
 * 1. Scan for #define and conditional directives
 * 2. Evaluate conditionals and skip inactive blocks
 * 3. Substitute macros in active code
 */

import {
    processConditionals,
    DEFAULT_PREDEFINED_MACROS,
    ConditionalError,
} from './conditionalEval';
import { extractUIParams, type DctlParam } from '@dctl-workbench/core';

export interface MacroDefinition {
    name: string;
    value: string;
    line: number;
}

export interface DefineProcessResult {
    /** Processed source with macros expanded */
    source: string;
    /** Parsed macro definitions (object-like macros) */
    macros: MacroDefinition[];
    /** Parsed function-like macro definitions */
    functionMacros: FunctionMacro[];
    /** Extracted UI parameters from DEFINE_UI_PARAMS */
    params: DctlParam[];
    /** Warnings */
    warnings: string[];
    /** Errors from conditional processing */
    errors: ConditionalError[];
    /** Number of lines added at the beginning (for line number adjustment) */
    lineOffset: number;
}

/**
 * Pattern for object-like macros: #define NAME value
 * Captures: name, value (everything after name until end of line)
 */
const DEFINE_PATTERN = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*?)$/;

/**
 * Pattern for #define without value (flag-like): #define NAME
 */
const DEFINE_FLAG_PATTERN = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/**
 * Pattern for function-like macro: #define NAME(args) body
 * NOTE: In C preprocessor, function-like macros have NO space between name and '('
 * This distinguishes "#define FOO(x) x*2" (function) from "#define FOO (1+2)" (object)
 */
const DEFINE_FUNCTION_PATTERN = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*(.*?)$/;

/**
 * Pattern for #undef: #undef NAME
 */
const UNDEF_PATTERN = /^\s*#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Patterns for preprocessor directives that are handled elsewhere or should be removed
 */
const PRAGMA_PATTERN = /^\s*#\s*pragma\b/;
const ERROR_PATTERN = /^\s*#\s*error\b/;
const WARNING_PATTERN = /^\s*#\s*warning\b/;
const LINE_PATTERN = /^\s*#\s*line\b/;

export interface FunctionMacro {
    name: string;
    params: string[];
    body: string;
    line: number;
}

/**
 * Remove a macro call with balanced parentheses from source.
 * Handles nested parentheses like DEFINE_UI_PARAMS(...{LCH(ab)}...)
 */
function removeBalancedMacro(source: string, macroName: string): string {
    const regex = new RegExp(macroName + '\\s*\\(', 'g');
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(source)) !== null) {
        // Add content before the match
        result += source.slice(lastIndex, match.index);

        // Find matching closing parenthesis
        let depth = 1;
        let i = match.index + match[0].length;
        while (i < source.length && depth > 0) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') depth--;
            i++;
        }

        // Skip trailing whitespace and semicolon
        while (i < source.length && (source[i] === ' ' || source[i] === '\t')) {
            i++;
        }
        if (i < source.length && source[i] === ';') {
            i++;
        }

        // Count newlines in the removed content to preserve line numbers
        const removedContent = source.slice(match.index, i);
        const newlineCount = (removedContent.match(/\n/g) || []).length;
        // Replace with equivalent newlines to maintain line numbers
        result += '\n'.repeat(newlineCount);

        lastIndex = i;
        regex.lastIndex = i;
    }

    result += source.slice(lastIndex);
    return result;
}

/**
 * Strip DCTL special macros that span multiple lines
 * (DEFINE_ACES_PARAM, DEFINE_UI_PARAMS, DEFINE_UI_TOOLTIP, etc.)
 *
 * For DEFINE_UI_PARAMS, extracts parameters but does NOT generate declarations yet.
 * Declarations are generated later by processDefines after macro expansion,
 * to avoid conflicts where macro names get substituted in the declarations.
 *
 * @returns Object containing processed source, extracted UI params, and any errors/warnings
 */
function stripSpecialMacros(source: string): {
    source: string;
    params: DctlParam[];
    errors: string[];
    warnings: string[];
    lineOffset: number;
} {
    // Extract UI params (but don't generate declarations yet - done after macro expansion)
    const uiParamsResult = extractUIParams(source);

    // Extract LUT definitions before stripping
    const lutDeclarations = extractLutDeclarations(source);

    // Remove macros with balanced parentheses (handles nested parens)
    source = removeBalancedMacro(source, 'DEFINE_ACES_PARAM');
    source = removeBalancedMacro(source, 'DEFINE_UI_PARAMS');
    source = removeBalancedMacro(source, 'DEFINE_UI_TOOLTIP');
    // Match DEFINE_DCTL_ALPHA_MODE variants - remove entirely
    source = source.replace(/DEFINE_DCTL_ALPHA_MODE\w*/g, '');
    // Match DEFINE_LUT(...) - remove entirely (we've already extracted declarations)
    source = source.replace(/DEFINE_LUT\s*\([^)]*\)/g, '');
    // Replace APPLY_LUT(r, g, b, lutName) with make_float3(r, g, b) for validation
    source = source.replace(/APPLY_LUT\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/g,
        'make_float3($1, $2, $3)');

    // NOTE: Do NOT remove address-of operators (&) here!
    // The codegen handles & correctly:
    // - For inout parameters, & is stripped when passing to functions
    // - For type punning patterns like *(type*)&var, we generate floatBitsToUint/uintBitsToFloat
    // Removing & in the preprocessor breaks type punning detection.

    // Calculate line offset from LUT declarations only
    let lineOffset = 0;
    if (lutDeclarations) {
        lineOffset = lutDeclarations.split('\n').length;
        source = lutDeclarations + '\n' + source;
    }

    return {
        source,
        params: uiParamsResult.params,
        errors: uiParamsResult.errors,
        warnings: uiParamsResult.warnings,
        lineOffset,
    };
}

/**
 * Extract LUT definitions and generate stub declarations
 * DEFINE_LUT(name, path) -> int name; (stub for validation)
 */
function extractLutDeclarations(source: string): string {
    const lutPattern = /DEFINE_LUT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/g;
    const lutNames: string[] = [];
    let match;

    while ((match = lutPattern.exec(source)) !== null) {
        lutNames.push(match[1]);
    }

    if (lutNames.length === 0) {
        return '';
    }

    const lines = ['// Generated LUT declarations (stubs for validation)'];
    for (const name of lutNames) {
        // Use int as a stub type - the actual LUT is a texture that can't be represented
        lines.push(`int ${name};`);
    }

    return lines.join('\n');
}

/**
 * Generate C-style declarations for UI parameters
 * These will be parsed by the DCTL parser and converted to GLSL uniforms
 *
 * @param params - Extracted UI parameters
 * @param macroMap - Map of macro names to their values (to avoid generating
 *                   const declarations for names that are already #defined)
 */
function generateUIParamDeclarations(
    params: ReturnType<typeof extractUIParams>['params'],
    macroMap: Map<string, string>
): string {
    if (params.length === 0) {
        return '';
    }

    const lines: string[] = ['// Generated UI parameter declarations'];

    for (const param of params) {
        switch (param.type) {
            case 'DCTL_SLIDER_FLOAT':
            case 'DCTL_VALUE_BOX':
                // Float parameter
                lines.push(`float ${param.name};`);
                break;

            case 'DCTL_SLIDER_INT':
                // Integer parameter
                lines.push(`int ${param.name};`);
                break;

            case 'DCTL_CHECK_BOX':
                // Integer parameter (0/1) - DCTL uses int for checkboxes
                // Using int instead of bool ensures compatibility with functions that expect int
                lines.push(`int ${param.name};`);
                break;

            case 'DCTL_COMBO_BOX':
                // Combo box: generate int variable and const int enum constants
                // Only generate const for option names that are NOT already #defined
                // (if they're #defined, the macro expansion will handle them)
                if ('options' in param && param.options.length > 0) {
                    for (let i = 0; i < param.options.length; i++) {
                        const optionName = param.options[i];
                        // Only generate if:
                        // 1. It looks like a valid C identifier
                        // 2. It's NOT already defined as a macro
                        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(optionName) &&
                            !macroMap.has(optionName)) {
                            lines.push(`const int ${optionName} = ${i};`);
                        }
                    }
                }
                lines.push(`int ${param.name};`);
                break;

            case 'DCTL_COLOR_PICKER':
                // Color picker: float3 variable with r, g, b components
                lines.push(`float3 ${param.name};`);
                break;
        }
    }

    return lines.join('\n');
}

/**
 * Join lines that end with backslash (line continuation) for macro definitions.
 * This is done before parsing macros so that multi-line macros are treated as single logical lines.
 * Preserves line count by replacing continuation lines with empty strings.
 *
 * Example:
 *   #define FOO(x) { \
 *       x + 1; \
 *   }
 * Becomes:
 *   #define FOO(x) {     x + 1;     }
 *   (empty line)
 *   (empty line)
 */
function joinContinuationLines(source: string): string {
    const lines = source.split('\n');
    const result: string[] = [];
    let i = 0;

    while (i < lines.length) {
        let line = lines[i];

        // Check if this line ends with backslash (continuation)
        if (line.trimEnd().endsWith('\\')) {
            // Start accumulating continuation lines
            const parts: string[] = [];
            const startLine = i;

            while (i < lines.length && lines[i].trimEnd().endsWith('\\')) {
                // Remove the trailing backslash and add to parts
                const trimmed = lines[i].trimEnd();
                parts.push(trimmed.slice(0, -1));  // Remove the '\'
                i++;
            }

            // Add the final line (without continuation backslash)
            if (i < lines.length) {
                parts.push(lines[i]);
                i++;
            }

            // Join all parts into one logical line
            const joinedLine = parts.join(' ');
            result.push(joinedLine);

            // Add empty lines to preserve line numbers for subsequent lines
            const linesConsumed = i - startLine;
            for (let j = 1; j < linesConsumed; j++) {
                result.push('');
            }
        } else {
            result.push(line);
            i++;
        }
    }

    return result.join('\n');
}

/**
 * Process #define directives and conditional compilation in DCTL source
 *
 * @param source - DCTL source code (after #include expansion)
 * @param additionalMacros - Additional macro definitions
 * @returns Processed source and macro information
 */
export function processDefines(
    source: string,
    additionalMacros?: Record<string, string>
): DefineProcessResult {
    // Normalize line endings (CRLF -> LF)
    source = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Join multi-line macros (lines ending with \) into single logical lines
    // This must be done before any macro parsing
    source = joinContinuationLines(source);

    // First, strip out special DCTL macros that aren't C-compatible
    // This also extracts UI parameters before removing DEFINE_UI_PARAMS
    const stripResult = stripSpecialMacros(source);
    source = stripResult.source;
    const params = stripResult.params;

    const macros: MacroDefinition[] = [];
    const functionMacros: FunctionMacro[] = [];
    // Include warnings from UI param extraction
    const warnings: string[] = [...stripResult.warnings];
    const errors: ConditionalError[] = [];

    // Add UI param extraction errors as ConditionalError format
    for (const errMsg of stripResult.errors) {
        errors.push({
            message: errMsg,
            line: 1,  // UI param errors don't have specific line info from extractor
        });
    }
    const macroMap = new Map<string, string>();
    const functionMacroMap = new Map<string, FunctionMacro>();

    // Initialize with predefined and additional macros
    for (const [name, value] of Object.entries(DEFAULT_PREDEFINED_MACROS)) {
        macroMap.set(name, value);
    }
    if (additionalMacros) {
        for (const [name, value] of Object.entries(additionalMacros)) {
            macroMap.set(name, value);
        }
    }

    // First pass: collect all #define macros (for reference only - NOT passed to conditional processing)
    // processConditionals now tracks macros as it encounters them for proper #ifdef/#ifndef evaluation
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (isCommentedOut(line)) continue;

        // Check for function-like macro first
        const funcMatch = line.match(DEFINE_FUNCTION_PATTERN);
        if (funcMatch) {
            const [, name, paramsStr, body] = funcMatch;
            const params = paramsStr.split(',').map(p => p.trim()).filter(p => p);
            functionMacros.push({ name, params, body: body.trim(), line: i + 1 });
            functionMacroMap.set(name, { name, params, body: body.trim(), line: i + 1 });
            continue;
        }

        // Check for #define with value
        const defineMatch = line.match(DEFINE_PATTERN);
        if (defineMatch) {
            const [, name, value] = defineMatch;
            const cleanValue = removeTrailingComment(value).trim();
            macros.push({ name, value: cleanValue, line: i + 1 });
            // Don't add to macroMap here - let processConditionals track it dynamically
            continue;
        }

        // Check for #define without value (flag)
        const flagMatch = line.match(DEFINE_FLAG_PATTERN);
        if (flagMatch) {
            const name = flagMatch[1];
            macros.push({ name, value: '1', line: i + 1 });
            // Don't add to macroMap here - let processConditionals track it dynamically
            continue;
        }
    }

    // Process conditional compilation
    // Only pass predefined macros - user macros are tracked dynamically by processConditionals
    const conditionalResult = processConditionals(source, macroMap);
    errors.push(...conditionalResult.errors);
    warnings.push(...conditionalResult.warnings);

    // Clear user-defined macros from macroMap before second pass
    // This ensures macros are only applied to lines AFTER their definition
    // (Keep predefined and additional macros)
    const userDefinedMacroNames = macros.map(m => m.name);
    for (const name of userDefinedMacroNames) {
        macroMap.delete(name);
    }
    for (const fm of functionMacros) {
        functionMacroMap.delete(fm.name);
    }

    // Second pass: process #define/#undef and substitute macros in active code
    const conditionalLines = conditionalResult.source.split('\n');
    const outputLines: string[] = [];

    for (let i = 0; i < conditionalLines.length; i++) {
        const line = conditionalLines[i];
        const lineNum = i + 1;

        // Skip empty lines (from removed conditionals)
        if (line === '' && conditionalResult.removedLines.includes(lineNum)) {
            outputLines.push('');
            continue;
        }

        // Skip if inside a block comment (simple check)
        if (isCommentedOut(line)) {
            outputLines.push(line);
            continue;
        }

        // Check for function-like macro (process and remove the line)
        const funcMatch = line.match(DEFINE_FUNCTION_PATTERN);
        if (funcMatch) {
            const [, name, paramsStr, body] = funcMatch;
            const params = paramsStr.split(',').map(p => p.trim()).filter(p => p);
            functionMacroMap.set(name, { name, params, body: body.trim(), line: lineNum });
            outputLines.push('');
            continue;
        }

        // Check for #define with value (process and remove the line)
        const defineMatch = line.match(DEFINE_PATTERN);
        if (defineMatch) {
            const [, name, value] = defineMatch;
            const cleanValue = removeTrailingComment(value).trim();
            macroMap.set(name, cleanValue);
            outputLines.push('');
            continue;
        }

        // Check for #define without value (process and remove the line)
        const flagMatch = line.match(DEFINE_FLAG_PATTERN);
        if (flagMatch) {
            const name = flagMatch[1];
            macroMap.set(name, '1');
            outputLines.push('');
            continue;
        }

        // Check for #undef
        const undefMatch = line.match(UNDEF_PATTERN);
        if (undefMatch) {
            const name = undefMatch[1];
            macroMap.delete(name);
            functionMacroMap.delete(name);
            outputLines.push('');
            continue;
        }

        // Handle #pragma (remove but warn)
        if (PRAGMA_PATTERN.test(line)) {
            warnings.push(`Line ${lineNum}: #pragma directive ignored`);
            outputLines.push('');
            continue;
        }

        // Handle #error (generate error)
        if (ERROR_PATTERN.test(line)) {
            const msg = line.replace(/^\s*#\s*error\s*/, '').trim();
            errors.push({ line: lineNum, message: `#error: ${msg}` });
            outputLines.push('');
            continue;
        }

        // Handle #warning (generate warning)
        if (WARNING_PATTERN.test(line)) {
            const msg = line.replace(/^\s*#\s*warning\s*/, '').trim();
            warnings.push(`Line ${lineNum}: #warning: ${msg}`);
            outputLines.push('');
            continue;
        }

        // Handle #line (preserve for lexer to process)
        if (LINE_PATTERN.test(line)) {
            outputLines.push(line);
            continue;
        }

        // Handle #include (remove - expected to be expanded by DctlPreprocessor)
        // When processing without file system access, we just skip include lines
        if (/^\s*#\s*include/.test(line)) {
            // Keep as comment for debugging
            outputLines.push('// ' + line.trim());
            continue;
        }

        // Check for unknown preprocessor directive
        if (/^\s*#\s*[a-z]/i.test(line)) {
            // This shouldn't happen if conditionals were processed correctly
            warnings.push(`Line ${lineNum}: Unknown preprocessor directive: ${line.trim()}`);
            outputLines.push('// [unknown] ' + line.trim());
            continue;
        }

        // Regular line - substitute macros
        let processedLine = line;

        // First, expand function-like macros
        processedLine = expandFunctionMacros(processedLine, functionMacroMap);

        // Then, substitute object-like macros (iteratively until fully expanded)
        let prevLine = '';
        let macroIterations = 0;
        const maxMacroIterations = 100; // Prevent infinite recursion
        while (processedLine !== prevLine && macroIterations < maxMacroIterations) {
            prevLine = processedLine;
            macroIterations++;
            for (const [name, value] of macroMap) {
                // Only substitute whole word matches, avoiding function macro names
                if (!functionMacroMap.has(name)) {
                    processedLine = substituteObjectMacro(processedLine, name, value);
                }
            }
        }

        outputLines.push(processedLine);
    }

    // Generate UI parameter declarations AFTER macro expansion
    // This ensures that COMBO_BOX option names that are #defined don't get
    // their const declarations (since macros handle them), while option names
    // that are NOT #defined do get const declarations.
    const uiDeclarations = generateUIParamDeclarations(params, macroMap);
    let finalSource = outputLines.join('\n');
    let totalLineOffset = stripResult.lineOffset;

    if (uiDeclarations) {
        const uiDeclLineCount = uiDeclarations.split('\n').length;
        // Adjust #line directives to account for prepended lines
        // #line N should become #line (N + lineOffset) so that after the lexer
        // processes it, subsequent lines have correct original line numbers
        finalSource = finalSource.replace(
            /^(\s*#\s*line\s+)(\d+)/gm,
            (_match, prefix, num) => `${prefix}${parseInt(num, 10) + uiDeclLineCount + stripResult.lineOffset}`
        );
        finalSource = uiDeclarations + '\n' + finalSource;
        totalLineOffset += uiDeclLineCount;
    } else if (stripResult.lineOffset > 0) {
        // Adjust #line directives for LUT declarations even without UI declarations
        finalSource = finalSource.replace(
            /^(\s*#\s*line\s+)(\d+)/gm,
            (_match, prefix, num) => `${prefix}${parseInt(num, 10) + stripResult.lineOffset}`
        );
    }

    return {
        source: finalSource,
        macros,
        functionMacros,
        params,
        warnings,
        errors,
        lineOffset: totalLineOffset,
    };
}

/**
 * Type keywords used to detect variable declarations
 * When a macro name appears immediately after a type keyword, it's likely
 * a new variable declaration, not a macro reference.
 */
const TYPE_KEYWORDS = new Set([
    // Basic types
    'int', 'float', 'double', 'char', 'short', 'long', 'unsigned', 'signed',
    'void', 'bool', 'half', 'uint', 'ushort', 'uchar',
    // Vector types
    'float2', 'float3', 'float4',
    'int2', 'int3', 'int4',
    'half2', 'half3', 'half4',
    // Matrix types
    'mat2', 'mat3', 'mat4',
    'float2x2', 'float3x3', 'float4x4',
]);

/**
 * Check if a macro occurrence at a given position is in a variable declaration context.
 * Returns true if the macro name is being declared as a new variable (should NOT be replaced).
 *
 * Detects patterns like:
 * - `int k = 0` - variable declaration
 * - `for(int k = 0; ...)` - loop variable declaration
 * - `float k;` - uninitialized declaration
 * - `int k, j;` - multiple declarations
 *
 * @param line The line being processed
 * @param macroName The macro name to check
 * @param matchStart The start position of the macro match
 * @param matchEnd The end position of the macro match
 * @returns true if this is a variable declaration (don't replace)
 */
function isVariableDeclaration(
    line: string,
    macroName: string,
    matchStart: number,
    matchEnd: number
): boolean {
    // Look at what comes before the macro name
    const before = line.substring(0, matchStart);

    // Find the last word before the macro name (should be a type)
    // This handles: "int k", "for(int k", "float3 k", etc.
    const beforeMatch = before.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (!beforeMatch) {
        return false;
    }

    const precedingWord = beforeMatch[1];

    // Check if the preceding word is a type keyword
    if (!TYPE_KEYWORDS.has(precedingWord)) {
        return false;
    }

    // Look at what comes after the macro name
    const after = line.substring(matchEnd).trimStart();

    // If followed by =, ;, ,, [, or ), it's likely a declaration
    if (after.length === 0) {
        return true; // End of line after type + name
    }

    const firstCharAfter = after[0];
    if (firstCharAfter === '=' || firstCharAfter === ';' ||
        firstCharAfter === ',' || firstCharAfter === '[' ||
        firstCharAfter === ')') {
        return true;
    }

    return false;
}

/**
 * Substitute an object-like macro in a line, avoiding variable declaration contexts.
 *
 * In C preprocessor, `#define k 4.0f` would replace ALL occurrences of `k`,
 * including in `for(int k = 0; ...)` which breaks the code.
 * This function detects when `k` is being declared as a new variable
 * and avoids replacing it in those cases.
 *
 * @param line The line to process
 * @param name The macro name
 * @param value The macro value
 * @returns The line with macro substitutions applied (except in declaration contexts)
 */
function substituteObjectMacro(line: string, name: string, value: string): string {
    const pattern = new RegExp('\\b' + escapeRegex(name) + '\\b', 'g');
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(line)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + name.length;

        // Check if this occurrence is in a variable declaration context
        if (isVariableDeclaration(line, name, matchStart, matchEnd)) {
            // Keep the original (don't replace this occurrence)
            result += line.substring(lastIndex, matchEnd);
        } else {
            // Replace with macro value
            result += line.substring(lastIndex, matchStart) + value;
        }
        lastIndex = matchEnd;
    }

    result += line.substring(lastIndex);
    return result;
}

/**
 * Expand function-like macros in a line
 * Uses balanced parentheses matching to handle nested macro calls like MAX(MAX(a,b),c)
 */
function expandFunctionMacros(
    line: string,
    macros: Map<string, FunctionMacro>
): string {
    let result = line;
    let changed = true;
    let iterations = 0;
    const maxIterations = 100; // Prevent infinite loops

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        for (const [name, macro] of macros) {
            // Find macro invocation with balanced parentheses
            const namePattern = new RegExp('\\b' + escapeRegex(name) + '\\s*\\(', 'g');
            let match;

            // Reset lastIndex for each search
            namePattern.lastIndex = 0;

            while ((match = namePattern.exec(result)) !== null) {
                const startIndex = match.index;
                const openParenIndex = startIndex + match[0].length - 1;

                // Find matching closing paren
                let depth = 1;
                let endIndex = openParenIndex + 1;
                while (depth > 0 && endIndex < result.length) {
                    if (result[endIndex] === '(') {
                        depth++;
                    } else if (result[endIndex] === ')') {
                        depth--;
                    }
                    endIndex++;
                }

                if (depth !== 0) {
                    // Unbalanced parentheses, skip
                    continue;
                }

                // Extract arguments (content between parens)
                const argsStr = result.slice(openParenIndex + 1, endIndex - 1);
                const args = parseArguments(argsStr);

                if (args.length !== macro.params.length) {
                    // Argument count mismatch - skip this occurrence
                    continue;
                }

                // Substitute parameters in body
                let expanded = macro.body;
                for (let i = 0; i < macro.params.length; i++) {
                    const paramPattern = new RegExp(
                        '\\b' + escapeRegex(macro.params[i]) + '\\b',
                        'g'
                    );
                    expanded = expanded.replace(paramPattern, args[i]);
                }

                // Handle token pasting (##) - concatenate tokens by removing ## and surrounding whitespace
                expanded = expanded.replace(/\s*##\s*/g, '');

                // Replace the macro call with expanded body
                result = result.slice(0, startIndex) + expanded + result.slice(endIndex);
                changed = true;

                // Reset pattern to search from beginning since we modified the string
                namePattern.lastIndex = 0;
                break; // Restart the outer while loop
            }

            if (changed) {
                break; // Restart with all macros
            }
        }
    }

    return result;
}

/**
 * Parse comma-separated arguments, handling nested parentheses
 */
function parseArguments(argsStr: string): string[] {
    const args: string[] = [];
    let current = '';
    let depth = 0;

    for (const ch of argsStr) {
        if (ch === '(') {
            depth++;
            current += ch;
        } else if (ch === ')') {
            depth--;
            current += ch;
        } else if (ch === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim()) {
        args.push(current.trim());
    }

    return args;
}

/**
 * Check if a line is commented out (simple heuristic)
 */
function isCommentedOut(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/**
 * Remove trailing // comment from a line
 */
function removeTrailingComment(str: string): string {
    // Simple approach: find // that's not inside a string
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        if (inString) {
            if (ch === stringChar && str[i - 1] !== '\\') {
                inString = false;
            }
        } else {
            if (ch === '"' || ch === "'") {
                inString = true;
                stringChar = ch;
            } else if (ch === '/' && str[i + 1] === '/') {
                return str.substring(0, i);
            }
        }
    }

    return str;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
