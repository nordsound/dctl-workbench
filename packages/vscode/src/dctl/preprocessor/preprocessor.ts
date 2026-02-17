/**
 * DCTL Preprocessor
 *
 * Main preprocessor that handles #include directive expansion.
 * Integrates directive parsing, path resolution, circular detection,
 * and source map generation.
 */

import * as path from 'path';
import {
    PreprocessResult,
    PreprocessError,
    PreprocessWarning,
    SourceMap,
    PreprocessOptions,
    PREPROCESS_ERROR_CODES,
} from './types';
import { parseIncludeDirectives } from './directiveParser';
import {
    IncludePathResolver,
    FileSystem,
    NodeFileSystem,
} from './pathResolver';
import {
    CircularIncludeDetector,
    CircularIncludeError,
} from './circularDetector';
import { SourceMapBuilder, createSingleFileSourceMap } from './sourceMap';
import { processDefines } from './defineProcessor';

/**
 * Default preprocessor options
 */
const DEFAULT_OPTIONS: Required<PreprocessOptions> = {
    maxIncludeDepth: 32,
    enableCache: true,
};

/**
 * DCTL Preprocessor
 *
 * Processes DCTL source files, expanding #include directives and
 * generating source maps for error reporting.
 */
export class DctlPreprocessor {
    private pathResolver: IncludePathResolver;
    private circularDetector: CircularIncludeDetector;
    private options: Required<PreprocessOptions>;

    constructor(fileSystem?: FileSystem, options?: PreprocessOptions) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.pathResolver = new IncludePathResolver(
            fileSystem ?? new NodeFileSystem(),
            this.options.enableCache
        );
        this.circularDetector = new CircularIncludeDetector(
            this.options.maxIncludeDepth
        );
    }

    /**
     * Preprocess a DCTL file
     *
     * @param filePath - Path to the main DCTL file
     * @returns Preprocessing result with expanded source and source map
     */
    async preprocess(filePath: string): Promise<PreprocessResult> {
        const normalizedPath = path.resolve(filePath);

        // Check if file exists
        if (!this.pathResolver.exists(normalizedPath)) {
            return this.createErrorResult(
                `File not found: ${filePath}`,
                filePath,
                1,
                'DCTL014'
            );
        }

        // Read the file
        const result = this.pathResolver.resolveAndRead(
            path.basename(normalizedPath),
            normalizedPath
        );

        if (!result) {
            return this.createErrorResult(
                `Failed to read file: ${filePath}`,
                filePath,
                1,
                'DCTL014'
            );
        }

        return this.preprocessSource(result.content, normalizedPath);
    }

    /**
     * Preprocess DCTL source code
     *
     * @param source - DCTL source code
     * @param virtualPath - Virtual file path for this source (for path resolution)
     * @returns Preprocessing result
     */
    async preprocessSource(
        source: string,
        virtualPath: string
    ): Promise<PreprocessResult> {
        const normalizedPath = path.resolve(virtualPath);
        const errors: PreprocessError[] = [];
        const warnings: PreprocessWarning[] = [];
        const includedFiles: string[] = [];
        const sourceMapBuilder = new SourceMapBuilder();

        // Reset detector for new preprocessing session
        this.circularDetector.reset();

        // Join lines that end with backslash (line continuation)
        source = this.joinContinuationLines(source);

        try {
            const expandedLines = await this.expandSource(
                source,
                normalizedPath,
                errors,
                warnings,
                includedFiles,
                sourceMapBuilder
            );

            const includeExpandedSource = expandedLines.join('\n');
            const sourceMap = sourceMapBuilder.build();

            // Process #define directives
            const defineResult = processDefines(includeExpandedSource);
            warnings.push(
                ...defineResult.warnings.map(w => ({
                    file: normalizedPath,
                    line: 1,
                    message: w,
                    code: 'DCTL018' as const,
                }))
            );

            return {
                expandedSource: defineResult.source,
                includeExpandedSource,
                sourceMap,
                includedFiles,
                params: defineResult.params,
                functionMacros: defineResult.functionMacros.map(m => ({ name: m.name, params: m.params })),
                warnings,
                errors,
                success: errors.length === 0,
                lineOffset: defineResult.lineOffset,
            };
        } catch (error) {
            if (error instanceof CircularIncludeError) {
                errors.push({
                    file: error.file,
                    line: 1,
                    column: 1,
                    message: error.message,
                    code: 'DCTL015',
                });
            } else {
                errors.push({
                    file: normalizedPath,
                    line: 1,
                    column: 1,
                    message: error instanceof Error ? error.message : String(error),
                    code: 'DCTL016',
                });
            }

            // Return partial result with single-file source map
            const lines = source.split('\n');
            return {
                expandedSource: source,
                includeExpandedSource: source,
                sourceMap: createSingleFileSourceMap(normalizedPath, lines.length),
                includedFiles,
                params: [],
                functionMacros: [],
                warnings,
                errors,
                success: false,
                lineOffset: 0,
            };
        }
    }

    /**
     * Expand source code by processing #include directives recursively
     */
    private async expandSource(
        source: string,
        filePath: string,
        errors: PreprocessError[],
        warnings: PreprocessWarning[],
        includedFiles: string[],
        sourceMapBuilder: SourceMapBuilder
    ): Promise<string[]> {
        return this.circularDetector.withFileAsync(filePath, async () => {
            const lines = source.split('\n');
            const expandedLines: string[] = [];

            // Parse include directives
            const { directives, warnings: parseWarnings } = parseIncludeDirectives(
                source,
                filePath
            );
            warnings.push(...parseWarnings);

            // Create a map of line numbers to directives for quick lookup
            const directivesByLine = new Map(
                directives.map(d => [d.line, d])
            );

            for (let i = 0; i < lines.length; i++) {
                const lineNumber = i + 1;
                const directive = directivesByLine.get(lineNumber);

                if (directive) {
                    // This line has an #include directive
                    const resolved = this.pathResolver.resolve(
                        directive.path,
                        filePath
                    );

                    if (!resolved.found || !resolved.resolvedPath) {
                        // Include file not found
                        errors.push({
                            file: filePath,
                            line: lineNumber,
                            column: directive.column,
                            message: `Include file not found: "${directive.path}"`,
                            code: 'DCTL014',
                        });
                        // Keep the original line as a comment for debugging
                        expandedLines.push(`// ERROR: ${lines[i]}`);
                        sourceMapBuilder.addLine(filePath, lineNumber);
                        continue;
                    }

                    // Read and expand the included file
                    const includeResult = this.pathResolver.resolveAndRead(
                        directive.path,
                        filePath
                    );

                    if (!includeResult) {
                        errors.push({
                            file: filePath,
                            line: lineNumber,
                            column: directive.column,
                            message: `Failed to read include file: "${directive.path}"`,
                            code: 'DCTL014',
                        });
                        expandedLines.push(`// ERROR: ${lines[i]}`);
                        sourceMapBuilder.addLine(filePath, lineNumber);
                        continue;
                    }

                    // Track included file
                    if (!includedFiles.includes(includeResult.resolvedPath)) {
                        includedFiles.push(includeResult.resolvedPath);
                    }

                    // Recursively expand the included file
                    try {
                        const nestedLines = await this.expandSource(
                            includeResult.content,
                            includeResult.resolvedPath,
                            errors,
                            warnings,
                            includedFiles,
                            sourceMapBuilder
                        );

                        // Add the expanded lines
                        expandedLines.push(...nestedLines);
                    } catch (error) {
                        if (error instanceof CircularIncludeError) {
                            errors.push({
                                file: filePath,
                                line: lineNumber,
                                column: directive.column,
                                message: error.message,
                                code: 'DCTL015',
                            });
                            expandedLines.push(`// ERROR: Circular include: ${lines[i]}`);
                            sourceMapBuilder.addLine(filePath, lineNumber);
                        } else {
                            throw error;
                        }
                    }
                } else {
                    // Regular line, just add it
                    expandedLines.push(lines[i]);
                    sourceMapBuilder.addLine(filePath, lineNumber);
                }
            }

            return expandedLines;
        });
    }

    /**
     * Create an error result
     */
    private createErrorResult(
        message: string,
        file: string,
        line: number,
        code: PreprocessError['code']
    ): PreprocessResult {
        return {
            expandedSource: '',
            includeExpandedSource: '',
            sourceMap: createSingleFileSourceMap(file, 0),
            includedFiles: [],
            params: [],
            functionMacros: [],
            warnings: [],
            errors: [
                {
                    file,
                    line,
                    column: 1,
                    message,
                    code,
                },
            ],
            success: false,
            lineOffset: 0,
        };
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
            const line = lines[i];

            // Check if line ends with backslash (line continuation)
            if (line.endsWith('\\')) {
                // Remove the backslash and join with next line
                currentLine += line.slice(0, -1);
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

    /**
     * Clear the file cache
     */
    clearCache(): void {
        this.pathResolver.clearCache();
    }

    /**
     * Invalidate a file from the cache
     * Call this when a file changes
     */
    invalidateFile(filePath: string): void {
        this.pathResolver.invalidateCache(filePath);
    }
}

/**
 * Convenience function to preprocess a DCTL file
 */
export async function preprocessDctlFile(
    filePath: string,
    options?: PreprocessOptions
): Promise<PreprocessResult> {
    const preprocessor = new DctlPreprocessor(undefined, options);
    return preprocessor.preprocess(filePath);
}

/**
 * Convenience function to preprocess DCTL source
 */
export async function preprocessDctlSource(
    source: string,
    virtualPath: string,
    options?: PreprocessOptions
): Promise<PreprocessResult> {
    const preprocessor = new DctlPreprocessor(undefined, options);
    return preprocessor.preprocessSource(source, virtualPath);
}
