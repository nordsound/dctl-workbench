/**
 * DCTL Include Path Resolver
 *
 * Resolves #include paths relative to the including DCTL file.
 * Only supports relative paths (DCTL specification).
 */

import * as path from 'path';

/**
 * Interface for file system operations
 * Allows for different implementations (real FS, virtual FS, etc.)
 */
export interface FileSystem {
    /** Check if a file exists */
    exists(filePath: string): boolean | Promise<boolean>;
    /** Read file contents */
    readFile(filePath: string): string | Promise<string>;
    /** Normalize path for the current platform */
    normalizePath(filePath: string): string;
}

/**
 * Default file system implementation using Node.js fs
 */
export class NodeFileSystem implements FileSystem {
    private fs: typeof import('fs');

    constructor() {
        // Dynamic import to support both Node and browser environments
        this.fs = require('fs');
    }

    exists(filePath: string): boolean {
        try {
            return this.fs.existsSync(filePath);
        } catch {
            return false;
        }
    }

    readFile(filePath: string): string {
        return this.fs.readFileSync(filePath, 'utf-8');
    }

    normalizePath(filePath: string): string {
        return path.normalize(filePath);
    }
}

/**
 * Result of path resolution
 */
export interface ResolveResult {
    /** Whether the file was found */
    found: boolean;
    /** Resolved absolute path (if found) */
    resolvedPath: string | null;
    /** Original include path */
    includePath: string;
    /** Error message (if not found) */
    error?: string;
}

/**
 * Include Path Resolver
 *
 * Resolves include paths according to DCTL specification:
 * - Paths are relative to the including file's directory
 * - Only double-quote includes are supported
 */
export class IncludePathResolver {
    private fileSystem: FileSystem;
    private fileCache: Map<string, string> = new Map();
    private cacheEnabled: boolean;

    constructor(fileSystem?: FileSystem, cacheEnabled: boolean = true) {
        this.fileSystem = fileSystem ?? new NodeFileSystem();
        this.cacheEnabled = cacheEnabled;
    }

    /**
     * Resolve an include path relative to the current file
     *
     * @param includePath - The path from #include directive
     * @param currentFile - The file containing the #include directive
     * @returns Resolution result
     */
    resolve(includePath: string, currentFile: string): ResolveResult {
        // Get the directory of the current file
        const currentDir = path.dirname(currentFile);

        // Resolve the include path relative to current directory
        const resolvedPath = this.fileSystem.normalizePath(
            path.resolve(currentDir, includePath)
        );

        // Check if file exists
        const exists = this.fileSystem.exists(resolvedPath);

        if (exists) {
            return {
                found: true,
                resolvedPath,
                includePath,
            };
        }

        return {
            found: false,
            resolvedPath: null,
            includePath,
            error: `Include file not found: "${includePath}" (searched: ${resolvedPath})`,
        };
    }

    /**
     * Resolve and read an include file
     *
     * @param includePath - The path from #include directive
     * @param currentFile - The file containing the #include directive
     * @returns File contents if found, null otherwise
     */
    resolveAndRead(
        includePath: string,
        currentFile: string
    ): { content: string; resolvedPath: string } | null {
        const result = this.resolve(includePath, currentFile);

        if (!result.found || !result.resolvedPath) {
            return null;
        }

        // Check cache first
        if (this.cacheEnabled && this.fileCache.has(result.resolvedPath)) {
            return {
                content: this.fileCache.get(result.resolvedPath)!,
                resolvedPath: result.resolvedPath,
            };
        }

        try {
            const content = this.fileSystem.readFile(result.resolvedPath);

            // Cache the content
            if (this.cacheEnabled && typeof content === 'string') {
                this.fileCache.set(result.resolvedPath, content);
            }

            return {
                content: content as string,
                resolvedPath: result.resolvedPath,
            };
        } catch {
            return null;
        }
    }

    /**
     * Check if a file exists
     */
    exists(filePath: string): boolean {
        const result = this.fileSystem.exists(filePath);
        return typeof result === 'boolean' ? result : false;
    }

    /**
     * Clear the file cache
     */
    clearCache(): void {
        this.fileCache.clear();
    }

    /**
     * Invalidate a specific file from cache
     */
    invalidateCache(filePath: string): void {
        const normalized = this.fileSystem.normalizePath(filePath);
        this.fileCache.delete(normalized);
    }

    /**
     * Get the directory containing a file
     */
    getDirectory(filePath: string): string {
        return path.dirname(filePath);
    }

    /**
     * Normalize a file path
     */
    normalize(filePath: string): string {
        return this.fileSystem.normalizePath(filePath);
    }
}

/**
 * Virtual file system for testing
 */
export class VirtualFileSystem implements FileSystem {
    private files: Map<string, string> = new Map();

    constructor(files?: Record<string, string>) {
        if (files) {
            for (const [filePath, content] of Object.entries(files)) {
                this.files.set(path.normalize(filePath), content);
            }
        }
    }

    addFile(filePath: string, content: string): void {
        this.files.set(path.normalize(filePath), content);
    }

    removeFile(filePath: string): void {
        this.files.delete(path.normalize(filePath));
    }

    exists(filePath: string): boolean {
        return this.files.has(path.normalize(filePath));
    }

    readFile(filePath: string): string {
        const normalized = path.normalize(filePath);
        const content = this.files.get(normalized);
        if (content === undefined) {
            throw new Error(`File not found: ${filePath}`);
        }
        return content;
    }

    normalizePath(filePath: string): string {
        return path.normalize(filePath);
    }
}
