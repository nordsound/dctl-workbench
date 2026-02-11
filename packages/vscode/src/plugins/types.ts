/**
 * dctl-workbench Plugin Types
 *
 * This file defines the interfaces for input and demosaic plugins.
 * Plugin extensions should implement these interfaces to integrate
 * with dctl-workbench.
 */

// =============================================================================
// License Types
// =============================================================================

export type LicenseType =
    | 'MIT'
    | 'BSD-3-Clause'
    | 'Apache-2.0'
    | 'LGPL-2.1'
    | 'LGPL-3.0'
    | 'CDDL-1.0'
    | 'GPL-3.0'
    | 'PublicDomain';

// =============================================================================
// Image Data Types
// =============================================================================

/**
 * CFA (Color Filter Array) pattern for Bayer sensors
 */
export type CFAPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';

/**
 * Chromaticities for color space definition
 */
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

/**
 * Image metadata extracted from files
 */
export interface ImageMetadata {
    // Camera information
    make?: string;
    model?: string;
    iso?: number;
    shutter?: number;
    aperture?: number;
    focalLength?: number;
    timestamp?: Date;

    // RAW specific
    cfaPattern?: CFAPattern;
    whiteBalance?: [number, number, number];
    colorMatrix?: number[][];
    blackLevel?: number[];
    whiteLevel?: number;

    // DNG specific
    forwardMatrix1?: number[][];
    forwardMatrix2?: number[][];
    colorMatrix1?: number[][];
    colorMatrix2?: number[][];
    calibrationIlluminant1?: number;
    calibrationIlluminant2?: number;

    // EXR specific
    chromaticities?: Chromaticities;
    whiteLuminance?: number;
}

/**
 * Raw image data structure
 */
export interface RawImageData {
    /** Bayer RAW data (before demosaic) */
    bayerData?: Uint16Array;

    /** RGB data (after demosaic or non-RAW) */
    rgbData?: Float32Array;

    /** Image width in pixels */
    width: number;

    /** Image height in pixels */
    height: number;

    /** Bits per sample (typically 12, 14, or 16 for RAW) */
    bitsPerSample: number;

    /** CFA pattern (for Bayer data) */
    cfaPattern?: CFAPattern;

    /** Number of channels (1 for Bayer, 3 for RGB, 4 for RGBA) */
    channels: number;
}

// =============================================================================
// Input Plugin
// =============================================================================

/**
 * Processing options for input plugins
 */
export interface ProcessOptions {
    /** Output half size image */
    halfSize?: boolean;

    /** Apply auto white balance */
    autoWhiteBalance?: boolean;

    /** Use camera white balance if available */
    useCameraWhiteBalance?: boolean;
}

/**
 * Input plugin interface for loading image files
 */
export interface InputPlugin {
    /** Unique plugin identifier */
    readonly id: string;

    /** Human-readable plugin name */
    readonly name: string;

    /** Plugin version */
    readonly version: string;

    /** License type */
    readonly license: LicenseType;

    /** Supported file extensions (lowercase, without dot) */
    readonly supportedExtensions: string[];

    /**
     * Check if this plugin can handle the given file
     * @param extension File extension (lowercase, without dot)
     * @param data Optional file data for magic number detection
     */
    canHandle(extension: string, data?: Uint8Array): boolean;

    /**
     * Load file data
     * @param data Raw file data
     */
    load(data: Uint8Array): Promise<void>;

    /**
     * Get processed image data
     * @param options Processing options
     */
    getImageData(options?: ProcessOptions): Promise<RawImageData>;

    /**
     * Get image metadata
     */
    getMetadata(): ImageMetadata;

    /**
     * Release resources
     */
    dispose(): void;
}

// =============================================================================
// Demosaic Plugin
// =============================================================================

/**
 * Demosaic quality level
 */
export type DemosaicQuality = 'fast' | 'balanced' | 'high' | 'highest';

/**
 * Demosaic processing options
 */
export interface DemosaicOptions {
    /** Output half size image */
    halfSize?: boolean;

    /** Noise reduction threshold */
    noiseThreshold?: number;

    /** Progress callback */
    onProgress?: (percent: number) => void;
}

/**
 * Demosaic plugin interface for Bayer pattern interpolation
 */
export interface DemosaicPlugin {
    /** Unique plugin identifier */
    readonly id: string;

    /** Human-readable plugin name */
    readonly name: string;

    /** Plugin version */
    readonly version: string;

    /** License type */
    readonly license: LicenseType;

    /** Quality level of this algorithm */
    readonly quality: DemosaicQuality;

    /** Supported CFA patterns */
    readonly supportedPatterns: CFAPattern[];

    /**
     * Perform demosaic processing
     * @param bayerData Raw Bayer data
     * @param width Image width
     * @param height Image height
     * @param pattern CFA pattern
     * @param options Processing options
     * @returns RGB data as Float32Array (3 channels, interleaved)
     */
    demosaic(
        bayerData: Uint16Array,
        width: number,
        height: number,
        pattern: CFAPattern,
        options?: DemosaicOptions
    ): Promise<Float32Array>;

    /** Whether this plugin supports cancellation */
    readonly cancellable: boolean;

    /** Cancel ongoing processing */
    cancel?(): void;
}

// =============================================================================
// Plugin API (exposed by dctl-workbench)
// =============================================================================

/**
 * API exposed by dctl-workbench for plugin registration
 */
export interface DctlWorkbenchApi {
    /**
     * Register an input plugin
     */
    registerInputPlugin(plugin: InputPlugin): void;

    /**
     * Unregister an input plugin
     */
    unregisterInputPlugin(id: string): boolean;

    /**
     * Register a demosaic plugin
     */
    registerDemosaicPlugin(plugin: DemosaicPlugin): void;

    /**
     * Unregister a demosaic plugin
     */
    unregisterDemosaicPlugin(id: string): boolean;

    /**
     * Get the current API version
     */
    readonly apiVersion: string;
}
