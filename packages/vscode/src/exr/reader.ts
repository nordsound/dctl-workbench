/**
 * OpenEXR Reader
 *
 * High-level TypeScript wrapper for reading EXR files via WASM.
 */

import type { OpenEXRModule } from '../../../../wasm/openexr_wasm';
import type { Chromaticities } from '../plugins/types';

/** EXR Compression types (matches OpenEXR enum) */
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

/** Compression type names for display */
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

/** Pixel type names for display */
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

/** EXR image data */
export interface EXRImageData {
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
    /** Channel information */
    channels: EXRChannel[];
    /** Pixel data as interleaved float array */
    pixels: Float32Array;
    /** Chromaticities if present */
    chromaticities?: Chromaticities;
    /** Compression type */
    compression?: EXRCompression;
    /** Compression name for display */
    compressionName?: string;
    /** Pixel type name for display (e.g., "16-bit half") */
    pixelTypeName?: string;
}

/** Reader options */
export interface EXRReaderOptions {
    /** Channel names to read (default: all) */
    channels?: string[];
}

/**
 * EXR Reader class
 *
 * Usage:
 * ```typescript
 * const reader = new EXRReader(wasmModule);
 * const imageData = reader.read(exrFileData);
 * reader.dispose();
 * ```
 */
export class EXRReader {
    private module: OpenEXRModule;
    private contextId: number = -1;
    private heapU8: Uint8Array | null = null;
    private heapF32: Float32Array | null = null;

    constructor(module: OpenEXRModule) {
        this.module = module;
        this.initHeapViews();
    }

    /**
     * Initialize heap views, trying multiple access methods
     */
    private initHeapViews(): void {
        const mod = this.module as any;

        // Try direct HEAP properties first
        if (mod.HEAPU8 instanceof Uint8Array) {
            this.heapU8 = mod.HEAPU8;
        }
        if (mod.HEAPF32 instanceof Float32Array) {
            this.heapF32 = mod.HEAPF32;
        }

        // If not available, try to get from wasmMemory or asm.memory
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
                if (!this.heapU8) {
                    this.heapU8 = new Uint8Array(buffer);
                }
                if (!this.heapF32) {
                    this.heapF32 = new Float32Array(buffer);
                }
            }
        }
    }

    /**
     * Get HEAPU8 view, refreshing if needed
     */
    private getHeapU8(): Uint8Array {
        if (!this.heapU8) {
            this.initHeapViews();
        }
        if (!this.heapU8) {
            throw new Error('Cannot access WASM HEAPU8 memory');
        }
        return this.heapU8;
    }

    /**
     * Get HEAPF32 view, refreshing if needed
     */
    private getHeapF32(): Float32Array {
        if (!this.heapF32) {
            this.initHeapViews();
        }
        if (!this.heapF32) {
            throw new Error('Cannot access WASM HEAPF32 memory');
        }
        return this.heapF32;
    }

    /**
     * Copy data to WASM memory using setValue as fallback
     */
    private copyToWasm(data: Uint8Array, ptr: number): void {
        try {
            const heap = this.getHeapU8();
            heap.set(data, ptr);
        } catch {
            // Fallback to setValue (slower but always works)
            for (let i = 0; i < data.length; i++) {
                this.module.setValue(ptr + i, data[i], 'i8');
            }
        }
    }

    /**
     * Read float array from WASM memory using getValue as fallback
     */
    private readFloatsFromWasm(ptr: number, count: number): Float32Array {
        const result = new Float32Array(count);
        try {
            const heap = this.getHeapF32();
            const offset = ptr / 4;
            result.set(heap.subarray(offset, offset + count));
        } catch {
            // Fallback to getValue (slower but always works)
            for (let i = 0; i < count; i++) {
                result[i] = this.module.getValue(ptr + i * 4, 'float');
            }
        }
        return result;
    }

    /**
     * Read an EXR file from binary data
     */
    read(data: Uint8Array, options?: EXRReaderOptions): EXRImageData {
        this.cleanup();

        // Allocate memory for input data
        const inputPtr = this.module._malloc(data.length);
        if (!inputPtr) {
            throw new Error('Failed to allocate memory for EXR data');
        }

        try {
            // Copy data to WASM memory
            this.copyToWasm(data, inputPtr);

            // Create read context
            this.contextId = this.module._exr_wasm_create_read_context(inputPtr, data.length);
            if (this.contextId < 0) {
                throw this.createError('Failed to create read context');
            }

            // Get dimensions
            const dimensions = this.getDimensions();

            // Get channels
            const allChannels = this.getChannels();

            // Filter channels if specified
            const channelsToRead = options?.channels
                ? allChannels.filter((ch) => options.channels!.includes(ch.name))
                : allChannels;

            if (channelsToRead.length === 0) {
                throw new Error('No channels to read');
            }

            // Read pixel data
            const pixels = this.readPixels(
                dimensions.width,
                dimensions.height,
                allChannels.length
            );

            // Get chromaticities if present
            const chromaticities = this.getChromaticities();

            // Get compression
            const compression = this.getCompression();
            const compressionName = EXR_COMPRESSION_NAMES[compression] || 'unknown';

            // Get pixel type name from first channel
            const firstChannelPixelType = channelsToRead[0]?.pixelType;
            const pixelTypeName = firstChannelPixelType !== undefined
                ? EXR_PIXEL_TYPE_NAMES[firstChannelPixelType] || 'unknown'
                : undefined;

            return {
                ...dimensions,
                channels: channelsToRead,
                pixels,
                chromaticities,
                compression,
                compressionName,
                pixelTypeName,
            };
        } finally {
            this.module._free(inputPtr);
        }
    }

    /**
     * Get image dimensions
     */
    private getDimensions(): { width: number; height: number } {
        const widthPtr = this.module._malloc(4);
        const heightPtr = this.module._malloc(4);

        try {
            const result = this.module._exr_wasm_get_dimensions(
                this.contextId,
                widthPtr,
                heightPtr
            );
            if (result !== 0) {
                throw this.createError('Failed to get dimensions');
            }

            return {
                width: this.module.getValue(widthPtr, 'i32'),
                height: this.module.getValue(heightPtr, 'i32'),
            };
        } finally {
            this.module._free(widthPtr);
            this.module._free(heightPtr);
        }
    }

    /**
     * Get channel information
     */
    private getChannels(): EXRChannel[] {
        const count = this.module._exr_wasm_get_channel_count(this.contextId);
        if (count < 0) {
            throw this.createError('Failed to get channel count');
        }

        const channels: EXRChannel[] = [];
        for (let i = 0; i < count; i++) {
            const namePtr = this.module._exr_wasm_get_channel_name(this.contextId, i);
            if (namePtr) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const pixelType = (this.module as any)._exr_wasm_get_channel_pixel_type?.(this.contextId, i);
                channels.push({
                    name: this.module.UTF8ToString(namePtr),
                    index: i,
                    pixelType: pixelType >= 0 ? pixelType : undefined,
                });
            }
        }

        return channels;
    }

    /**
     * Read pixel data
     */
    private readPixels(
        width: number,
        height: number,
        numChannels: number
    ): Float32Array {
        const pixelCount = width * height * numChannels;
        const byteSize = pixelCount * 4; // sizeof(float)
        const outputPtr = this.module._malloc(byteSize);

        if (!outputPtr) {
            throw new Error('Failed to allocate memory for pixel data');
        }

        try {
            const result = this.module._exr_wasm_read_pixels(this.contextId, outputPtr);
            if (result !== 0) {
                throw this.createError('Failed to read pixels');
            }

            // Copy from WASM memory
            return this.readFloatsFromWasm(outputPtr, pixelCount);
        } finally {
            this.module._free(outputPtr);
        }
    }

    /**
     * Get chromaticities if present
     */
    private getChromaticities(): Chromaticities | undefined {
        // 8 floats: redX, redY, greenX, greenY, blueX, blueY, whiteX, whiteY
        const chromaPtr = this.module._malloc(8 * 4);

        try {
            const result = this.module._exr_wasm_get_chromaticities(this.contextId, chromaPtr);
            if (result !== 0) {
                // Chromaticities not present
                return undefined;
            }

            const values = this.readFloatsFromWasm(chromaPtr, 8);

            return {
                redX: values[0],
                redY: values[1],
                greenX: values[2],
                greenY: values[3],
                blueX: values[4],
                blueY: values[5],
                whiteX: values[6],
                whiteY: values[7],
            };
        } finally {
            this.module._free(chromaPtr);
        }
    }

    /**
     * Get compression type
     */
    private getCompression(): EXRCompression {
        return this.module._exr_wasm_get_compression(this.contextId) as EXRCompression;
    }

    /**
     * Create an error with the last error message from WASM
     */
    private createError(defaultMessage: string): Error {
        const errorPtr = this.module._exr_wasm_get_last_error();
        const errorMessage = errorPtr
            ? this.module.UTF8ToString(errorPtr)
            : defaultMessage;
        this.module._exr_wasm_clear_error();
        return new Error(errorMessage);
    }

    /**
     * Cleanup the current context
     */
    private cleanup(): void {
        if (this.contextId >= 0) {
            this.module._exr_wasm_destroy_context(this.contextId);
            this.contextId = -1;
        }
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.cleanup();
    }
}
