/**
 * OpenEXR Writer
 *
 * High-level TypeScript wrapper for writing EXR files via WASM.
 */

import type { OpenEXRModule } from '../../../../wasm/openexr_wasm';
import type { Chromaticities } from '../plugins/types';

/** Compression types */
export const enum Compression {
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

/** Pixel types */
export const enum PixelType {
    UINT = 0,
    HALF = 1,
    FLOAT = 2,
}

/** Writer options */
export interface EXRWriterOptions {
    /** Compression type (default: ZIP) */
    compression?: Compression;
    /** Chromaticities for color space */
    chromaticities?: Chromaticities;
    /** Set adoptedNeutral attribute for ACES2065-1 */
    adoptedNeutral?: boolean;
    /** Pixel type (default: FLOAT) */
    pixelType?: PixelType;
}

/** Default options */
const DEFAULT_OPTIONS: Required<Omit<EXRWriterOptions, 'chromaticities'>> & {
    chromaticities?: Chromaticities;
} = {
    compression: Compression.PIZ,
    adoptedNeutral: false,
    pixelType: PixelType.HALF,
};

/**
 * EXR Writer class
 *
 * Usage:
 * ```typescript
 * const writer = new EXRWriter(wasmModule);
 * const exrData = writer.write(pixels, width, height, 3, {
 *     compression: Compression.ZIP,
 *     chromaticities: ACES_CHROMATICITIES
 * });
 * writer.dispose();
 * ```
 */
export class EXRWriter {
    private module: OpenEXRModule;
    private contextId: number = -1;

    constructor(module: OpenEXRModule) {
        this.module = module;
    }

    /**
     * Write interleaved RGB or RGBA data to EXR format
     *
     * @param pixels Interleaved pixel data (RGBRGB... or RGBARGBA...)
     * @param width Image width in pixels
     * @param height Image height in pixels
     * @param channels Number of channels (3 for RGB, 4 for RGBA)
     * @param options Writer options
     * @returns EXR file data as Uint8Array
     */
    write(
        pixels: Float32Array,
        width: number,
        height: number,
        channels: 3 | 4,
        options?: EXRWriterOptions
    ): Uint8Array {
        this.cleanup();

        const opts = { ...DEFAULT_OPTIONS, ...options };

        // Validate input
        const expectedSize = width * height * channels;
        if (pixels.length !== expectedSize) {
            throw new Error(
                `Invalid pixel data size: expected ${expectedSize}, got ${pixels.length}`
            );
        }

        // Create write context
        this.contextId = this.module._exr_wasm_create_write_context(width, height);
        if (this.contextId < 0) {
            throw this.createError('Failed to create write context');
        }

        try {
            // Add channels
            this.addChannels(channels, opts.pixelType);

            // Set compression
            const compResult = this.module._exr_wasm_set_compression(
                this.contextId,
                opts.compression
            );
            if (compResult !== 0) {
                throw this.createError('Failed to set compression');
            }

            // Set chromaticities if specified
            if (opts.chromaticities) {
                this.setChromaticities(opts.chromaticities);
            }

            // Set adopted neutral if specified
            if (opts.adoptedNeutral) {
                const neutralResult = this.module._exr_wasm_set_adopt_neutral(
                    this.contextId,
                    1
                );
                if (neutralResult !== 0) {
                    throw this.createError('Failed to set adoptedNeutral');
                }
            }

            // Write pixel data
            this.writePixels(pixels, channels);

            // Finalize and get output
            const finalizeResult = this.module._exr_wasm_finalize(this.contextId);
            if (finalizeResult !== 0) {
                throw this.createError('Failed to finalize EXR');
            }

            // Get output data
            return this.getOutput();
        } finally {
            this.cleanup();
        }
    }

    /**
     * Add channels to the context
     */
    private addChannels(numChannels: number, pixelType: PixelType): void {
        const channelNames = numChannels === 4 ? ['R', 'G', 'B', 'A'] : ['R', 'G', 'B'];

        for (const name of channelNames) {
            const namePtr = this.allocateString(name);
            try {
                const result = this.module._exr_wasm_add_channel(
                    this.contextId,
                    namePtr,
                    pixelType,
                    1, // x_sampling
                    1 // y_sampling
                );
                if (result !== 0) {
                    throw this.createError(`Failed to add channel ${name}`);
                }
            } finally {
                this.module._free(namePtr);
            }
        }
    }

    /**
     * Set chromaticities attribute
     */
    private setChromaticities(chroma: Chromaticities): void {
        const result = this.module._exr_wasm_set_chromaticities(
            this.contextId,
            chroma.redX,
            chroma.redY,
            chroma.greenX,
            chroma.greenY,
            chroma.blueX,
            chroma.blueY,
            chroma.whiteX,
            chroma.whiteY
        );
        if (result !== 0) {
            throw this.createError('Failed to set chromaticities');
        }
    }

    /**
     * Write interleaved pixel data
     */
    private writePixels(pixels: Float32Array, numChannels: number): void {
        const byteSize = pixels.length * 4;
        const dataPtr = this.module._malloc(byteSize);

        if (!dataPtr) {
            throw new Error('Failed to allocate memory for pixel data');
        }

        try {
            // Copy to WASM memory
            // Try HEAPF32 first (fast), fall back to setValue (slow but reliable)
            const heapF32 = this.module.HEAPF32;
            if (heapF32) {
                const heapOffset = dataPtr / 4;
                if (heapOffset + pixels.length > heapF32.length) {
                    throw new Error(
                        `HEAPF32 too small: need offset ${heapOffset} + ${pixels.length} = ${heapOffset + pixels.length}, ` +
                        `but HEAPF32.length = ${heapF32.length}`
                    );
                }
                heapF32.set(pixels, heapOffset);
            } else {
                // Fallback: use setValue (slower but works when HEAPF32 is not exposed)
                console.log('[EXRWriter] Using setValue fallback for pixel data transfer');
                for (let i = 0; i < pixels.length; i++) {
                    this.module.setValue(dataPtr + i * 4, pixels[i], 'float');
                }
            }

            const result = this.module._exr_wasm_write_interleaved(
                this.contextId,
                dataPtr,
                numChannels
            );
            if (result !== 0) {
                throw this.createError('Failed to write pixels');
            }
        } finally {
            this.module._free(dataPtr);
        }
    }

    /**
     * Get the output EXR data
     */
    private getOutput(): Uint8Array {
        const outputPtr = this.module._exr_wasm_get_output_ptr(this.contextId);
        const outputSize = this.module._exr_wasm_get_output_size(this.contextId);

        if (!outputPtr || outputSize === 0) {
            throw this.createError('Failed to get output data');
        }

        // Copy from WASM memory
        const output = new Uint8Array(outputSize);
        const heapU8 = this.module.HEAPU8;
        if (heapU8) {
            output.set(heapU8.subarray(outputPtr, outputPtr + outputSize));
        } else {
            // Fallback: use getValue
            for (let i = 0; i < outputSize; i++) {
                output[i] = this.module.getValue(outputPtr + i, 'i8') & 0xff;
            }
        }

        return output;
    }

    /**
     * Allocate a string in WASM memory
     */
    private allocateString(str: string): number {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        const ptr = this.module._malloc(bytes.length + 1);

        if (!ptr) {
            throw new Error('Failed to allocate memory for string');
        }

        const heapU8 = this.module.HEAPU8;
        if (heapU8) {
            heapU8.set(bytes, ptr);
            heapU8[ptr + bytes.length] = 0; // null terminator
        } else {
            // Fallback: use setValue
            for (let i = 0; i < bytes.length; i++) {
                this.module.setValue(ptr + i, bytes[i], 'i8');
            }
            this.module.setValue(ptr + bytes.length, 0, 'i8'); // null terminator
        }

        return ptr;
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
