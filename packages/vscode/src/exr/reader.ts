/**
 * OpenEXR Reader
 *
 * High-level TypeScript wrapper for reading EXR files via WASM.
 */

import type { OpenEXRModule } from '../../../../wasm/openexr_wasm';
import type { Chromaticities } from '../plugins/types';
import { useWasmMemorySync } from '@dctl-workbench/core';

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

    constructor(module: OpenEXRModule) {
        this.module = module;
    }

    /**
     * Read an EXR file from binary data
     */
    read(data: Uint8Array, options?: EXRReaderOptions): EXRImageData {
        this.cleanup();

        return useWasmMemorySync(this.module, data.length, (inputBlock) => {
            // Copy file bytes into the WASM heap
            inputBlock.write(data);

            // Create read context
            this.contextId = this.module._exr_wasm_create_read_context(
                inputBlock.ptr,
                data.length
            );
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
        });
    }

    /**
     * Get image dimensions
     */
    private getDimensions(): { width: number; height: number } {
        // Two i32 outputs in a single 8-byte block: [width, height]
        return useWasmMemorySync(this.module, 8, (block) => {
            const widthPtr = block.ptr;
            const heightPtr = block.ptr + 4;
            const result = this.module._exr_wasm_get_dimensions(
                this.contextId,
                widthPtr,
                heightPtr
            );
            if (result !== 0) {
                throw this.createError('Failed to get dimensions');
            }
            return {
                width: block.readInt32(0),
                height: block.readInt32(4),
            };
        });
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

        return useWasmMemorySync(this.module, byteSize, (block) => {
            const result = this.module._exr_wasm_read_pixels(this.contextId, block.ptr);
            if (result !== 0) {
                throw this.createError('Failed to read pixels');
            }
            // Defensive copy from WASM heap into a JS-owned Float32Array
            return block.readFloat32(pixelCount);
        });
    }

    /**
     * Get chromaticities if present
     */
    private getChromaticities(): Chromaticities | undefined {
        // 8 floats: redX, redY, greenX, greenY, blueX, blueY, whiteX, whiteY
        return useWasmMemorySync(this.module, 8 * 4, (block) => {
            const result = this.module._exr_wasm_get_chromaticities(this.contextId, block.ptr);
            if (result !== 0) {
                // Chromaticities not present
                return undefined;
            }
            const values = block.readFloat32(8);
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
        });
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
