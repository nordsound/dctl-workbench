/**
 * WASM directory discovery utility.
 *
 * Both OpenEXR and OCIO WASM modules live in the same directory.
 * This helper checks known locations and returns the first that exists.
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Find the WASM directory under the extension path.
 * Checks `out/wasm` (bundled) then `wasm` (development).
 */
export function findWasmDir(extensionPath: string): string {
    const candidates = [
        path.join(extensionPath, 'out', 'wasm'),
        path.join(extensionPath, 'wasm'),
    ];

    for (const dir of candidates) {
        if (fs.existsSync(dir)) {
            return dir;
        }
    }

    return candidates[0];
}
