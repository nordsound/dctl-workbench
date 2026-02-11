/**
 * OpenEXR WASM Module Cache
 *
 * Caches the initialized WASM module for reuse across multiple file loads.
 */

import type { OpenEXRModule } from '../../../../wasm/openexr_wasm';
import * as path from 'path';
import * as fs from 'fs';

let cachedModule: OpenEXRModule | null = null;
let modulePromise: Promise<OpenEXRModule> | null = null;
let wasmDirectory: string | null = null;

/**
 * Set the WASM directory path (must be called before initOpenEXR)
 */
export function setOpenEXRWasmDirectory(dir: string): void {
    wasmDirectory = dir;
}

/**
 * Clear the cached module (forces re-initialization on next call)
 */
export function clearOpenEXRCache(): void {
    cachedModule = null;
    modulePromise = null;
}

/**
 * Check if the cached module has valid HEAP views
 */
function isModuleValid(module: OpenEXRModule): boolean {
    return !!(module && module.HEAPF32 && module.HEAPU8);
}

/**
 * Initialize the OpenEXR WASM module
 * @param forceReload If true, always create a fresh module instance (useful for writing)
 */
export async function initOpenEXR(forceReload: boolean = false): Promise<OpenEXRModule> {
    // For writing operations, always get a fresh module to avoid HEAP view issues
    if (forceReload) {
        console.log('[OpenEXR] Force reload requested, creating fresh module...');
        return await loadModule();
    }

    // Check if cached module is still valid (HEAP views can become invalid after memory growth)
    if (cachedModule && !isModuleValid(cachedModule)) {
        console.warn('[OpenEXR] Cached module has invalid HEAP views, re-initializing...');
        cachedModule = null;
        modulePromise = null;
    }

    if (cachedModule) {
        return cachedModule;
    }

    if (modulePromise) {
        return modulePromise;
    }

    if (!wasmDirectory) {
        throw new Error('WASM directory not set. Call setOpenEXRWasmDirectory() first.');
    }

    modulePromise = loadModule();
    cachedModule = await modulePromise;
    return cachedModule;
}

async function loadModule(): Promise<OpenEXRModule> {
    const openexrJsPath = path.join(wasmDirectory!, 'openexr.js');
    const openexrWasmPath = path.join(wasmDirectory!, 'openexr.wasm');

    if (!fs.existsSync(openexrJsPath)) {
        throw new Error(`OpenEXR JS module not found at ${openexrJsPath}`);
    }

    // Read WASM binary directly to avoid Emscripten fetch issues in Node.js
    const wasmBinary = fs.readFileSync(openexrWasmPath);

    // Load the Emscripten module factory
    const openexrModule = await import(openexrJsPath);
    const createOpenEXR = openexrModule.default;

    // Create a new module instance
    // Note: Each call to createOpenEXR() should create a fresh instance
    const module = await createOpenEXR({
        wasmBinary,
    }) as OpenEXRModule;

    // Log HEAP view status (they may not be exposed by this Emscripten build)
    // The setValue/getValue fallback in writer.ts will handle this case
    if (!module.HEAPF32 || !module.HEAPU8) {
        console.warn('[OpenEXR] HEAP views not exposed, will use setValue/getValue fallback');
    }

    return module;
}

/**
 * Get the OpenEXR module (must be initialized first)
 */
export function getOpenEXRModule(): OpenEXRModule {
    if (!cachedModule) {
        throw new Error('OpenEXR module not initialized. Call initOpenEXR() first.');
    }
    return cachedModule;
}

/**
 * Check if the OpenEXR module is initialized
 */
export function isOpenEXRInitialized(): boolean {
    return cachedModule !== null;
}
