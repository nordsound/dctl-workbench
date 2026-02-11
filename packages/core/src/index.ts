/**
 * DCTL Workbench Core
 *
 * Shared module for DCTL compilation and rendering.
 * Can be used by both VSCode extension and Node.js CLI.
 */

// Re-export all types
export * from './types/index.js';

// Re-export modules
export * from './parser/index.js';
export * from './compiler/index.js';
export * from './exr/index.js';
export * from './shader/index.js';
export * from './color-space/index.js';
export * from './naga/index.js';
export * from './ocio/index.js';
export * from './semantic/index.js';
export * from './validation/index.js';
export * from './shared/index.js';

// Import for DctlRuntime class
import { DctlCompiler, isCompileError } from './compiler/index.js';
import { EXRModule, EXRCompression, type EXRWriterOptions, ACES_AP0_CHROMATICITIES } from './exr/index.js';
import {
    buildShader,
    buildComputeShader,
    buildExportShader,
    detectTransformSignature,
    rewriteTextureTransformSignature,
    rewriteTextureTransformForCompute,
    injectParameters,
    removeSampleTextureStub,
    generateColorSpaceCode,
    generateFragmentTextureSampler,
    generateFragmentEntryPoint,
} from './shader/index.js';
import { NagaProcessor } from './naga/index.js';
import type {
    RuntimeInitOptions,
    CompileResult,
    CompileError,
    ShaderBuildOptions,
    ShaderBuildResult,
} from './types/index.js';

/**
 * Main runtime class that provides a unified API for DCTL operations
 */
export class DctlRuntime {
    private compiler: DctlCompiler;
    private exr: EXRModule;
    private naga: NagaProcessor;
    private wasmPath: string = '';
    private initialized: boolean = false;

    constructor() {
        this.compiler = new DctlCompiler();
        this.exr = new EXRModule();
        this.naga = new NagaProcessor();
    }

    /**
     * Initialize all WASM modules
     */
    async init(options: RuntimeInitOptions): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.wasmPath = options.wasmPath;

        // Initialize all modules in parallel
        await Promise.all([
            this.compiler.init(this.wasmPath),
            this.exr.init(this.wasmPath),
            // Naga is optional, don't fail if not available
            this.naga.init(this.wasmPath).catch(() => {
                // Naga module not available, RGC support disabled
            }),
        ]);

        this.initialized = true;
    }

    /**
     * Check if runtime is initialized
     */
    get isInitialized(): boolean {
        return this.initialized;
    }

    // =========================================================================
    // Compilation
    // =========================================================================

    /**
     * Compile DCTL source code to WGSL
     */
    compile(source: string): CompileResult | CompileError {
        this.ensureInitialized();
        return this.compiler.compile(source);
    }

    /**
     * Compile DCTL with include resolution
     */
    async compileWithIncludes(
        source: string,
        options?: { includeDirs?: string[]; mainFilePath?: string }
    ): Promise<CompileResult | CompileError> {
        this.ensureInitialized();
        return this.compiler.compileWithIncludes(source, options);
    }

    /**
     * Get compiler version
     */
    getCompilerVersion(): string {
        this.ensureInitialized();
        return this.compiler.getVersion();
    }

    // =========================================================================
    // Shader Building
    // =========================================================================

    /**
     * Build a complete WGSL shader from compiled DCTL
     */
    buildShader(
        compileResult: CompileResult,
        options: ShaderBuildOptions
    ): ShaderBuildResult {
        return buildShader(compileResult, options);
    }

    /**
     * Build a compute shader for WebGPU rendering
     */
    buildComputeShader(
        compileResult: CompileResult,
        options: ShaderBuildOptions
    ): ShaderBuildResult {
        return buildComputeShader(compileResult, options);
    }

    /**
     * Compile and build shader in one step
     */
    compileAndBuildShader(
        source: string,
        options: ShaderBuildOptions
    ): ShaderBuildResult | CompileError {
        const compileResult = this.compile(source);
        if (isCompileError(compileResult)) {
            return compileResult;
        }
        return this.buildShader(compileResult, options);
    }

    // =========================================================================
    // EXR I/O
    // =========================================================================

    /**
     * Read an EXR file
     */
    async readExr(filePath: string): Promise<{
        width: number;
        height: number;
        channels: string[];
        data: Float32Array;
    }> {
        this.ensureInitialized();
        const result = await this.exr.readFile(filePath);
        const channelNames = result.channels.map(c => c.name);

        // Reorder pixels from BGR to RGB if necessary
        // EXR stores channels in alphabetical order (B, G, R), but shaders expect RGB
        const reorderedPixels = this.reorderChannelsToRGB(result.pixels, channelNames);
        const reorderedChannels = this.getReorderedChannelNames(channelNames);

        return {
            width: result.width,
            height: result.height,
            channels: reorderedChannels,
            data: reorderedPixels,
        };
    }

    /**
     * Read an EXR file (sync)
     */
    readExrSync(filePath: string): {
        width: number;
        height: number;
        channels: string[];
        data: Float32Array;
    } {
        this.ensureInitialized();
        const result = this.exr.readFileSync(filePath);
        const channelNames = result.channels.map(c => c.name);

        // Reorder pixels from BGR to RGB if necessary
        const reorderedPixels = this.reorderChannelsToRGB(result.pixels, channelNames);
        const reorderedChannels = this.getReorderedChannelNames(channelNames);

        return {
            width: result.width,
            height: result.height,
            channels: reorderedChannels,
            data: reorderedPixels,
        };
    }

    /**
     * Write an EXR file
     */
    async writeExr(
        filePath: string,
        options: {
            width: number;
            height: number;
            channels?: 3 | 4;
            data: Float32Array;
            compression?: 'NONE' | 'RLE' | 'ZIPS' | 'ZIP' | 'PIZ' | 'PXR24' | 'B44' | 'B44A' | 'DWAA' | 'DWAB';
            chromaticities?: {
                redX: number; redY: number;
                greenX: number; greenY: number;
                blueX: number; blueY: number;
                whiteX: number; whiteY: number;
            };
            aces?: boolean;
        }
    ): Promise<void> {
        this.ensureInitialized();

        const channels = options.channels ?? 3;
        const writerOptions: EXRWriterOptions = {
            compression: this.parseCompression(options.compression ?? 'PIZ'),
            chromaticities: options.chromaticities ?? (options.aces ? ACES_AP0_CHROMATICITIES : undefined),
            adoptedNeutral: options.aces,
        };

        await this.exr.writeFile(
            filePath,
            options.data,
            options.width,
            options.height,
            channels,
            writerOptions
        );
    }

    /**
     * Write an EXR file (sync)
     */
    writeExrSync(
        filePath: string,
        options: {
            width: number;
            height: number;
            channels?: 3 | 4;
            data: Float32Array;
            compression?: 'NONE' | 'RLE' | 'ZIPS' | 'ZIP' | 'PIZ' | 'PXR24' | 'B44' | 'B44A' | 'DWAA' | 'DWAB';
            chromaticities?: {
                redX: number; redY: number;
                greenX: number; greenY: number;
                blueX: number; blueY: number;
                whiteX: number; whiteY: number;
            };
            aces?: boolean;
        }
    ): void {
        this.ensureInitialized();

        const channels = options.channels ?? 3;
        const writerOptions: EXRWriterOptions = {
            compression: this.parseCompression(options.compression ?? 'PIZ'),
            chromaticities: options.chromaticities ?? (options.aces ? ACES_AP0_CHROMATICITIES : undefined),
            adoptedNeutral: options.aces,
        };

        this.exr.writeFileSync(
            filePath,
            options.data,
            options.width,
            options.height,
            channels,
            writerOptions
        );
    }

    // =========================================================================
    // Naga (GLSL → WGSL conversion)
    // =========================================================================

    /**
     * Check if Naga is available
     */
    get hasNaga(): boolean {
        return this.naga.isInitialized;
    }

    /**
     * Convert GLSL fragment shader to WGSL
     */
    convertGlslToWgsl(glsl: string): { success: boolean; wgsl: string; error?: string } {
        if (!this.naga.isInitialized) {
            return { success: false, wgsl: '', error: 'Naga module not initialized' };
        }
        return this.naga.convertFragmentToWGSL(glsl);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    private ensureInitialized(): void {
        if (!this.initialized) {
            throw new Error('DctlRuntime not initialized. Call init() first.');
        }
    }

    /**
     * Reorder pixel data from BGR(A) to RGB(A) if necessary
     * EXR files store channels in alphabetical order, so B comes before G and R
     */
    private reorderChannelsToRGB(pixels: Float32Array, channelNames: string[]): Float32Array {
        // Check if we need to reorder (BGR or BGRA order)
        const isBGR = channelNames.length >= 3 &&
            channelNames[0] === 'B' &&
            channelNames[1] === 'G' &&
            channelNames[2] === 'R';

        if (!isBGR) {
            return pixels; // Already in correct order or unknown order
        }

        const numChannels = channelNames.length;
        const numPixels = pixels.length / numChannels;
        const reordered = new Float32Array(pixels.length);

        for (let i = 0; i < numPixels; i++) {
            const srcIdx = i * numChannels;
            const dstIdx = i * numChannels;

            // Swap B and R (indices 0 and 2)
            reordered[dstIdx + 0] = pixels[srcIdx + 2]; // R from position 2
            reordered[dstIdx + 1] = pixels[srcIdx + 1]; // G stays at position 1
            reordered[dstIdx + 2] = pixels[srcIdx + 0]; // B from position 0

            // Copy alpha if present
            if (numChannels === 4) {
                reordered[dstIdx + 3] = pixels[srcIdx + 3];
            }
        }

        return reordered;
    }

    /**
     * Get reordered channel names (BGR -> RGB)
     */
    private getReorderedChannelNames(channelNames: string[]): string[] {
        const isBGR = channelNames.length >= 3 &&
            channelNames[0] === 'B' &&
            channelNames[1] === 'G' &&
            channelNames[2] === 'R';

        if (!isBGR) {
            return channelNames;
        }

        if (channelNames.length === 3) {
            return ['R', 'G', 'B'];
        } else if (channelNames.length === 4) {
            return ['R', 'G', 'B', channelNames[3]];
        }

        return channelNames;
    }

    private parseCompression(compression: string): EXRCompression {
        const map: Record<string, EXRCompression> = {
            'NONE': EXRCompression.NONE,
            'RLE': EXRCompression.RLE,
            'ZIPS': EXRCompression.ZIPS,
            'ZIP': EXRCompression.ZIP,
            'PIZ': EXRCompression.PIZ,
            'PXR24': EXRCompression.PXR24,
            'B44': EXRCompression.B44,
            'B44A': EXRCompression.B44A,
            'DWAA': EXRCompression.DWAA,
            'DWAB': EXRCompression.DWAB,
        };
        return map[compression] ?? EXRCompression.PIZ;
    }
}

// Singleton instance
let runtimeInstance: DctlRuntime | null = null;

/**
 * Get the singleton DctlRuntime instance
 */
export function getDctlRuntime(): DctlRuntime {
    if (!runtimeInstance) {
        runtimeInstance = new DctlRuntime();
    }
    return runtimeInstance;
}
