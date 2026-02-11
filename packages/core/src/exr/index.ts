/**
 * EXR Module
 *
 * High-level TypeScript wrapper for reading and writing EXR files via WASM.
 */

import * as path from 'path';
import * as fs from 'fs';

// =============================================================================
// Types
// =============================================================================

/** EXR Compression types */
export const enum EXRCompression {
    NONE = 0,
    RLE = 1,
    ZIPS = 2,
    ZIP = 3,
    PIZ = 4,
    PXR24 = 5,
    B44 = 6,
    B44A = 7,
    DWAA = 8,
    DWAB = 9,
}

/** Compression type names */
export const EXR_COMPRESSION_NAMES: Record<number, string> = {
    [EXRCompression.NONE]: 'none',
    [EXRCompression.RLE]: 'rle',
    [EXRCompression.ZIPS]: 'zips',
    [EXRCompression.ZIP]: 'zip',
    [EXRCompression.PIZ]: 'piz',
    [EXRCompression.PXR24]: 'pxr24',
    [EXRCompression.B44]: 'b44',
    [EXRCompression.B44A]: 'b44a',
    [EXRCompression.DWAA]: 'dwaa',
    [EXRCompression.DWAB]: 'dwab',
};

/** Pixel types */
export enum EXRPixelType {
    UINT = 0,
    HALF = 1,
    FLOAT = 2,
}

/** Pixel type names */
const EXR_PIXEL_TYPE_NAMES: Record<number, string> = {
    [EXRPixelType.UINT]: '32-bit uint',
    [EXRPixelType.HALF]: '16-bit half',
    [EXRPixelType.FLOAT]: '32-bit float',
};

/** Channel information */
export interface EXRChannel {
    name: string;
    index: number;
    pixelType?: EXRPixelType;
}

/** Chromaticities */
export interface Chromaticities {
    redX: number;
    redY: number;
    greenX: number;
    greenY: number;
    blueX: number;
    blueY: number;
    whiteX: number;
    whiteY: number;
}

/** EXR image data */
export interface EXRImageData {
    width: number;
    height: number;
    channels: EXRChannel[];
    pixels: Float32Array;
    chromaticities?: Chromaticities;
    compression?: EXRCompression;
    compressionName?: string;
    pixelTypeName?: string;
}

/** Reader options */
export interface EXRReaderOptions {
    channels?: string[];
}

/** Writer options */
export interface EXRWriterOptions {
    compression?: EXRCompression;
    chromaticities?: Chromaticities;
    adoptedNeutral?: boolean;
    pixelType?: EXRPixelType;
}

// WASM module type
interface OpenEXRModule {
    _malloc(size: number): number;
    _free(ptr: number): void;
    setValue(ptr: number, value: number, type: string): void;
    getValue(ptr: number, type: string): number;
    UTF8ToString(ptr: number): string;
    HEAPU8?: Uint8Array;
    HEAPF32?: Float32Array;
    wasmMemory?: { buffer: ArrayBuffer };
    asm?: { memory?: { buffer: ArrayBuffer } };
    buffer?: ArrayBuffer;

    _exr_wasm_create_read_context(dataPtr: number, dataSize: number): number;
    _exr_wasm_create_write_context(width: number, height: number): number;
    _exr_wasm_destroy_context(contextId: number): void;
    _exr_wasm_get_dimensions(contextId: number, widthPtr: number, heightPtr: number): number;
    _exr_wasm_get_channel_count(contextId: number): number;
    _exr_wasm_get_channel_name(contextId: number, index: number): number;
    _exr_wasm_get_channel_pixel_type?(contextId: number, index: number): number;
    _exr_wasm_read_pixels(contextId: number, outputPtr: number): number;
    _exr_wasm_get_chromaticities(contextId: number, chromaPtr: number): number;
    _exr_wasm_get_compression(contextId: number): number;
    _exr_wasm_add_channel(contextId: number, namePtr: number, pixelType: number, xSampling: number, ySampling: number): number;
    _exr_wasm_set_compression(contextId: number, compression: number): number;
    _exr_wasm_set_chromaticities(contextId: number, rX: number, rY: number, gX: number, gY: number, bX: number, bY: number, wX: number, wY: number): number;
    _exr_wasm_set_adopt_neutral(contextId: number, value: number): number;
    _exr_wasm_write_interleaved(contextId: number, dataPtr: number, numChannels: number): number;
    _exr_wasm_finalize(contextId: number): number;
    _exr_wasm_get_output_ptr(contextId: number): number;
    _exr_wasm_get_output_size(contextId: number): number;
    _exr_wasm_get_last_error(): number;
    _exr_wasm_clear_error(): void;
}

// =============================================================================
// EXR Module Class
// =============================================================================

/**
 * EXR Module - handles reading and writing EXR files
 */
export class EXRModule {
    private module: OpenEXRModule | null = null;
    private initPromise: Promise<void> | null = null;
    private heapU8: Uint8Array | null = null;
    private heapF32: Float32Array | null = null;

    /**
     * Initialize the OpenEXR WASM module
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
            { js: path.join(basePath, 'wasm', 'openexr.js'), wasm: path.join(basePath, 'wasm', 'openexr.wasm') },
            { js: path.join(basePath, 'out', 'wasm', 'openexr.js'), wasm: path.join(basePath, 'out', 'wasm', 'openexr.wasm') },
            { js: path.join(basePath, 'openexr.js'), wasm: path.join(basePath, 'openexr.wasm') },
        ];

        let jsPath = '';
        let wasmPath = '';
        for (const testPath of possiblePaths) {
            if (fs.existsSync(testPath.js) && fs.existsSync(testPath.wasm)) {
                jsPath = testPath.js;
                wasmPath = testPath.wasm;
                break;
            }
        }

        if (!jsPath || !wasmPath) {
            throw new Error(`OpenEXR WASM not found in any of: ${possiblePaths.map(p => p.js).join(', ')}`);
        }

        // Read WASM binary directly to avoid Emscripten fetch issues in Node.js
        const wasmBinary = fs.readFileSync(wasmPath);

        // Load the Emscripten module factory
        const openexrModule = await import(jsPath);
        const createOpenEXR = openexrModule.default;

        // Create a new module instance with wasmBinary
        this.module = await createOpenEXR({
            wasmBinary,
        }) as OpenEXRModule;

        this.initHeapViews();
    }

    /**
     * Check if initialized
     */
    get isInitialized(): boolean {
        return this.module !== null;
    }

    /**
     * Initialize heap views
     */
    private initHeapViews(): void {
        if (!this.module) return;

        const mod = this.module as any;

        if (mod.HEAPU8 instanceof Uint8Array) {
            this.heapU8 = mod.HEAPU8;
        }
        if (mod.HEAPF32 instanceof Float32Array) {
            this.heapF32 = mod.HEAPF32;
        }

        if (!this.heapU8 || !this.heapF32) {
            let buffer: ArrayBuffer | null = null;

            if (mod.wasmMemory?.buffer) {
                buffer = mod.wasmMemory.buffer;
            } else if (mod.asm?.memory?.buffer) {
                buffer = mod.asm.memory.buffer;
            } else if (mod.buffer) {
                buffer = mod.buffer;
            }

            if (buffer) {
                if (!this.heapU8) this.heapU8 = new Uint8Array(buffer);
                if (!this.heapF32) this.heapF32 = new Float32Array(buffer);
            }
        }
    }

    private getHeapU8(): Uint8Array {
        if (!this.heapU8) this.initHeapViews();
        if (!this.heapU8) throw new Error('Cannot access WASM HEAPU8 memory');
        return this.heapU8;
    }

    private getHeapF32(): Float32Array {
        if (!this.heapF32) this.initHeapViews();
        if (!this.heapF32) throw new Error('Cannot access WASM HEAPF32 memory');
        return this.heapF32;
    }

    private copyToWasm(data: Uint8Array, ptr: number): void {
        try {
            const heap = this.getHeapU8();
            heap.set(data, ptr);
        } catch {
            for (let i = 0; i < data.length; i++) {
                this.module!.setValue(ptr + i, data[i], 'i8');
            }
        }
    }

    private readFloatsFromWasm(ptr: number, count: number): Float32Array {
        const result = new Float32Array(count);
        try {
            const heap = this.getHeapF32();
            const offset = ptr / 4;
            result.set(heap.subarray(offset, offset + count));
        } catch {
            for (let i = 0; i < count; i++) {
                result[i] = this.module!.getValue(ptr + i * 4, 'float');
            }
        }
        return result;
    }

    private createError(defaultMessage: string): Error {
        const errorPtr = this.module!._exr_wasm_get_last_error();
        const errorMessage = errorPtr
            ? this.module!.UTF8ToString(errorPtr)
            : defaultMessage;
        this.module!._exr_wasm_clear_error();
        return new Error(errorMessage);
    }

    private allocateString(str: string): number {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        const ptr = this.module!._malloc(bytes.length + 1);

        if (!ptr) throw new Error('Failed to allocate memory for string');

        const heapU8 = this.module!.HEAPU8;
        if (heapU8) {
            heapU8.set(bytes, ptr);
            heapU8[ptr + bytes.length] = 0;
        } else {
            for (let i = 0; i < bytes.length; i++) {
                this.module!.setValue(ptr + i, bytes[i], 'i8');
            }
            this.module!.setValue(ptr + bytes.length, 0, 'i8');
        }

        return ptr;
    }

    // =========================================================================
    // Reading
    // =========================================================================

    /**
     * Read an EXR file from binary data
     */
    read(data: Uint8Array, options?: EXRReaderOptions): EXRImageData {
        if (!this.module) throw new Error('EXR module not initialized');

        const inputPtr = this.module._malloc(data.length);
        if (!inputPtr) throw new Error('Failed to allocate memory for EXR data');

        let contextId = -1;

        try {
            this.copyToWasm(data, inputPtr);

            contextId = this.module._exr_wasm_create_read_context(inputPtr, data.length);
            if (contextId < 0) throw this.createError('Failed to create read context');

            // Get dimensions
            const widthPtr = this.module._malloc(4);
            const heightPtr = this.module._malloc(4);

            try {
                const dimResult = this.module._exr_wasm_get_dimensions(contextId, widthPtr, heightPtr);
                if (dimResult !== 0) throw this.createError('Failed to get dimensions');

                const width = this.module.getValue(widthPtr, 'i32');
                const height = this.module.getValue(heightPtr, 'i32');

                // Get channels
                const channelCount = this.module._exr_wasm_get_channel_count(contextId);
                if (channelCount < 0) throw this.createError('Failed to get channel count');

                const allChannels: EXRChannel[] = [];
                for (let i = 0; i < channelCount; i++) {
                    const namePtr = this.module._exr_wasm_get_channel_name(contextId, i);
                    if (namePtr) {
                        const pixelType = this.module._exr_wasm_get_channel_pixel_type?.(contextId, i);
                        allChannels.push({
                            name: this.module.UTF8ToString(namePtr),
                            index: i,
                            pixelType: pixelType !== undefined && pixelType >= 0 ? pixelType : undefined,
                        });
                    }
                }

                const channelsToRead = options?.channels
                    ? allChannels.filter(ch => options.channels!.includes(ch.name))
                    : allChannels;

                if (channelsToRead.length === 0) throw new Error('No channels to read');

                // Read pixels
                const pixelCount = width * height * allChannels.length;
                const byteSize = pixelCount * 4;
                const outputPtr = this.module._malloc(byteSize);

                if (!outputPtr) throw new Error('Failed to allocate memory for pixel data');

                try {
                    const readResult = this.module._exr_wasm_read_pixels(contextId, outputPtr);
                    if (readResult !== 0) throw this.createError('Failed to read pixels');

                    const pixels = this.readFloatsFromWasm(outputPtr, pixelCount);

                    // Get chromaticities
                    let chromaticities: Chromaticities | undefined;
                    const chromaPtr = this.module._malloc(8 * 4);
                    try {
                        const chromaResult = this.module._exr_wasm_get_chromaticities(contextId, chromaPtr);
                        if (chromaResult === 0) {
                            const values = this.readFloatsFromWasm(chromaPtr, 8);
                            chromaticities = {
                                redX: values[0], redY: values[1],
                                greenX: values[2], greenY: values[3],
                                blueX: values[4], blueY: values[5],
                                whiteX: values[6], whiteY: values[7],
                            };
                        }
                    } finally {
                        this.module._free(chromaPtr);
                    }

                    // Get compression
                    const compression = this.module._exr_wasm_get_compression(contextId) as EXRCompression;
                    const compressionName = EXR_COMPRESSION_NAMES[compression] || 'unknown';

                    const firstChannelPixelType = channelsToRead[0]?.pixelType;
                    const pixelTypeName = firstChannelPixelType !== undefined
                        ? EXR_PIXEL_TYPE_NAMES[firstChannelPixelType] || 'unknown'
                        : undefined;

                    return {
                        width,
                        height,
                        channels: channelsToRead,
                        pixels,
                        chromaticities,
                        compression,
                        compressionName,
                        pixelTypeName,
                    };
                } finally {
                    this.module._free(outputPtr);
                }
            } finally {
                this.module._free(widthPtr);
                this.module._free(heightPtr);
            }
        } finally {
            if (contextId >= 0) {
                this.module._exr_wasm_destroy_context(contextId);
            }
            this.module._free(inputPtr);
        }
    }

    /**
     * Read an EXR file from path
     */
    async readFile(filePath: string, options?: EXRReaderOptions): Promise<EXRImageData> {
        const data = await fs.promises.readFile(filePath);
        return this.read(new Uint8Array(data), options);
    }

    /**
     * Read an EXR file from path (sync)
     */
    readFileSync(filePath: string, options?: EXRReaderOptions): EXRImageData {
        const data = fs.readFileSync(filePath);
        return this.read(new Uint8Array(data), options);
    }

    // =========================================================================
    // Writing
    // =========================================================================

    /**
     * Write interleaved RGB or RGBA data to EXR format
     */
    write(
        pixels: Float32Array,
        width: number,
        height: number,
        channels: 3 | 4,
        options?: EXRWriterOptions
    ): Uint8Array {
        if (!this.module) throw new Error('EXR module not initialized');

        const opts = {
            compression: EXRCompression.PIZ,
            adoptedNeutral: false,
            pixelType: EXRPixelType.HALF,
            ...options,
        };

        const expectedSize = width * height * channels;
        if (pixels.length !== expectedSize) {
            throw new Error(`Invalid pixel data size: expected ${expectedSize}, got ${pixels.length}`);
        }

        const contextId = this.module._exr_wasm_create_write_context(width, height);
        if (contextId < 0) throw this.createError('Failed to create write context');

        try {
            // Add channels
            const channelNames = channels === 4 ? ['R', 'G', 'B', 'A'] : ['R', 'G', 'B'];
            for (const name of channelNames) {
                const namePtr = this.allocateString(name);
                try {
                    const result = this.module._exr_wasm_add_channel(
                        contextId, namePtr, opts.pixelType, 1, 1
                    );
                    if (result !== 0) throw this.createError(`Failed to add channel ${name}`);
                } finally {
                    this.module._free(namePtr);
                }
            }

            // Set compression
            const compResult = this.module._exr_wasm_set_compression(contextId, opts.compression);
            if (compResult !== 0) throw this.createError('Failed to set compression');

            // Set chromaticities
            if (opts.chromaticities) {
                const c = opts.chromaticities;
                const result = this.module._exr_wasm_set_chromaticities(
                    contextId, c.redX, c.redY, c.greenX, c.greenY, c.blueX, c.blueY, c.whiteX, c.whiteY
                );
                if (result !== 0) throw this.createError('Failed to set chromaticities');
            }

            // Set adopted neutral
            if (opts.adoptedNeutral) {
                const neutralResult = this.module._exr_wasm_set_adopt_neutral(contextId, 1);
                if (neutralResult !== 0) throw this.createError('Failed to set adoptedNeutral');
            }

            // Write pixel data
            const byteSize = pixels.length * 4;
            const dataPtr = this.module._malloc(byteSize);
            if (!dataPtr) throw new Error('Failed to allocate memory for pixel data');

            try {
                const heapF32 = this.module.HEAPF32;
                if (heapF32) {
                    const heapOffset = dataPtr / 4;
                    heapF32.set(pixels, heapOffset);
                } else {
                    for (let i = 0; i < pixels.length; i++) {
                        this.module.setValue(dataPtr + i * 4, pixels[i], 'float');
                    }
                }

                const writeResult = this.module._exr_wasm_write_interleaved(contextId, dataPtr, channels);
                if (writeResult !== 0) throw this.createError('Failed to write pixels');
            } finally {
                this.module._free(dataPtr);
            }

            // Finalize
            const finalizeResult = this.module._exr_wasm_finalize(contextId);
            if (finalizeResult !== 0) throw this.createError('Failed to finalize EXR');

            // Get output
            const outputPtr = this.module._exr_wasm_get_output_ptr(contextId);
            const outputSize = this.module._exr_wasm_get_output_size(contextId);

            if (!outputPtr || outputSize === 0) throw this.createError('Failed to get output data');

            const output = new Uint8Array(outputSize);
            const heapU8 = this.module.HEAPU8;
            if (heapU8) {
                output.set(heapU8.subarray(outputPtr, outputPtr + outputSize));
            } else {
                for (let i = 0; i < outputSize; i++) {
                    output[i] = this.module.getValue(outputPtr + i, 'i8') & 0xff;
                }
            }

            return output;
        } finally {
            this.module._exr_wasm_destroy_context(contextId);
        }
    }

    /**
     * Write EXR data to file
     */
    async writeFile(
        filePath: string,
        pixels: Float32Array,
        width: number,
        height: number,
        channels: 3 | 4,
        options?: EXRWriterOptions
    ): Promise<void> {
        const data = this.write(pixels, width, height, channels, options);
        await fs.promises.writeFile(filePath, data);
    }

    /**
     * Write EXR data to file (sync)
     */
    writeFileSync(
        filePath: string,
        pixels: Float32Array,
        width: number,
        height: number,
        channels: 3 | 4,
        options?: EXRWriterOptions
    ): void {
        const data = this.write(pixels, width, height, channels, options);
        fs.writeFileSync(filePath, data);
    }
}

// Singleton instance
let exrModuleInstance: EXRModule | null = null;

/**
 * Get the singleton EXRModule instance
 */
export function getEXRModule(): EXRModule {
    if (!exrModuleInstance) {
        exrModuleInstance = new EXRModule();
    }
    return exrModuleInstance;
}

// =============================================================================
// Standard Chromaticities
// =============================================================================

/** ACES AP0 chromaticities */
export const ACES_AP0_CHROMATICITIES: Chromaticities = {
    redX: 0.7347, redY: 0.2653,
    greenX: 0.0, greenY: 1.0,
    blueX: 0.0001, blueY: -0.077,
    whiteX: 0.32168, whiteY: 0.33767,
};

/** ACES AP1 chromaticities */
export const ACES_AP1_CHROMATICITIES: Chromaticities = {
    redX: 0.713, redY: 0.293,
    greenX: 0.165, greenY: 0.830,
    blueX: 0.128, blueY: 0.044,
    whiteX: 0.32168, whiteY: 0.33767,
};

/** sRGB/Rec.709 chromaticities */
export const SRGB_CHROMATICITIES: Chromaticities = {
    redX: 0.64, redY: 0.33,
    greenX: 0.30, greenY: 0.60,
    blueX: 0.15, blueY: 0.06,
    whiteX: 0.3127, whiteY: 0.3290,
};
