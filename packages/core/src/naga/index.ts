/**
 * Naga Module
 *
 * GLSL to WGSL shader conversion using the Naga WASM module.
 * Used primarily for ACES 2.0 RGC (Reference Gamut Compression) support.
 */

import * as path from 'path';
import * as fs from 'fs';

// WASM ConversionResult type (from wasm-bindgen)
interface NagaConversionResult {
    readonly wgsl: string;
    readonly error: string;
    readonly success: boolean;
    free(): void;
}

// WASM module type
interface NagaModule {
    glsl_to_wgsl(glsl_source: string, stage: string, entry_point: string): NagaConversionResult;
    glsl_fragment_to_wgsl(glsl: string): NagaConversionResult;
    glsl_vertex_to_wgsl(glsl: string): NagaConversionResult;
    glsl_compute_to_wgsl(glsl: string): NagaConversionResult;
    validate_glsl?(glsl_source: string, stage: string): NagaConversionResult;
    get_naga_version?(): string;
}

/**
 * Shader stage type
 */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/**
 * Conversion result
 */
export interface ConversionResult {
    success: boolean;
    wgsl: string;
    error?: string;
}

/**
 * Shader conversion result (VS Code compatible alias)
 */
export interface ShaderConversionResult {
    success: boolean;
    wgsl: string;
    error: string;
}

/**
 * Naga Processor for GLSL to WGSL conversion
 */
export class NagaProcessor {
    private module: NagaModule | null = null;
    private initPromise: Promise<void> | null = null;

    /**
     * Initialize the Naga WASM module
     */
    async init(wasmPath: string): Promise<void> {
        if (this.module) {
            return;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this.loadModule(wasmPath);
        return this.initPromise;
    }

    private async loadModule(basePath: string): Promise<void> {
        const possiblePaths = [
            path.join(basePath, 'wasm', 'naga'),
            path.join(basePath, 'out', 'wasm', 'naga'),
            path.join(basePath, 'naga'),
        ];

        let jsPath = '';
        let wasmPath = '';

        for (const testPath of possiblePaths) {
            const testWasm = path.join(testPath, 'naga_wasm_bg.wasm');
            const testJs = path.join(testPath, 'naga_wasm.js');
            if (fs.existsSync(testWasm) && fs.existsSync(testJs)) {
                jsPath = testJs;
                wasmPath = testWasm;
                break;
            }
        }

        if (!jsPath || !wasmPath) {
            throw new Error(`Naga WASM files not found in any of: ${possiblePaths.join(', ')}`);
        }

        // Load the module
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nagaJs = require(jsPath);

        // Some wasm-pack builds use initSync, others auto-load when required
        if (typeof nagaJs.initSync === 'function') {
            // Load WASM file and initialize
            const wasmBuffer = fs.readFileSync(wasmPath);
            nagaJs.initSync(wasmBuffer);
        }
        // If no initSync, the module auto-loaded when required

        this.module = nagaJs as NagaModule;
    }

    /**
     * Check if initialized
     */
    get isInitialized(): boolean {
        return this.module !== null;
    }

    /**
     * Get naga version
     */
    getVersion(): string {
        if (!this.module) {
            return 'unknown';
        }
        if (this.module.get_naga_version) {
            return this.module.get_naga_version();
        }
        return 'unknown';
    }

    /**
     * Validate GLSL shader without converting
     */
    validateGLSL(glslSource: string, stage: ShaderStage): ConversionResult {
        if (!this.module) {
            return {
                success: false,
                wgsl: '',
                error: 'Naga module not initialized',
            };
        }

        if (!this.module.validate_glsl) {
            // Fallback: try to convert and check for errors
            switch (stage) {
                case 'fragment':
                    return this.convertFragmentToWGSL(glslSource);
                case 'vertex':
                    return this.convertVertexToWGSL(glslSource);
                case 'compute':
                    return this.convertComputeToWGSL(glslSource);
            }
        }

        try {
            const result = this.module.validate_glsl(glslSource, stage);
            const output: ConversionResult = {
                success: result.success,
                wgsl: '',
                error: result.error || undefined,
            };
            if (typeof result.free === 'function') {
                result.free();
            }
            return output;
        } catch (err) {
            return {
                success: false,
                wgsl: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Convert GLSL fragment shader to WGSL
     */
    convertFragmentToWGSL(glsl: string): ConversionResult {
        if (!this.module) {
            return {
                success: false,
                wgsl: '',
                error: 'Naga module not initialized',
            };
        }

        try {
            const result = this.module.glsl_fragment_to_wgsl(glsl);
            const output: ConversionResult = {
                success: result.success,
                wgsl: result.wgsl || '',
                error: result.error || undefined,
            };
            // Free the WASM object
            if (typeof result.free === 'function') {
                result.free();
            }
            return output;
        } catch (err) {
            return {
                success: false,
                wgsl: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Convert GLSL vertex shader to WGSL
     */
    convertVertexToWGSL(glsl: string): ConversionResult {
        if (!this.module) {
            return {
                success: false,
                wgsl: '',
                error: 'Naga module not initialized',
            };
        }

        try {
            const result = this.module.glsl_vertex_to_wgsl(glsl);
            const output: ConversionResult = {
                success: result.success,
                wgsl: result.wgsl || '',
                error: result.error || undefined,
            };
            if (typeof result.free === 'function') {
                result.free();
            }
            return output;
        } catch (err) {
            return {
                success: false,
                wgsl: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Convert GLSL compute shader to WGSL
     */
    convertComputeToWGSL(glsl: string): ConversionResult {
        if (!this.module) {
            return {
                success: false,
                wgsl: '',
                error: 'Naga module not initialized',
            };
        }

        try {
            const result = this.module.glsl_compute_to_wgsl(glsl);
            const output: ConversionResult = {
                success: result.success,
                wgsl: result.wgsl || '',
                error: result.error || undefined,
            };
            if (typeof result.free === 'function') {
                result.free();
            }
            return output;
        } catch (err) {
            return {
                success: false,
                wgsl: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Convert GLSL to WGSL with shader stage and entry point
     * @param glsl GLSL source code
     * @param stage Shader stage (vertex, fragment, compute)
     * @param entryPoint Entry point function name (default: "main")
     */
    convertToWGSLWithStage(glsl: string, stage: ShaderStage, entryPoint: string = 'main'): ConversionResult {
        if (!this.module) {
            return {
                success: false,
                wgsl: '',
                error: 'Naga module not initialized',
            };
        }

        try {
            const result = this.module.glsl_to_wgsl(glsl, stage, entryPoint);
            const output: ConversionResult = {
                success: result.success,
                wgsl: result.wgsl || '',
                error: result.error || undefined,
            };
            if (typeof result.free === 'function') {
                result.free();
            }
            return output;
        } catch (err) {
            return {
                success: false,
                wgsl: '',
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    /**
     * Convert GLSL to WGSL with shader type specification (legacy signature)
     * @deprecated Use convertToWGSLWithStage or stage-specific methods instead
     */
    convertToWGSL(glsl: string, isFragment: boolean): ConversionResult {
        const stage: ShaderStage = isFragment ? 'fragment' : 'vertex';
        return this.convertToWGSLWithStage(glsl, stage, 'main');
    }
}

// Singleton instance
let nagaInstance: NagaProcessor | null = null;

/**
 * Get the singleton NagaProcessor instance
 */
export function getNagaProcessor(): NagaProcessor {
    if (!nagaInstance) {
        nagaInstance = new NagaProcessor();
    }
    return nagaInstance;
}

