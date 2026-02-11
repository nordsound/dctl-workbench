/**
 * DCTL Preprocessor
 *
 * Collects #include files from DCTL source and provides them to the Rust compiler.
 * This implements the "pre-collection" approach where TypeScript handles file I/O
 * and Rust handles the actual preprocessing logic.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Map of include file paths to their contents
 */
export interface IncludeMap {
    [filePath: string]: string;
}

/**
 * Options for the preprocessor
 */
export interface PreprocessOptions {
    /** List of directories to search for include files */
    includeDirs: string[];
    /** Path to the main DCTL file (for relative path resolution) */
    mainFilePath?: string;
}

/**
 * Result of include collection
 */
export interface CollectIncludesResult {
    /** Map of include paths to their contents */
    includes: IncludeMap;
    /** List of include paths that could not be resolved */
    missing: string[];
}

/**
 * Collect all #include files from DCTL source
 *
 * Recursively finds and reads all included files, building a map
 * that can be passed to the Rust compiler.
 *
 * @param source - The DCTL source code
 * @param options - Preprocessor options
 * @returns Collection result with includes map and missing files
 */
export async function collectIncludes(
    source: string,
    options: PreprocessOptions
): Promise<CollectIncludesResult> {
    const includes: IncludeMap = {};
    const missing: string[] = [];
    const visited = new Set<string>();

    async function collect(content: string, currentDir: string): Promise<void> {
        // Match both #include "file.h" and #include <file.h>
        const includeRegex = /#include\s*["<]([^">]+)[">]/g;
        let match;

        while ((match = includeRegex.exec(content)) !== null) {
            const includePath = match[1];

            // Skip if already processed
            if (visited.has(includePath)) continue;
            visited.add(includePath);

            // Try to resolve the include path
            const resolvedPath = await resolveIncludePath(
                includePath,
                currentDir,
                options.includeDirs
            );

            if (resolvedPath) {
                try {
                    const includeContent = await fs.promises.readFile(resolvedPath, 'utf-8');
                    includes[includePath] = includeContent;

                    // Recursively collect includes from this file
                    await collect(includeContent, path.dirname(resolvedPath));
                } catch (err) {
                    // File exists but couldn't be read
                    missing.push(includePath);
                }
            } else {
                // Could not find the file
                missing.push(includePath);
            }
        }
    }

    // Determine the starting directory for relative path resolution
    const mainDir = options.mainFilePath
        ? path.dirname(options.mainFilePath)
        : process.cwd();

    await collect(source, mainDir);

    return { includes, missing };
}

/**
 * Resolve an include path to an absolute file path
 *
 * Search order:
 * 1. Relative to the current file's directory
 * 2. Each directory in includeDirs
 *
 * @param includePath - The path from the #include directive
 * @param currentDir - Directory of the file containing the #include
 * @param includeDirs - Additional directories to search
 * @returns Resolved absolute path, or null if not found
 */
async function resolveIncludePath(
    includePath: string,
    currentDir: string,
    includeDirs: string[]
): Promise<string | null> {
    // 1. Try relative to current directory
    const localPath = path.join(currentDir, includePath);
    if (await fileExists(localPath)) {
        return localPath;
    }

    // 2. Try each include directory
    for (const dir of includeDirs) {
        const fullPath = path.join(dir, includePath);
        if (await fileExists(fullPath)) {
            return fullPath;
        }
    }

    return null;
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Synchronous version of collectIncludes for use in non-async contexts
 */
export function collectIncludesSync(
    source: string,
    options: PreprocessOptions
): CollectIncludesResult {
    const includes: IncludeMap = {};
    const missing: string[] = [];
    const visited = new Set<string>();

    function collect(content: string, currentDir: string): void {
        const includeRegex = /#include\s*["<]([^">]+)[">]/g;
        let match;

        while ((match = includeRegex.exec(content)) !== null) {
            const includePath = match[1];

            if (visited.has(includePath)) continue;
            visited.add(includePath);

            const resolvedPath = resolveIncludePathSync(
                includePath,
                currentDir,
                options.includeDirs
            );

            if (resolvedPath) {
                try {
                    const includeContent = fs.readFileSync(resolvedPath, 'utf-8');
                    includes[includePath] = includeContent;
                    collect(includeContent, path.dirname(resolvedPath));
                } catch {
                    missing.push(includePath);
                }
            } else {
                missing.push(includePath);
            }
        }
    }

    const mainDir = options.mainFilePath
        ? path.dirname(options.mainFilePath)
        : process.cwd();

    collect(source, mainDir);

    return { includes, missing };
}

/**
 * Synchronous version of resolveIncludePath
 */
function resolveIncludePathSync(
    includePath: string,
    currentDir: string,
    includeDirs: string[]
): string | null {
    const localPath = path.join(currentDir, includePath);
    if (fileExistsSync(localPath)) {
        return localPath;
    }

    for (const dir of includeDirs) {
        const fullPath = path.join(dir, includePath);
        if (fileExistsSync(fullPath)) {
            return fullPath;
        }
    }

    return null;
}

/**
 * Synchronous file exists check
 */
function fileExistsSync(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}
