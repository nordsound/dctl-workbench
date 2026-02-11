/**
 * Tree-sitter DCTL Parser
 *
 * Uses tree-sitter-dctl (extended from tree-sitter-c) to parse DCTL files.
 * Properly recognizes DCTL-specific types (float3, float4, etc.) and
 * modifiers (__DEVICE__, __TEXTURE__, etc.) in the AST.
 */

import { Parser, Language, Tree as TreeType } from 'web-tree-sitter';
import * as path from 'path';
import * as fs from 'fs';

// Re-export Tree type for use in other modules
export type Tree = TreeType;

let parser: Parser | null = null;
let parserPromise: Promise<Parser> | null = null;

/**
 * Initialize the tree-sitter parser with DCTL language grammar
 */
export async function initParser(extensionPath: string): Promise<Parser> {
    if (parser) {
        return parser;
    }

    if (parserPromise) {
        return parserPromise;
    }

    parserPromise = (async () => {
        console.log('[DCTL] Initializing tree-sitter parser...');

        // Provide locateFile so tree-sitter can find its WASM in the bundled extension
        const wasmDir = path.join(extensionPath, 'out', 'wasm');
        await Parser.init({
            locateFile(scriptName: string) {
                return path.join(wasmDir, scriptName);
            },
        });

        console.log('[DCTL] tree-sitter initialized');

        // Create parser instance
        parser = new Parser();

        // Try DCTL grammar first, fall back to C grammar
        const dctlWasmPath = path.join(
            extensionPath,
            'out',
            'wasm',
            'tree-sitter',
            'tree-sitter-dctl.wasm'
        );

        const cWasmPath = path.join(
            extensionPath,
            'out',
            'wasm',
            'tree-sitter',
            'tree-sitter-c.wasm'
        );

        let wasmPath: string;
        let languageName: string;

        if (fs.existsSync(dctlWasmPath)) {
            wasmPath = dctlWasmPath;
            languageName = 'DCTL';
        } else if (fs.existsSync(cWasmPath)) {
            console.log('[DCTL] tree-sitter-dctl.wasm not found, falling back to C grammar');
            wasmPath = cWasmPath;
            languageName = 'C';
        } else {
            throw new Error(`No tree-sitter WASM found. Tried:\n  ${dctlWasmPath}\n  ${cWasmPath}`);
        }

        console.log(`[DCTL] Loading ${languageName} language from:`, wasmPath);

        // Load the language WASM from file path
        const language = await Language.load(wasmPath);

        console.log(`[DCTL] ${languageName} language loaded`);

        parser.setLanguage(language);

        console.log(`[DCTL] Parser configured with ${languageName} language`);

        return parser;
    })();

    parser = await parserPromise;
    return parser;
}

/**
 * Parse DCTL source code and return the syntax tree
 */
export function parse(source: string): Tree | null {
    if (!parser) {
        throw new Error('Parser not initialized. Call initParser() first.');
    }

    return parser.parse(source);
}

/**
 * Parse DCTL source code with incremental update
 */
export function parseIncremental(
    source: string,
    previousTree?: Tree
): Tree | null {
    if (!parser) {
        throw new Error('Parser not initialized. Call initParser() first.');
    }

    return parser.parse(source, previousTree);
}

/**
 * Get the parser instance (for advanced usage)
 */
export function getParser(): Parser | null {
    return parser;
}

/**
 * Check if parser is initialized
 */
export function isInitialized(): boolean {
    return parser !== null;
}
