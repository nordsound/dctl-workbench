/**
 * OpenColorIO WASM Module
 *
 * Provides OCIO color transformations via WASM for both CLI and VS Code.
 */

import * as path from 'path';
import * as fs from 'fs';
import type {
    OCIOModule,
    OCIOProcessorInstance,
    GpuShaderInfo,
    GpuTexture,
    GpuTexture3D,
    BuiltinConfigInfo,
    RgcShaderInfo,
} from './types.js';

// Re-export types
export type {
    OCIOModule,
    OCIOProcessorInstance,
    GpuShaderInfo,
    GpuTexture,
    GpuTexture3D,
    BuiltinConfigInfo,
    RgcShaderInfo,
};
export * from './types.js';

// Module state
let ocioModule: OCIOModule | null = null;
let wasmPath: string | null = null;

/**
 * Set the WASM directory path
 */
export function setOcioWasmPath(dir: string): void {
    wasmPath = dir;
}

/**
 * Initialize the OCIO WASM module
 *
 * @param basePath Base path to look for WASM files
 * @returns The initialized OCIO module
 */
export async function initOCIO(basePath?: string): Promise<OCIOModule> {
    if (ocioModule) {
        return ocioModule;
    }

    const searchPath = basePath || wasmPath;
    if (!searchPath) {
        throw new Error('OCIO WASM path not set. Call setOcioWasmPath() or pass basePath.');
    }

    // Try multiple possible locations
    const possiblePaths = [
        path.join(searchPath, 'wasm', 'ocio'),
        path.join(searchPath, 'out', 'wasm', 'ocio'),
        path.join(searchPath, 'out', 'wasm'),  // WASM files at root of wasm/
        path.join(searchPath, 'wasm'),          // WASM files at root of wasm/
        path.join(searchPath, 'ocio'),
        searchPath, // Direct path
    ];

    let ocioJsPath = '';
    let ocioWasmPath = '';

    for (const testPath of possiblePaths) {
        const testJs = path.join(testPath, 'ocio.js');
        const testWasm = path.join(testPath, 'ocio.wasm');
        if (fs.existsSync(testJs) && fs.existsSync(testWasm)) {
            ocioJsPath = testJs;
            ocioWasmPath = testWasm;
            break;
        }
    }

    if (!ocioJsPath || !ocioWasmPath) {
        throw new Error(`OCIO WASM files not found in any of: ${possiblePaths.join(', ')}`);
    }

    // Read WASM binary directly to avoid Emscripten fetch issues in Node.js
    const wasmBinary = fs.readFileSync(ocioWasmPath);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createOCIO = require(ocioJsPath);
    ocioModule = await createOCIO({
        wasmBinary,
    }) as OCIOModule;

    return ocioModule;
}

/**
 * Get the OCIO module (must be initialized first)
 */
export function getOCIOModule(): OCIOModule {
    if (!ocioModule) {
        throw new Error('OCIO module not initialized. Call initOCIO() first.');
    }
    return ocioModule;
}

/**
 * Check if OCIO is initialized
 */
export function isOCIOInitialized(): boolean {
    return ocioModule !== null;
}

/**
 * Get OCIO version string
 */
export function getOCIOVersion(): string {
    if (!ocioModule) {
        return 'Not initialized';
    }
    return ocioModule.getOCIOVersion();
}

/**
 * Get list of available built-in configs
 */
export function getBuiltinConfigs(): BuiltinConfigInfo[] {
    return getOCIOModule().getBuiltinConfigs();
}

/**
 * High-level OCIO Processor class
 */
export class OCIOProcessor {
    private processor: OCIOProcessorInstance;
    private module: OCIOModule;

    constructor() {
        this.module = getOCIOModule();
        this.processor = new this.module.OCIOProcessor();
    }

    /**
     * Initialize with a built-in config
     * @param configName Config name (default: studio-config-v4.0.0_aces-v2.0_ocio-v2.5)
     */
    init(configName: string = ''): boolean {
        return this.processor.initBuiltinConfig(configName);
    }

    /**
     * Get all color spaces in the config
     */
    getColorSpaces(): string[] {
        return this.processor.getColorSpaces();
    }

    /**
     * Get all displays in the config
     */
    getDisplays(): string[] {
        return this.processor.getDisplays();
    }

    /**
     * Get views for a specific display
     */
    getViews(display: string): string[] {
        return this.processor.getViews(display);
    }

    /**
     * Create a color space to color space transform
     */
    createTransform(src: string, dst: string): boolean {
        return this.processor.createTransform(src, dst);
    }

    /**
     * Create a display view transform
     */
    createDisplayTransform(src: string, display: string, view: string): boolean {
        return this.processor.createDisplayTransform(src, display, view);
    }

    /**
     * Apply transform to RGB Float32 data (in-place)
     */
    applyRGB(data: Float32Array): boolean {
        const numPixels = Math.floor(data.length / 3);
        if (numPixels === 0) {
            return false;
        }

        const byteLength = data.byteLength;
        const ptr = this.module._malloc(byteLength);

        try {
            // Copy data to WASM memory
            const heapView = new Float32Array(
                this.module.HEAPF32.buffer,
                ptr,
                data.length
            );
            heapView.set(data);

            // Apply transform
            const success = this.processor.applyRGBPtr(ptr, numPixels);

            if (success) {
                // Copy result back
                data.set(heapView);
            }

            return success;
        } finally {
            this.module._free(ptr);
        }
    }

    /**
     * Apply transform to RGBA Float32 data (in-place)
     */
    applyRGBA(data: Float32Array): boolean {
        const numPixels = Math.floor(data.length / 4);
        if (numPixels === 0) {
            return false;
        }

        const byteLength = data.byteLength;
        const ptr = this.module._malloc(byteLength);

        try {
            // Copy data to WASM memory
            const heapView = new Float32Array(
                this.module.HEAPF32.buffer,
                ptr,
                data.length
            );
            heapView.set(data);

            // Apply transform
            const success = this.processor.applyRGBAPtr(ptr, numPixels);

            if (success) {
                // Copy result back
                data.set(heapView);
            }

            return success;
        } finally {
            this.module._free(ptr);
        }
    }

    // Preset transforms

    /**
     * Setup sRGB linear to ACES2065-1 transform
     */
    setupSrgbToAces(): boolean {
        return this.processor.setupSrgbToAces();
    }

    /**
     * Setup ACES2065-1 to sRGB display (SDR 100 nits) transform
     */
    setupAcesToSrgbDisplay(): boolean {
        return this.processor.setupAcesToSrgbDisplay();
    }

    /**
     * Setup ACES2065-1 to sRGB linear (un-tone-mapped) transform
     */
    setupAcesToSrgbLinear(): boolean {
        return this.processor.setupAcesToSrgbLinear();
    }

    /**
     * Setup ACES2065-1 to Rec.709 display (SDR 100 nits) transform
     */
    setupAcesToRec709Display(): boolean {
        return this.processor.setupAcesToRec709Display();
    }

    /**
     * Setup ACES2065-1 to P3 D65 display (SDR 100 nits) transform
     */
    setupAcesToP3Display(): boolean {
        return this.processor.setupAcesToP3Display();
    }

    /**
     * Setup ACES2065-1 to Rec.2100 PQ HDR display transform
     * Output is in PQ (ST.2084) encoded values for HDR displays.
     *
     * @param peakLuminance Peak luminance (500, 1000, 2000, or 4000 nits)
     * @param limitingPrimaries Limiting primaries: 0 = P3 D65, 1 = Rec.2020
     */
    setupAcesToRec2100PQ(peakLuminance: 500 | 1000 | 2000 | 4000 = 1000, limitingPrimaries: 0 | 1 = 0): boolean {
        return this.processor.setupAcesToRec2100PQ(peakLuminance, limitingPrimaries);
    }

    /**
     * Setup ACES2065-1 to Rec.2100 HLG HDR display transform
     * Output is in HLG encoded values for HDR displays.
     * Fixed at 1000 nits with P3 D65 limiting primaries.
     */
    setupAcesToRec2100HLG(): boolean {
        return this.processor.setupAcesToRec2100HLG();
    }

    /**
     * Setup ACES2065-1 to ST2084 P3 D65 display transform
     * Output is in PQ (ST.2084) encoded values for P3 HDR displays.
     *
     * @param peakLuminance Peak luminance (108, 500, 1000, 2000, or 4000 nits)
     */
    setupAcesToST2084P3(peakLuminance: 108 | 500 | 1000 | 2000 | 4000 = 1000): boolean {
        return this.processor.setupAcesToST2084P3(peakLuminance);
    }

    // =====================
    // Inverse transforms (display → ACES)
    // =====================

    /**
     * Create an inverse display view transform (display → ACES)
     * The inverse takes display-encoded output and converts back to ACES2065-1.
     */
    createInverseDisplayTransform(src: string, display: string, view: string): boolean {
        return this.processor.createInverseDisplayTransform(src, display, view);
    }

    /**
     * Setup sRGB display to ACES inverse transform
     * Converts sRGB display output back to ACES2065-1
     */
    setupSrgbDisplayToAces(): boolean {
        return this.processor.setupSrgbDisplayToAces();
    }

    /**
     * Setup Rec.709 display to ACES inverse transform
     * Converts Rec.709 display output back to ACES2065-1
     */
    setupRec709DisplayToAces(): boolean {
        return this.processor.setupRec709DisplayToAces();
    }

    /**
     * Setup P3 D65 display to ACES inverse transform
     * Converts P3 D65 display output back to ACES2065-1
     */
    setupP3DisplayToAces(): boolean {
        return this.processor.setupP3DisplayToAces();
    }

    /**
     * Setup Rec.2100 PQ HDR to ACES inverse transform
     * Converts PQ-encoded HDR output back to ACES2065-1
     *
     * @param peakLuminance Peak luminance (500, 1000, 2000, or 4000 nits)
     * @param limitingPrimaries Limiting primaries: 0 = P3 D65, 1 = Rec.2020
     */
    setupRec2100PQToAces(peakLuminance: 500 | 1000 | 2000 | 4000 = 1000, limitingPrimaries: 0 | 1 = 0): boolean {
        return this.processor.setupRec2100PQToAces(peakLuminance, limitingPrimaries);
    }

    /**
     * Setup Rec.2100 HLG to ACES inverse transform
     * Converts HLG-encoded HDR output back to ACES2065-1
     */
    setupRec2100HLGToAces(): boolean {
        return this.processor.setupRec2100HLGToAces();
    }

    /**
     * Setup ACES 2.0 Reference Gamut Compression (RGC) transform
     * This compresses out-of-gamut colors (with negative AP1 components) into the AP1 gamut.
     *
     * @param peakLuminance Peak luminance in nits (100 for SDR, 1000+ for HDR)
     * @param inverse If true, apply inverse (decompress) instead of forward (compress)
     */
    setupACES2GamutCompress(peakLuminance: number = 100, inverse: boolean = false): boolean {
        return this.processor.setupACES2GamutCompress(peakLuminance, inverse);
    }

    /**
     * Apply ACES 2.0 RGC to RGB data (AP1 linear input/output)
     * The input data should be in AP1 linear (ACEScg) color space.
     * The output will also be in AP1 linear but with out-of-gamut colors compressed.
     *
     * @param data RGB Float32 data (AP1 linear)
     * @param peakLuminance Peak luminance in nits
     * @param inverse If true, decompress instead of compress
     */
    applyACES2GamutCompress(data: Float32Array, peakLuminance: number = 100, inverse: boolean = false): boolean {
        const numPixels = Math.floor(data.length / 3);
        if (numPixels === 0) {
            return false;
        }

        const byteLength = data.byteLength;
        const ptr = this.module._malloc(byteLength);

        try {
            // Copy data to WASM memory
            // Note: Get HEAPF32 reference before each operation as it may be invalidated by memory growth
            const floatOffset = ptr / 4;

            // Get fresh heap reference and copy data
            let heapF32 = this.module.HEAPF32;
            for (let i = 0; i < data.length; i++) {
                heapF32[floatOffset + i] = data[i];
            }

            // Apply RGC
            const success = this.processor.applyACES2GamutCompressRGB(ptr, numPixels, peakLuminance, inverse);

            if (success) {
                // Get fresh HEAPF32 reference after WASM call (memory may have grown)
                heapF32 = this.module.HEAPF32;

                // Copy result back
                for (let i = 0; i < data.length; i++) {
                    data[i] = heapF32[floatOffset + i];
                }
            }

            return success;
        } finally {
            this.module._free(ptr);
        }
    }

    /**
     * Get last error message
     */
    getLastError(): string {
        return this.processor.getLastError();
    }

    /**
     * Check if a transform is configured
     */
    hasTransform(): boolean {
        return this.processor.hasTransform();
    }

    /**
     * Get config description
     */
    getConfigDescription(): string {
        return this.processor.getConfigDescription();
    }

    /**
     * Setup GPU processor (required before extractGpuShaderInfo)
     */
    setupGpuProcessor(): boolean {
        return this.processor.setupGpuProcessor();
    }

    /**
     * Extract GPU shader info for WebGL rendering
     */
    extractGpuShaderInfo(): GpuShaderInfo {
        return this.processor.extractGpuShaderInfo();
    }

    /**
     * Clean up resources
     */
    dispose(): void {
        this.processor.delete();
    }
}

/**
 * Extract ACES 2.0 Reference Gamut Compression GLSL shader info
 *
 * Convenience function that creates a processor, extracts RGC shader, and cleans up.
 *
 * @param peakLuminance Peak luminance in nits (100 for SDR, 1000+ for HDR)
 */
export function extractRgcShaderInfo(peakLuminance: number = 100): RgcShaderInfo {
    if (!ocioModule) {
        return {
            glsl: '',
            textures: [],
            textures3D: [],
            success: false,
            error: 'OCIO not initialized',
        };
    }

    const processor = new ocioModule.OCIOProcessor();

    try {
        // Initialize with built-in config
        if (!processor.initBuiltinConfig('')) {
            return {
                glsl: '',
                textures: [],
                textures3D: [],
                success: false,
                error: `Failed to init OCIO: ${processor.getLastError()}`,
            };
        }

        // Setup ACES 2.0 RGC transform
        if (!processor.setupACES2GamutCompress(peakLuminance, false)) {
            return {
                glsl: '',
                textures: [],
                textures3D: [],
                success: false,
                error: `Failed to setup RGC: ${processor.getLastError()}`,
            };
        }

        // Setup GPU processor
        if (!processor.setupGpuProcessor()) {
            return {
                glsl: '',
                textures: [],
                textures3D: [],
                success: false,
                error: `Failed to setup GPU processor: ${processor.getLastError()}`,
            };
        }

        // Extract GPU shader info
        const shaderInfo = processor.extractGpuShaderInfo();

        // Deep-copy texture data from WASM memory before processor.delete() frees it.
        // The Float32Arrays returned by extractGpuShaderInfo() are views into WASM heap;
        // after processor.delete(), that memory is freed and may be reused.
        return {
            glsl: shaderInfo.shaderText,
            textures: shaderInfo.textures.map((t: GpuTexture) => ({
                ...t,
                data: Array.from(t.data),
            })),
            textures3D: shaderInfo.textures3D.map((t: GpuTexture3D) => ({
                ...t,
                data: Array.from(t.data),
            })),
            success: true,
        };
    } catch (err) {
        return {
            glsl: '',
            textures: [],
            textures3D: [],
            success: false,
            error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
        };
    } finally {
        processor.delete();
    }
}

// Singleton processor instance
let processorInstance: OCIOProcessor | null = null;

/**
 * Get the singleton OCIOProcessor instance
 */
export function getOCIOProcessor(): OCIOProcessor {
    if (!processorInstance) {
        processorInstance = new OCIOProcessor();
    }
    return processorInstance;
}

/**
 * Create a pre-configured ACES to sRGB display processor
 */
export async function createAcesToSrgbProcessor(): Promise<OCIOProcessor> {
    await initOCIO();
    const processor = new OCIOProcessor();

    if (!processor.init()) {
        throw new Error(`Failed to init OCIO: ${processor.getLastError()}`);
    }

    if (!processor.setupAcesToSrgbDisplay()) {
        throw new Error(`Failed to setup transform: ${processor.getLastError()}`);
    }

    return processor;
}

/**
 * Create a processor with custom display transform
 */
export async function createDisplayProcessor(
    srcColorSpace: string,
    display: string,
    view: string,
    configName: string = ''
): Promise<OCIOProcessor> {
    await initOCIO();
    const processor = new OCIOProcessor();

    if (!processor.init(configName)) {
        throw new Error(`Failed to init OCIO: ${processor.getLastError()}`);
    }

    if (!processor.createDisplayTransform(srcColorSpace, display, view)) {
        throw new Error(`Failed to create display transform: ${processor.getLastError()}`);
    }

    return processor;
}

// VS Code compatibility alias
/**
 * Set the WASM directory path (alias for setOcioWasmPath)
 * @deprecated Use setOcioWasmPath instead
 */
export const setWasmDirectory = setOcioWasmPath;
