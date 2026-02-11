/**
 * DCTL Validator Service
 *
 * Validates DCTL code using the Rust compiler's built-in validation.
 * Supports file-based validation with #include expansion.
 *
 * Pipeline:
 * 1. Preprocess (handle #include, #define, #ifdef, etc.)
 * 2. Validate with Rust compiler (returns diagnostics)
 * 3. Map error positions back to original source (for #include files)
 */

import { DctlCompiler, getDctlCompiler, isCompileError } from '../compiler';
import type { SourceMap as PreprocessorSourceMap } from '../preprocessor/types';
import { processDefines } from '../preprocessor/defineProcessor';
import { DctlPreprocessor } from '../preprocessor/preprocessor';
import type { DctlParam } from '@dctl-workbench/core';

/**
 * Validation result for a single error
 */
export interface DctlValidationError {
    /** Error message */
    message: string;
    /** Line number in DCTL source (1-based) */
    line: number;
    /** Column number in DCTL source (1-based, optional) */
    column?: number;
    /** Original file path (for #include files) */
    file?: string;
    /** Error type/kind */
    kind?: string;
    /** Identifier causing the error */
    identifier?: string;
    /** Severity: 'error' or 'warning' */
    severity: 'error' | 'warning';
}

/**
 * Full validation result
 */
export interface DctlValidationResult {
    /** Whether validation passed */
    success: boolean;
    /** List of errors found */
    errors: DctlValidationError[];
    /** List of warnings */
    warnings: DctlValidationError[];
}

/**
 * DCTL Validator
 *
 * Validates DCTL code using the Rust compiler's validation.
 */
export class DctlValidator {
    private compiler: DctlCompiler;
    private initialized: boolean = false;

    constructor() {
        this.compiler = getDctlCompiler();
    }

    /**
     * Initialize the validator
     * @param extensionPath Path to the extension directory
     */
    async init(extensionPath: string): Promise<void> {
        if (this.initialized) {
            return;
        }

        await this.compiler.init(extensionPath);
        this.initialized = true;
    }

    /**
     * Check if validator is initialized
     */
    get isInitialized(): boolean {
        return this.initialized && this.compiler.isInitialized;
    }

    /**
     * Validate DCTL source code
     *
     * @param source DCTL source code
     * @param preprocessorSourceMap Optional source map from preprocessor (for #include files)
     * @param skipDefineProcessing If true, skip processDefines (source already preprocessed)
     * @param externalLineOffset Line offset from external preprocessor (used when skipDefineProcessing is true)
     * @param params Optional UI parameters extracted from preprocessor (required when skipDefineProcessing is true)
     * @returns Validation result with errors mapped to DCTL positions
     */
    validate(
        source: string,
        preprocessorSourceMap?: PreprocessorSourceMap,
        skipDefineProcessing: boolean = false,
        externalLineOffset: number = 0,
        params?: DctlParam[]
    ): DctlValidationResult {
        if (!this.isInitialized) {
            return {
                success: false,
                errors: [{
                    message: 'Validator not initialized',
                    line: 1,
                    severity: 'error',
                }],
                warnings: [],
            };
        }

        const errors: DctlValidationError[] = [];
        const warnings: DctlValidationError[] = [];

        // Step 0: Preprocess (#define, #ifdef, etc.) - skip if already done
        let processedSource = source;
        let lineOffset = externalLineOffset;

        if (!skipDefineProcessing) {
            // First, handle backslash line continuation (C preprocessor feature)
            processedSource = this.joinContinuationLines(processedSource);

            const preprocessResult = processDefines(processedSource);
            processedSource = preprocessResult.source;
            lineOffset = preprocessResult.lineOffset;

            // Add preprocessor errors
            for (const err of preprocessResult.errors) {
                errors.push({
                    message: err.message,
                    line: err.line,
                    severity: 'error',
                });
            }

            // Add preprocessor warnings
            for (const warn of preprocessResult.warnings) {
                warnings.push({
                    message: warn,
                    line: 1,
                    severity: 'warning',
                });
            }

            // If there are preprocessor errors, return early
            if (preprocessResult.errors.length > 0) {
                return {
                    success: false,
                    errors,
                    warnings,
                };
            }
        }

        // Step 1: Compile with Rust compiler to get diagnostics
        // The compiler performs full validation including semantic analysis
        const result = this.compiler.compile(processedSource);

        if (isCompileError(result)) {
            // Parse error message for line info if available
            const lineMatch = result.message.match(/line\s*(\d+)/i);
            const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

            const mapped = this.mapLineToOriginal(line, lineOffset, preprocessorSourceMap);
            errors.push({
                message: result.message,
                line: mapped.line,
                file: mapped.file,
                severity: 'error',
            });
        } else {
            // Process diagnostics from successful compilation
            for (const diag of result.diagnostics) {
                const mapped = this.mapLineToOriginal(diag.line, lineOffset, preprocessorSourceMap);
                const error: DctlValidationError = {
                    message: diag.message,
                    line: mapped.line,
                    column: diag.column,
                    file: mapped.file,
                    severity: diag.severity === 'error' ? 'error' : 'warning',
                };

                if (diag.severity === 'error') {
                    errors.push(error);
                } else {
                    warnings.push(error);
                }
            }
        }

        return {
            success: errors.length === 0,
            errors,
            warnings,
        };
    }

    /**
     * Validate a DCTL file with full #include expansion
     *
     * This method reads the file, expands all #include directives,
     * and validates the fully preprocessed source.
     *
     * @param filePath Path to the DCTL file
     * @returns Validation result with errors mapped to original file positions
     */
    async validateFile(filePath: string): Promise<DctlValidationResult> {
        if (!this.isInitialized) {
            return {
                success: false,
                errors: [{
                    message: 'Validator not initialized',
                    line: 1,
                    severity: 'error',
                }],
                warnings: [],
            };
        }

        const errors: DctlValidationError[] = [];
        const warnings: DctlValidationError[] = [];

        // Use full preprocessor with #include expansion
        const preprocessor = new DctlPreprocessor();
        const preprocessResult = await preprocessor.preprocess(filePath);

        // Add preprocessor errors
        for (const err of preprocessResult.errors) {
            errors.push({
                message: err.message,
                line: err.line,
                file: err.file,
                severity: 'error',
            });
        }

        // Add preprocessor warnings
        for (const warn of preprocessResult.warnings) {
            warnings.push({
                message: warn.message,
                line: warn.line,
                file: warn.file,
                severity: 'warning',
            });
        }

        // If preprocessor failed, return early
        if (!preprocessResult.success) {
            return {
                success: false,
                errors,
                warnings,
            };
        }

        // Validate the preprocessed source with source map for error mapping
        const result = this.validate(
            preprocessResult.expandedSource,
            preprocessResult.sourceMap,
            true, // Skip define processing (already done by preprocessor)
            preprocessResult.lineOffset,
            preprocessResult.params
        );

        // Merge errors and warnings
        return {
            success: result.success && errors.length === 0,
            errors: [...errors, ...result.errors],
            warnings: [...warnings, ...result.warnings],
        };
    }

    /**
     * Map a post-processDefines line number to original file/line
     *
     * @param postProcessLine Line number in post-processDefines source
     * @param lineOffset Lines added by processDefines at the beginning
     * @param preprocessorSourceMap Source map from preprocessor (maps expanded lines to original files)
     * @returns Original file and line number
     */
    private mapLineToOriginal(
        postProcessLine: number,
        lineOffset: number,
        preprocessorSourceMap?: PreprocessorSourceMap
    ): { line: number; file?: string } {
        // Step 1: Adjust for lineOffset to get pre-processDefines line number
        const preProcessLine = Math.max(1, postProcessLine - lineOffset);

        // Step 2: If we have a preprocessor source map, use it to get original file/line
        if (preprocessorSourceMap) {
            const original = preprocessorSourceMap.getOriginalPosition(preProcessLine);
            if (original) {
                return { line: original.line, file: original.file };
            }
        }

        // No source map or mapping not found - return the adjusted line
        return { line: preProcessLine };
    }

    /**
     * Join lines that end with backslash (line continuation)
     * This is a C preprocessor feature used for multi-line macros
     */
    private joinContinuationLines(source: string): string {
        const lines = source.split('\n');
        const result: string[] = [];
        let currentLine = '';

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Handle CRLF endings - remove trailing CR
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }

            // Check if line ends with backslash (line continuation)
            // Also handle backslash followed by optional whitespace
            const trimmedEnd = line.trimEnd();
            if (trimmedEnd.endsWith('\\')) {
                // Remove the backslash and join with next line
                currentLine += trimmedEnd.slice(0, -1);
            } else {
                // No continuation, flush current line
                result.push(currentLine + line);
                currentLine = '';
            }
        }

        // Handle any remaining content
        if (currentLine) {
            result.push(currentLine);
        }

        return result.join('\n');
    }
}

// Singleton instance
let validatorInstance: DctlValidator | null = null;

/**
 * Get the singleton DctlValidator instance
 */
export function getDctlValidator(): DctlValidator {
    if (!validatorInstance) {
        validatorInstance = new DctlValidator();
    }
    return validatorInstance;
}
