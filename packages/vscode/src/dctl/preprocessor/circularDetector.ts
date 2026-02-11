/**
 * Circular Include Detector
 *
 * Detects circular includes in DCTL files to prevent infinite loops.
 */

import * as path from 'path';

/**
 * Error thrown when a circular include is detected
 */
export class CircularIncludeError extends Error {
    /** The file that caused the circular reference */
    readonly file: string;
    /** The include chain leading to the circular reference */
    readonly includeChain: string[];

    constructor(file: string, includeChain: string[]) {
        const chainStr = includeChain.map(f => path.basename(f)).join(' → ');
        super(`Circular include detected: ${chainStr} → ${path.basename(file)}`);
        this.name = 'CircularIncludeError';
        this.file = file;
        this.includeChain = includeChain;
    }
}

/**
 * Circular Include Detector
 *
 * Maintains a stack of currently processing files to detect circular includes.
 */
export class CircularIncludeDetector {
    /** Stack of files currently being processed */
    private includeStack: string[] = [];

    /** Set of files in the stack for O(1) lookup */
    private stackSet: Set<string> = new Set();

    /** Maximum include depth (default: 32) */
    private maxDepth: number;

    constructor(maxDepth: number = 32) {
        this.maxDepth = maxDepth;
    }

    /**
     * Push a file onto the include stack
     * @param filePath - Normalized absolute path to the file
     * @throws CircularIncludeError if circular include is detected
     * @throws Error if maximum include depth is exceeded
     */
    push(filePath: string): void {
        const normalized = path.normalize(filePath);

        // Check for circular include
        if (this.stackSet.has(normalized)) {
            throw new CircularIncludeError(normalized, [...this.includeStack]);
        }

        // Check maximum depth
        if (this.includeStack.length >= this.maxDepth) {
            throw new Error(
                `Maximum include depth (${this.maxDepth}) exceeded. ` +
                `Current chain: ${this.includeStack.map(f => path.basename(f)).join(' → ')}`
            );
        }

        this.includeStack.push(normalized);
        this.stackSet.add(normalized);
    }

    /**
     * Pop a file from the include stack
     */
    pop(): void {
        const filePath = this.includeStack.pop();
        if (filePath) {
            this.stackSet.delete(filePath);
        }
    }

    /**
     * Check if a file is currently in the include stack
     * @param filePath - Path to check
     * @returns true if the file is in the stack
     */
    isInStack(filePath: string): boolean {
        return this.stackSet.has(path.normalize(filePath));
    }

    /**
     * Get the current include stack
     * @returns Copy of the current include stack
     */
    getStack(): string[] {
        return [...this.includeStack];
    }

    /**
     * Get the current depth of the include stack
     */
    getDepth(): number {
        return this.includeStack.length;
    }

    /**
     * Get the current file being processed
     * @returns The file at the top of the stack, or null if empty
     */
    getCurrentFile(): string | null {
        return this.includeStack.length > 0
            ? this.includeStack[this.includeStack.length - 1]
            : null;
    }

    /**
     * Reset the detector to initial state
     */
    reset(): void {
        this.includeStack = [];
        this.stackSet.clear();
    }

    /**
     * Execute a function with a file on the stack
     * Automatically pops the file when done (even if an error occurs)
     *
     * @param filePath - File to push onto stack
     * @param fn - Function to execute
     * @returns Result of the function
     */
    withFile<T>(filePath: string, fn: () => T): T {
        this.push(filePath);
        try {
            return fn();
        } finally {
            this.pop();
        }
    }

    /**
     * Async version of withFile
     *
     * @param filePath - File to push onto stack
     * @param fn - Async function to execute
     * @returns Promise of the result
     */
    async withFileAsync<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
        this.push(filePath);
        try {
            return await fn();
        } finally {
            this.pop();
        }
    }

    /**
     * Format the current include chain for error messages
     */
    formatChain(): string {
        if (this.includeStack.length === 0) {
            return '(empty)';
        }
        return this.includeStack.map(f => path.basename(f)).join(' → ');
    }
}
