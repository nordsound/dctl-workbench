/**
 * EXR Module
 *
 * Provides OpenEXR reading and writing functionality via WASM.
 *
 * @example
 * ```typescript
 * import OpenEXR from '../wasm/openexr';
 * import { EXRReader, EXRWriter, ACES_CHROMATICITIES, Compression } from './exr';
 *
 * // Initialize WASM module
 * const module = await OpenEXR();
 *
 * // Read an EXR file
 * const reader = new EXRReader(module);
 * const imageData = reader.read(exrFileData);
 * console.log(`${imageData.width}x${imageData.height}, ${imageData.channels.length} channels`);
 * reader.dispose();
 *
 * // Write an EXR file
 * const writer = new EXRWriter(module);
 * const exrData = writer.write(pixels, width, height, 3, {
 *     compression: Compression.ZIP,
 *     chromaticities: ACES_CHROMATICITIES,
 *     adoptedNeutral: true
 * });
 * writer.dispose();
 * ```
 */

// Module cache
export {
    initOpenEXR,
    getOpenEXRModule,
    isOpenEXRInitialized,
    setOpenEXRWasmDirectory,
} from './module';

// Reader
export { EXRReader, EXRPixelType } from './reader';
export type { EXRChannel, EXRImageData, EXRReaderOptions } from './reader';

// Writer
export { EXRWriter, Compression, PixelType } from './writer';
export type { EXRWriterOptions } from './writer';

// Metadata
export {
    // ACES
    ACES_CHROMATICITIES,
    ACESCG_CHROMATICITIES,
    // Standard color spaces
    SRGB_CHROMATICITIES,
    REC2020_CHROMATICITIES,
    DCI_P3_CHROMATICITIES,
    DISPLAY_P3_CHROMATICITIES,
    ADOBE_RGB_CHROMATICITIES,
    PROPHOTO_RGB_CHROMATICITIES,
    // White points
    D50_WHITE_POINT,
    D55_WHITE_POINT,
    D60_WHITE_POINT,
    D65_WHITE_POINT,
    DCI_WHITE_POINT,
    // Utilities
    chromaticitiesEqual,
    identifyColorSpace,
    getChromaticities,
    xyToXYZ,
    calculateRGBtoXYZMatrix,
} from './metadata';
export type { KnownColorSpace } from './metadata';
