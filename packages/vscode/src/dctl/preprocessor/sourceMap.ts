/**
 * Source Map for DCTL Preprocessor
 *
 * Maps line numbers in the expanded source back to original files.
 * Essential for error reporting with accurate file/line information.
 */

import { SourceMapEntry, SourceMap } from './types';

/**
 * Source Map Builder
 *
 * Builds a mapping from expanded source lines to original file locations.
 */
export class SourceMapBuilder {
    private entries: SourceMapEntry[] = [];
    private currentGeneratedLine: number = 1;

    /**
     * Add a mapping for a single line
     *
     * @param originalFile - Path to the original file
     * @param originalLine - Line number in the original file (1-based)
     */
    addLine(originalFile: string, originalLine: number): void {
        this.entries.push({
            generatedLine: this.currentGeneratedLine,
            originalFile,
            originalLine,
        });
        this.currentGeneratedLine++;
    }

    /**
     * Add mappings for multiple consecutive lines from the same file
     *
     * @param originalFile - Path to the original file
     * @param startOriginalLine - Starting line number (1-based)
     * @param lineCount - Number of lines to add
     */
    addLines(
        originalFile: string,
        startOriginalLine: number,
        lineCount: number
    ): void {
        for (let i = 0; i < lineCount; i++) {
            this.addLine(originalFile, startOriginalLine + i);
        }
    }

    /**
     * Add mappings for a range of lines (replacing #include directive)
     * The #include line itself is skipped in the output
     *
     * @param originalFile - Path to the original file
     * @param lines - Array of line numbers in the original file
     */
    addLineArray(originalFile: string, lines: number[]): void {
        for (const line of lines) {
            this.addLine(originalFile, line);
        }
    }

    /**
     * Skip a line (for #include directives that are replaced)
     * Does not increment the generated line counter
     */
    skipOriginalLine(): void {
        // This is a no-op - we just don't add the line
    }

    /**
     * Get the current generated line number
     */
    getCurrentGeneratedLine(): number {
        return this.currentGeneratedLine;
    }

    /**
     * Build the final source map
     */
    build(): SourceMap {
        return new SourceMapImpl([...this.entries]);
    }

    /**
     * Reset the builder for reuse
     */
    reset(): void {
        this.entries = [];
        this.currentGeneratedLine = 1;
    }
}

/**
 * Source Map Implementation
 *
 * Provides lookup from generated line numbers to original positions.
 */
class SourceMapImpl implements SourceMap {
    private entries: SourceMapEntry[];
    private lineIndex: Map<number, SourceMapEntry>;

    constructor(entries: SourceMapEntry[]) {
        this.entries = entries;
        this.lineIndex = new Map();
        for (const entry of entries) {
            this.lineIndex.set(entry.generatedLine, entry);
        }
    }

    /**
     * Get the original position for a generated line
     *
     * @param generatedLine - Line number in the expanded source (1-based)
     * @returns Original file and line, or null if not found
     */
    getOriginalPosition(generatedLine: number): {
        file: string;
        line: number;
    } | null {
        const entry = this.lineIndex.get(generatedLine);
        if (!entry) {
            return null;
        }
        return {
            file: entry.originalFile,
            line: entry.originalLine,
        };
    }

    /**
     * Get all entries for a specific original file
     *
     * @param originalFile - Path to the original file
     * @returns All entries that map to this file
     */
    getEntriesForFile(originalFile: string): SourceMapEntry[] {
        return this.entries.filter(e => e.originalFile === originalFile);
    }

    /**
     * Get the generated line for an original position
     *
     * @param originalFile - Path to the original file
     * @param originalLine - Line number in the original file
     * @returns Generated line number, or null if not found
     */
    getGeneratedLine(originalFile: string, originalLine: number): number | null {
        const entry = this.entries.find(
            e => e.originalFile === originalFile && e.originalLine === originalLine
        );
        return entry?.generatedLine ?? null;
    }

    /**
     * Get all source map entries
     */
    getEntries(): SourceMapEntry[] {
        return [...this.entries];
    }

    /**
     * Get the total number of lines in the expanded source
     */
    getTotalLines(): number {
        if (this.entries.length === 0) {
            return 0;
        }
        return this.entries[this.entries.length - 1].generatedLine;
    }

    /**
     * Get unique original files in the source map
     */
    getOriginalFiles(): string[] {
        const files = new Set<string>();
        for (const entry of this.entries) {
            files.add(entry.originalFile);
        }
        return Array.from(files);
    }

    /**
     * Transform an error position from expanded source to original
     *
     * @param generatedLine - Line in expanded source
     * @param generatedColumn - Column in expanded source (optional)
     * @returns Transformed position
     */
    transformPosition(
        generatedLine: number,
        generatedColumn?: number
    ): { file: string; line: number; column?: number } | null {
        const pos = this.getOriginalPosition(generatedLine);
        if (!pos) {
            return null;
        }
        return {
            file: pos.file,
            line: pos.line,
            column: generatedColumn,
        };
    }
}

/**
 * Create an empty source map
 */
export function createEmptySourceMap(): SourceMap {
    return new SourceMapImpl([]);
}

/**
 * Create a source map for a single file (no includes)
 *
 * @param filePath - Path to the file
 * @param lineCount - Number of lines in the file
 */
export function createSingleFileSourceMap(
    filePath: string,
    lineCount: number
): SourceMap {
    const builder = new SourceMapBuilder();
    builder.addLines(filePath, 1, lineCount);
    return builder.build();
}
