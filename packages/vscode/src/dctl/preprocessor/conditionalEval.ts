/**
 * DCTL Conditional Compilation Evaluator
 *
 * Handles #ifdef, #ifndef, #if, #else, #elif, #endif directives.
 *
 * Supported syntax:
 * - #ifdef MACRO       - true if MACRO is defined
 * - #ifndef MACRO      - true if MACRO is NOT defined
 * - #if EXPR           - true if EXPR evaluates to non-zero
 * - #elif EXPR         - else-if branch
 * - #else              - else branch
 * - #endif             - end conditional block
 *
 * Supported expressions in #if/#elif:
 * - Numeric literals: 0, 1, 42
 * - Defined check: defined(MACRO), defined MACRO
 * - Logical operators: &&, ||, !
 * - Comparison: ==, !=, <, >, <=, >=
 * - Parentheses: (expr)
 * - Macro references (evaluated to their value or 0 if undefined)
 */

export interface ConditionalProcessResult {
    /** Processed source with conditional blocks evaluated */
    source: string;
    /** Lines that were removed/commented out */
    removedLines: number[];
    /** Errors encountered */
    errors: ConditionalError[];
    /** Warnings */
    warnings: string[];
}

export interface ConditionalError {
    line: number;
    message: string;
}

interface ConditionalState {
    /** Whether this block's condition is true */
    active: boolean;
    /** Whether any branch in this #if/#elif/#else chain has been true */
    hadTrueBranch: boolean;
    /** Line number where this block started */
    startLine: number;
    /** Whether #else has been seen in this block */
    hasElse: boolean;
    /** Line number where #else appeared (for error messages) */
    elseLineNumber?: number;
}

/**
 * Default predefined macros for WebGPU/Web environment
 */
export const DEFAULT_PREDEFINED_MACROS: Record<string, string> = {
    // Device type flags - all false since we're in WebGPU
    'DEVICE_IS_CUDA': '0',
    'DEVICE_IS_OPENCL': '0',
    'DEVICE_IS_METAL': '0',
    // Version info - simulate Resolve 18.0
    '__RESOLVE_VER_MAJOR__': '18',
    '__RESOLVE_VER_MINOR__': '0',
};

/**
 * Process conditional compilation directives
 *
 * @param source - Source code (after #include expansion)
 * @param definedMacros - Map of defined macros and their values
 * @param predefinedMacros - Predefined macros (defaults to DEFAULT_PREDEFINED_MACROS)
 * @returns Processed source with conditionals evaluated
 */
export function processConditionals(
    source: string,
    definedMacros: Map<string, string> = new Map(),
    predefinedMacros: Record<string, string> = DEFAULT_PREDEFINED_MACROS
): ConditionalProcessResult {
    const lines = source.split('\n');
    const outputLines: string[] = [];
    const removedLines: number[] = [];
    const errors: ConditionalError[] = [];
    const warnings: string[] = [];

    // Merge predefined macros with user-defined ones
    const allMacros = new Map<string, string>(
        Object.entries(predefinedMacros)
    );
    for (const [key, value] of definedMacros) {
        allMacros.set(key, value);
    }

    // Stack of conditional states
    const conditionalStack: ConditionalState[] = [];

    // Check if current output is active (all enclosing conditions are true)
    const isOutputActive = (): boolean => {
        return conditionalStack.every(state => state.active);
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        const trimmed = line.trim();

        // Handle #ifdef
        if (trimmed.startsWith('#ifdef ') || trimmed.match(/^#\s*ifdef\s+/)) {
            const match = trimmed.match(/^#\s*ifdef\s+(\w+)/);
            if (!match) {
                errors.push({ line: lineNum, message: 'Invalid #ifdef syntax' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const macroName = match[1];
            const isDefined = allMacros.has(macroName);
            const parentActive = conditionalStack.length === 0 || isOutputActive();
            const thisActive = parentActive && isDefined;

            conditionalStack.push({
                active: thisActive,
                hadTrueBranch: thisActive,
                startLine: lineNum,
                hasElse: false,
            });

            outputLines.push(''); // Remove directive, preserve line number
            continue;
        }

        // Handle #ifndef
        if (trimmed.startsWith('#ifndef ') || trimmed.match(/^#\s*ifndef\s+/)) {
            const match = trimmed.match(/^#\s*ifndef\s+(\w+)/);
            if (!match) {
                errors.push({ line: lineNum, message: 'Invalid #ifndef syntax' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const macroName = match[1];
            const isDefined = allMacros.has(macroName);
            const parentActive = conditionalStack.length === 0 || isOutputActive();
            const thisActive = parentActive && !isDefined;

            conditionalStack.push({
                active: thisActive,
                hadTrueBranch: thisActive,
                startLine: lineNum,
                hasElse: false,
            });

            outputLines.push('');
            continue;
        }

        // Handle #if
        if (trimmed.startsWith('#if ') || trimmed.match(/^#\s*if\s+/)) {
            const match = trimmed.match(/^#\s*if\s+(.+)$/);
            if (!match) {
                errors.push({ line: lineNum, message: 'Invalid #if syntax' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const expr = match[1].trim();
            const parentActive = conditionalStack.length === 0 || isOutputActive();
            let conditionResult = false;

            if (parentActive) {
                try {
                    conditionResult = evaluateExpression(expr, allMacros);
                } catch (e) {
                    errors.push({
                        line: lineNum,
                        message: `Error evaluating #if expression: ${e instanceof Error ? e.message : String(e)}`,
                    });
                }
            }

            const thisActive = parentActive && conditionResult;
            conditionalStack.push({
                active: thisActive,
                hadTrueBranch: thisActive,
                startLine: lineNum,
                hasElse: false,
            });

            outputLines.push('');
            continue;
        }

        // Handle #elif
        if (trimmed.startsWith('#elif ') || trimmed.match(/^#\s*elif\s+/)) {
            if (conditionalStack.length === 0) {
                errors.push({ line: lineNum, message: '#elif without matching #if' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const match = trimmed.match(/^#\s*elif\s+(.+)$/);
            if (!match) {
                errors.push({ line: lineNum, message: 'Invalid #elif syntax' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const state = conditionalStack[conditionalStack.length - 1];

            // Check for #elif after #else (DCTL020)
            if (state.hasElse) {
                errors.push({
                    line: lineNum,
                    message: `#elif cannot appear after #else (previous #else at line ${state.elseLineNumber})`,
                });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const expr = match[1].trim();

            // Check if parent is active
            const parentActive =
                conditionalStack.length === 1 ||
                conditionalStack.slice(0, -1).every(s => s.active);

            // #elif is active if: parent is active, no previous branch was true, and this condition is true
            let conditionResult = false;
            if (parentActive && !state.hadTrueBranch) {
                try {
                    conditionResult = evaluateExpression(expr, allMacros);
                } catch (e) {
                    errors.push({
                        line: lineNum,
                        message: `Error evaluating #elif expression: ${e instanceof Error ? e.message : String(e)}`,
                    });
                }
            }

            state.active = parentActive && !state.hadTrueBranch && conditionResult;
            if (state.active) {
                state.hadTrueBranch = true;
            }

            outputLines.push('');
            continue;
        }

        // Handle #else
        if (trimmed === '#else' || trimmed.match(/^#\s*else\s*$/)) {
            if (conditionalStack.length === 0) {
                errors.push({ line: lineNum, message: '#else without matching #if' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            const state = conditionalStack[conditionalStack.length - 1];

            // Check for double #else (DCTL019)
            if (state.hasElse) {
                errors.push({
                    line: lineNum,
                    message: `Double #else in conditional block (first #else at line ${state.elseLineNumber})`,
                });
                outputLines.push('// [error] ' + line);
                continue;
            }

            // Mark that #else has been seen
            state.hasElse = true;
            state.elseLineNumber = lineNum;

            // Check if parent is active
            const parentActive =
                conditionalStack.length === 1 ||
                conditionalStack.slice(0, -1).every(s => s.active);

            // #else is active if parent is active and no previous branch was true
            state.active = parentActive && !state.hadTrueBranch;
            if (state.active) {
                state.hadTrueBranch = true;
            }

            outputLines.push('');
            continue;
        }

        // Handle #endif
        if (trimmed === '#endif' || trimmed.match(/^#\s*endif\s*$/)) {
            if (conditionalStack.length === 0) {
                errors.push({ line: lineNum, message: '#endif without matching #if' });
                outputLines.push('// [error] ' + line);
                continue;
            }

            conditionalStack.pop();
            outputLines.push('');
            continue;
        }

        // Regular line - include if active
        if (isOutputActive()) {
            outputLines.push(line);

            // Track #define directives as they're encountered (for proper #ifdef/#ifndef evaluation)
            // This ensures macros are only considered "defined" AFTER their definition line
            const defineMatch = trimmed.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/);
            if (defineMatch) {
                const macroName = defineMatch[1];
                const macroValue = defineMatch[2]?.trim() || '1';
                allMacros.set(macroName, macroValue);
            }

            // Track #undef directives
            const undefMatch = trimmed.match(/^#\s*undef\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (undefMatch) {
                allMacros.delete(undefMatch[1]);
            }
        } else {
            outputLines.push(''); // Preserve line number
            removedLines.push(lineNum);
        }
    }

    // Check for unclosed conditionals
    if (conditionalStack.length > 0) {
        for (const state of conditionalStack) {
            errors.push({
                line: state.startLine,
                message: 'Unterminated conditional block',
            });
        }
    }

    return {
        source: outputLines.join('\n'),
        removedLines,
        errors,
        warnings,
    };
}

/**
 * Evaluate a preprocessor expression
 *
 * Supports:
 * - Numeric literals
 * - defined(MACRO) or defined MACRO
 * - Logical operators: &&, ||, !
 * - Comparison: ==, !=, <, >, <=, >=
 * - Arithmetic: +, -, *, /
 * - Parentheses
 * - Macro references (evaluated to their value or 0 if undefined)
 */
function evaluateExpression(expr: string, macros: Map<string, string>): boolean {
    // Tokenize and evaluate
    const result = evalExpr(expr, macros);
    return result !== 0;
}

/**
 * Simple recursive descent parser for preprocessor expressions
 */
function evalExpr(expr: string, macros: Map<string, string>): number {
    let pos = 0;

    const skipWhitespace = () => {
        while (pos < expr.length && /\s/.test(expr[pos])) pos++;
    };

    const peek = (): string => {
        skipWhitespace();
        return expr[pos] || '';
    };

    const consume = (expected?: string): string => {
        skipWhitespace();
        if (expected && !expr.startsWith(expected, pos)) {
            throw new Error(`Expected '${expected}' at position ${pos}`);
        }
        const ch = expr[pos];
        pos++;
        return ch;
    };

    const consumeWord = (): string => {
        skipWhitespace();
        let word = '';
        while (pos < expr.length && /[A-Za-z0-9_]/.test(expr[pos])) {
            word += expr[pos++];
        }
        return word;
    };

    const consumeNumber = (): number => {
        skipWhitespace();
        let numStr = '';
        // Handle hex
        if (expr.startsWith('0x', pos) || expr.startsWith('0X', pos)) {
            numStr = '0x';
            pos += 2;
            while (pos < expr.length && /[0-9a-fA-F]/.test(expr[pos])) {
                numStr += expr[pos++];
            }
            return parseInt(numStr, 16);
        }
        // Decimal
        while (pos < expr.length && /[0-9]/.test(expr[pos])) {
            numStr += expr[pos++];
        }
        return parseInt(numStr, 10);
    };

    // Parse logical OR: expr || expr
    const parseOr = (): number => {
        let left = parseAnd();
        while (pos < expr.length) {
            skipWhitespace();
            if (expr.startsWith('||', pos)) {
                pos += 2;
                const right = parseAnd();
                left = (left || right) ? 1 : 0;
            } else {
                break;
            }
        }
        return left;
    };

    // Parse logical AND: expr && expr
    const parseAnd = (): number => {
        let left = parseEquality();
        while (pos < expr.length) {
            skipWhitespace();
            if (expr.startsWith('&&', pos)) {
                pos += 2;
                const right = parseEquality();
                left = (left && right) ? 1 : 0;
            } else {
                break;
            }
        }
        return left;
    };

    // Parse equality: expr == expr, expr != expr
    const parseEquality = (): number => {
        let left = parseComparison();
        while (pos < expr.length) {
            skipWhitespace();
            if (expr.startsWith('==', pos)) {
                pos += 2;
                const right = parseComparison();
                left = (left === right) ? 1 : 0;
            } else if (expr.startsWith('!=', pos)) {
                pos += 2;
                const right = parseComparison();
                left = (left !== right) ? 1 : 0;
            } else {
                break;
            }
        }
        return left;
    };

    // Parse comparison: expr < expr, expr > expr, etc.
    const parseComparison = (): number => {
        let left = parseAdditive();
        while (pos < expr.length) {
            skipWhitespace();
            if (expr.startsWith('<=', pos)) {
                pos += 2;
                const right = parseAdditive();
                left = (left <= right) ? 1 : 0;
            } else if (expr.startsWith('>=', pos)) {
                pos += 2;
                const right = parseAdditive();
                left = (left >= right) ? 1 : 0;
            } else if (expr[pos] === '<') {
                pos++;
                const right = parseAdditive();
                left = (left < right) ? 1 : 0;
            } else if (expr[pos] === '>') {
                pos++;
                const right = parseAdditive();
                left = (left > right) ? 1 : 0;
            } else {
                break;
            }
        }
        return left;
    };

    // Parse additive: expr + expr, expr - expr
    const parseAdditive = (): number => {
        let left = parseMultiplicative();
        while (pos < expr.length) {
            skipWhitespace();
            if (expr[pos] === '+') {
                pos++;
                const right = parseMultiplicative();
                left = left + right;
            } else if (expr[pos] === '-') {
                pos++;
                const right = parseMultiplicative();
                left = left - right;
            } else {
                break;
            }
        }
        return left;
    };

    // Parse multiplicative: expr * expr, expr / expr
    const parseMultiplicative = (): number => {
        let left = parseUnary();
        while (pos < expr.length) {
            skipWhitespace();
            if (expr[pos] === '*') {
                pos++;
                const right = parseUnary();
                left = left * right;
            } else if (expr[pos] === '/') {
                pos++;
                const right = parseUnary();
                left = right !== 0 ? Math.floor(left / right) : 0;
            } else if (expr[pos] === '%') {
                pos++;
                const right = parseUnary();
                left = right !== 0 ? left % right : 0;
            } else {
                break;
            }
        }
        return left;
    };

    // Parse unary: !expr, -expr, +expr
    const parseUnary = (): number => {
        skipWhitespace();
        if (expr[pos] === '!') {
            pos++;
            const operand = parseUnary();
            return operand ? 0 : 1;
        }
        if (expr[pos] === '-') {
            pos++;
            return -parseUnary();
        }
        if (expr[pos] === '+') {
            pos++;
            return parseUnary();
        }
        return parsePrimary();
    };

    // Parse primary: number, (expr), defined(...), identifier
    const parsePrimary = (): number => {
        skipWhitespace();

        // Parentheses
        if (expr[pos] === '(') {
            pos++;
            const result = parseOr();
            skipWhitespace();
            if (expr[pos] === ')') pos++;
            return result;
        }

        // Number
        if (/[0-9]/.test(expr[pos])) {
            return consumeNumber();
        }

        // defined(MACRO) or defined MACRO
        if (expr.startsWith('defined', pos)) {
            pos += 7;
            skipWhitespace();
            let macroName: string;
            if (expr[pos] === '(') {
                pos++;
                macroName = consumeWord();
                skipWhitespace();
                if (expr[pos] === ')') pos++;
            } else {
                macroName = consumeWord();
            }
            return macros.has(macroName) ? 1 : 0;
        }

        // Identifier (macro reference)
        if (/[A-Za-z_]/.test(expr[pos])) {
            const name = consumeWord();
            const value = macros.get(name);
            if (value !== undefined) {
                // Try to parse as number
                const num = parseInt(value, 10);
                return isNaN(num) ? (value ? 1 : 0) : num;
            }
            // Undefined macro evaluates to 0
            return 0;
        }

        throw new Error(`Unexpected character '${expr[pos]}' at position ${pos}`);
    };

    return parseOr();
}
