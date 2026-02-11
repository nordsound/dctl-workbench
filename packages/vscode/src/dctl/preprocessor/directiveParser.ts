/**
 * DCTL Include Directive Parser
 *
 * Parses #include directives from DCTL source code.
 * Only supports double-quote format: #include "path"
 */

import { IncludeDirective, PreprocessWarning } from './types';

/**
 * Pattern for double-quote includes: #include "path"
 * Captures: path inside quotes
 */
const INCLUDE_QUOTED_PATTERN = /^\s*#\s*include\s+"([^"]+)"/;

/**
 * Pattern for angle bracket includes: #include <path>
 * Used to detect unsupported syntax and emit warnings
 */
const INCLUDE_ANGLED_PATTERN = /^\s*#\s*include\s+<([^>]+)>/;

/**
 * Pattern to detect any include directive
 */
const INCLUDE_ANY_PATTERN = /^\s*#\s*include\s+/;

/**
 * Result of parsing include directives from source
 */
export interface ParseDirectivesResult {
    /** Parsed include directives */
    directives: IncludeDirective[];
    /** Warnings (e.g., unsupported angle bracket syntax) */
    warnings: PreprocessWarning[];
}

/**
 * Parse all #include directives from DCTL source
 *
 * @param source - DCTL source code
 * @param filePath - Path to the source file (for error reporting)
 * @returns Parsed directives and any warnings
 */
export function parseIncludeDirectives(
    source: string,
    filePath: string
): ParseDirectivesResult {
    const directives: IncludeDirective[] = [];
    const warnings: PreprocessWarning[] = [];

    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        // Skip if not an include directive
        if (!INCLUDE_ANY_PATTERN.test(line)) {
            continue;
        }

        // Skip if inside a block comment (simple heuristic)
        if (isInsideBlockComment(lines, i)) {
            continue;
        }

        // Skip if line comment before #include
        const commentIndex = line.indexOf('//');
        const includeIndex = line.search(/#\s*include/);
        if (commentIndex !== -1 && commentIndex < includeIndex) {
            continue;
        }

        // Try to match double-quote include
        const quotedMatch = line.match(INCLUDE_QUOTED_PATTERN);
        if (quotedMatch) {
            const column = line.indexOf('#') + 1;
            directives.push({
                line: lineNumber,
                column,
                path: quotedMatch[1],
                raw: quotedMatch[0].trim(),
            });
            continue;
        }

        // Check for angle bracket include (unsupported)
        const angledMatch = line.match(INCLUDE_ANGLED_PATTERN);
        if (angledMatch) {
            const column = line.indexOf('#') + 1;
            warnings.push({
                file: filePath,
                line: lineNumber,
                message: `Angle bracket includes are not supported in DCTL. Use #include "${angledMatch[1]}" instead.`,
                code: 'DCTL017',
            });
            continue;
        }

        // Invalid include syntax - will be caught by preprocessor as error
    }

    return { directives, warnings };
}

/**
 * Simple heuristic to check if a line is inside a block comment
 *
 * Note: This is a simplified check that doesn't handle all edge cases
 * (e.g., nested comments, strings containing comment markers)
 */
function isInsideBlockComment(lines: string[], lineIndex: number): boolean {
    let inBlockComment = false;

    for (let i = 0; i <= lineIndex; i++) {
        const line = lines[i];
        let pos = 0;

        while (pos < line.length) {
            if (inBlockComment) {
                // Look for end of block comment
                const endPos = line.indexOf('*/', pos);
                if (endPos !== -1) {
                    inBlockComment = false;
                    pos = endPos + 2;
                } else {
                    break; // Still in comment, check next line
                }
            } else {
                // Look for start of block comment
                const startPos = line.indexOf('/*', pos);
                const lineCommentPos = line.indexOf('//', pos);

                // If line comment comes first, skip rest of line
                if (lineCommentPos !== -1 && (startPos === -1 || lineCommentPos < startPos)) {
                    break;
                }

                if (startPos !== -1) {
                    inBlockComment = true;
                    pos = startPos + 2;
                } else {
                    break;
                }
            }
        }
    }

    return inBlockComment;
}

/**
 * Check if a line contains an include directive
 */
export function hasIncludeDirective(line: string): boolean {
    return INCLUDE_ANY_PATTERN.test(line);
}

/**
 * Get the include path from a line (if it's a valid include directive)
 */
export function getIncludePath(line: string): string | null {
    const match = line.match(INCLUDE_QUOTED_PATTERN);
    return match ? match[1] : null;
}
