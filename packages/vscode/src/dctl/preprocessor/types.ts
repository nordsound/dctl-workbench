/**
 * DCTL Preprocessor Type Definitions
 *
 * Types for handling #include directives in DCTL files.
 * Based on official DCTL specification: double-quote includes with relative paths only.
 */

import type { DctlParam } from '@dctl-workbench/core';

// =============================================================================
// Include Directive
// =============================================================================

/**
 * Parsed #include directive
 */
export interface IncludeDirective {
    /** Line number in source file (1-based) */
    line: number;
    /** Column number in source file (1-based) */
    column: number;
    /** Include path (content inside quotes) */
    path: string;
    /** Original directive string */
    raw: string;
}

// =============================================================================
// Source Map
// =============================================================================

/**
 * Maps expanded source line to original file location
 */
export interface SourceMapEntry {
    /** Line number in expanded source (1-based) */
    generatedLine: number;
    /** Original file path */
    originalFile: string;
    /** Line number in original file (1-based) */
    originalLine: number;
}

/**
 * Source map for tracking original locations after include expansion
 */
export interface SourceMap {
    /**
     * Get all source map entries
     */
    getEntries(): SourceMapEntry[];

    /**
     * Get original location for a generated line
     */
    getOriginalPosition(generatedLine: number): {
        file: string;
        line: number;
    } | null;
}

// =============================================================================
// Preprocess Result
// =============================================================================

/**
 * Warning during preprocessing
 */
export interface PreprocessWarning {
    /** File where warning occurred */
    file: string;
    /** Line number (1-based) */
    line: number;
    /** Warning message */
    message: string;
    /** Warning code */
    code: 'DCTL017' | 'DCTL018';
}

/**
 * Error during preprocessing
 */
export interface PreprocessError {
    /** File where error occurred */
    file: string;
    /** Line number (1-based) */
    line: number;
    /** Column number (1-based) */
    column: number;
    /** Error message */
    message: string;
    /** Error code */
    code: 'DCTL014' | 'DCTL015' | 'DCTL016';
}

/**
 * Function-like macro definition (e.g., #define MACRO(args) body)
 */
export interface FunctionMacroInfo {
    /** Macro name */
    name: string;
    /** Parameter names */
    params: string[];
}

/**
 * Result of preprocessing a DCTL file
 */
export interface PreprocessResult {
    /** Expanded source code with all includes inlined */
    expandedSource: string;

    /** Source map for error location mapping */
    sourceMap: SourceMap;

    /** List of all included files (absolute paths) */
    includedFiles: string[];

    /** Extracted UI parameters from DEFINE_UI_PARAMS macros */
    params: DctlParam[];

    /** Function-like macros (e.g., #define DMINQ(id) ...) */
    functionMacros: FunctionMacroInfo[];

    /** Warnings during preprocessing */
    warnings: PreprocessWarning[];

    /** Errors during preprocessing */
    errors: PreprocessError[];

    /** Whether preprocessing was successful (no errors) */
    success: boolean;

    /** Number of lines added at the beginning by processDefines (for line number adjustment) */
    lineOffset: number;
}

// =============================================================================
// Preprocessor Options
// =============================================================================

/**
 * Options for the DCTL preprocessor
 */
export interface PreprocessOptions {
    /** Maximum include nesting depth (default: 32) */
    maxIncludeDepth?: number;

    /** Enable file caching (default: true) */
    enableCache?: boolean;
}

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Preprocessor error code definitions
 */
export const PREPROCESS_ERROR_CODES = {
    DCTL014: {
        code: 'DCTL014',
        message: 'Include file not found',
        severity: 'error',
    },
    DCTL015: {
        code: 'DCTL015',
        message: 'Circular include detected',
        severity: 'error',
    },
    DCTL016: {
        code: 'DCTL016',
        message: 'Invalid include directive syntax',
        severity: 'error',
    },
    DCTL017: {
        code: 'DCTL017',
        message: 'Angle bracket includes are not supported',
        severity: 'warning',
    },
    DCTL019: {
        code: 'DCTL019',
        message: 'Double #else in conditional block',
        severity: 'error',
    },
    DCTL020: {
        code: 'DCTL020',
        message: '#elif cannot appear after #else',
        severity: 'error',
    },
} as const;

export type PreprocessErrorCode = keyof typeof PREPROCESS_ERROR_CODES;
