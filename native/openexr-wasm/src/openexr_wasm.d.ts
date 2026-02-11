/**
 * OpenEXR WASM Module Type Definitions
 */

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
    DWAB = 9
}

/** Pixel types */
export const enum PixelType {
    UINT = 0,
    HALF = 1,
    FLOAT = 2
}

/** Chromaticities for color space definition */
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

/** ACES2065-1 chromaticities */
export const ACES_CHROMATICITIES: Chromaticities = {
    redX: 0.7347,
    redY: 0.2653,
    greenX: 0.0,
    greenY: 1.0,
    blueX: 0.0001,
    blueY: -0.077,
    whiteX: 0.32168,
    whiteY: 0.33767
};

/** sRGB/Rec.709 chromaticities */
export const SRGB_CHROMATICITIES: Chromaticities = {
    redX: 0.64,
    redY: 0.33,
    greenX: 0.3,
    greenY: 0.6,
    blueX: 0.15,
    blueY: 0.06,
    whiteX: 0.3127,
    whiteY: 0.329
};

/** Emscripten module interface */
export interface OpenEXRModule extends EmscriptenModule {
    // Memory
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAPU8: Uint8Array;
    HEAPF32: Float32Array;

    // Initialization
    _exr_wasm_init(): number;
    _exr_wasm_version(): number;

    // Write API
    _exr_wasm_create_write_context(width: number, height: number): number;
    _exr_wasm_add_channel(
        ctxId: number,
        namePtr: number,
        pixelType: number,
        xSampling: number,
        ySampling: number
    ): number;
    _exr_wasm_set_compression(ctxId: number, compression: number): number;
    _exr_wasm_set_chromaticities(
        ctxId: number,
        redX: number, redY: number,
        greenX: number, greenY: number,
        blueX: number, blueY: number,
        whiteX: number, whiteY: number
    ): number;
    _exr_wasm_set_adopt_neutral(ctxId: number, value: number): number;
    _exr_wasm_write_pixels(
        ctxId: number,
        dataPtr: number,
        startY: number,
        numLines: number
    ): number;
    _exr_wasm_write_interleaved(
        ctxId: number,
        dataPtr: number,
        numChannels: number
    ): number;
    _exr_wasm_finalize(ctxId: number): number;
    _exr_wasm_get_output_ptr(ctxId: number): number;
    _exr_wasm_get_output_size(ctxId: number): number;
    _exr_wasm_destroy_context(ctxId: number): void;

    // Read API
    _exr_wasm_create_read_context(dataPtr: number, size: number): number;
    _exr_wasm_get_dimensions(ctxId: number, widthPtr: number, heightPtr: number): number;
    _exr_wasm_get_channel_count(ctxId: number): number;
    _exr_wasm_get_channel_name(ctxId: number, index: number): number;
    _exr_wasm_read_pixels(ctxId: number, outputPtr: number): number;
    _exr_wasm_get_chromaticities(ctxId: number, chromaPtr: number): number;
    _exr_wasm_get_compression(ctxId: number): number;

    // Utility
    _exr_wasm_get_last_error(): number;
    _exr_wasm_clear_error(): void;
    _exr_wasm_get_memory_stats(allocatedPtr: number, peakPtr: number): void;

    // Runtime methods
    ccall<T>(
        ident: string,
        returnType: string | null,
        argTypes: string[],
        args: any[]
    ): T;
    cwrap<T extends (...args: any[]) => any>(
        ident: string,
        returnType: string | null,
        argTypes: string[]
    ): T;
    UTF8ToString(ptr: number): string;
    stringToUTF8(str: string, ptr: number, maxLength: number): void;
    getValue(ptr: number, type: string): number;
    setValue(ptr: number, value: number, type: string): void;
}

/** Factory function type */
export type OpenEXRModuleFactory = (
    moduleOverrides?: Partial<OpenEXRModule>
) => Promise<OpenEXRModule>;

/** Default export is the module factory */
declare const OpenEXR: OpenEXRModuleFactory;
export default OpenEXR;
