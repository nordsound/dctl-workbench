/**
 * dctl-workbench Plugin Types
 *
 * Public type definitions for input plugins that extend dctl-workbench
 * with new image formats (e.g., camera RAW, AVIF, JPEG XL).
 *
 * Plugin developers should consult docs/PLUGIN_DEVELOPMENT.md for usage,
 * the lifecycle contract, and the memory ownership rules.
 *
 * API stability: Pre-Release. Breaking changes may occur until 1.0.0.
 */

import type * as vscode from 'vscode';

// =============================================================================
// API Version
// =============================================================================

/** Current plugin API version (SemVer). */
export const PLUGIN_API_VERSION = '0.4.0' as const;

/**
 * Check whether a host's API version is compatible with the version a plugin
 * requires. Returns true when major versions match and the actual minor is
 * greater than or equal to the required minor.
 *
 * @example
 *   isCompatibleApiVersion('0.2.0', '0.2.5') // → true
 *   isCompatibleApiVersion('0.2.0', '0.3.0') // → true
 *   isCompatibleApiVersion('0.2.0', '0.1.9') // → false
 *   isCompatibleApiVersion('0.2.0', '1.0.0') // → false
 */
export function isCompatibleApiVersion(required: string, actual: string): boolean {
    const [reqMajor, reqMinor] = required.split('.').map(Number);
    const [actMajor, actMinor] = actual.split('.').map(Number);
    if (reqMajor !== actMajor) return false;
    return actMinor >= reqMinor;
}

// =============================================================================
// License Types
// =============================================================================

/**
 * SPDX license identifier (https://spdx.org/licenses/).
 *
 * Plugins should set this to the strictest license that applies to any
 * bundled third-party library. Common values include 'MIT', 'BSD-3-Clause',
 * 'Apache-2.0', 'LGPL-2.1', 'CDDL-1.0', 'MPL-2.0'.
 */
export type LicenseType = string;

// =============================================================================
// Pixel Format
// =============================================================================

/**
 * GPU-friendly pixel format that an InputPlugin returns from getImageData().
 *
 * - 'rgba16unorm': 4x uint16 per pixel, GPU normalizes to [0, 1] on sampling.
 *   The fastest path on WebGPU (Tier 1). Half the memory of float32.
 * - 'rgba32float': 4x float32 per pixel, normalized to [0, 1].
 *   Used for the WebGL2 fallback (Tier 2) and EXR (which is float32 natively).
 * - 'bayer16': Single-channel uint16, raw Bayer mosaic. Requires a
 *   DemosaicPlugin to convert to RGB. (Not yet wired into the rendering
 *   pipeline as of 0.2.0.)
 */
export type PixelFormat = 'rgba16unorm' | 'rgba32float' | 'bayer16';

// =============================================================================
// CFA Pattern
// =============================================================================

/** CFA (Color Filter Array) pattern for Bayer sensors. */
export type CFAPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';

// =============================================================================
// Chromaticities
// =============================================================================

/** Chromaticities for color space definition (CIE xy coordinates). */
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

// =============================================================================
// Image Metadata
// =============================================================================

/**
 * Image metadata extracted from a file. All fields are optional. Plugins
 * populate the fields that apply to their format.
 */
export interface ImageMetadata {
    // --- Camera information ---
    make?: string;
    model?: string;
    iso?: number;
    /** Exposure time in seconds. */
    shutter?: number;
    aperture?: number;
    focalLength?: number;
    timestamp?: Date;

    // --- RAW-specific ---
    cfaPattern?: CFAPattern;
    /** Per-channel white balance multipliers (R, G, B). */
    whiteBalance?: [number, number, number];
    /** Camera native RGB → XYZ matrix (3x3 or 3x4). */
    colorMatrix?: number[][];
    blackLevel?: number[];
    whiteLevel?: number;

    // --- DNG-specific ---
    forwardMatrix1?: number[][];
    forwardMatrix2?: number[][];
    colorMatrix1?: number[][];
    colorMatrix2?: number[][];
    /** Standard EXIF illuminant code (1=Daylight, 17=Standard A, 21=D65, ...). */
    calibrationIlluminant1?: number;
    calibrationIlluminant2?: number;

    // --- EXR-specific ---
    chromaticities?: Chromaticities;
    whiteLuminance?: number;
}

// =============================================================================
// Decoded Image
// =============================================================================

/**
 * Decoded image data ready for GPU upload. Returned by InputPlugin.getImageData().
 *
 * IMPORTANT — Memory ownership contract:
 *
 * The `pixels` field MUST be a JavaScript-owned TypedArray. It must NOT be a
 * view into a WebAssembly heap. The host transfers `pixels.buffer` to the
 * webview using a transferable postMessage, which would detach a WASM heap
 * view and crash subsequent WASM calls.
 *
 * Plugins that decode in WASM should make a defensive copy:
 *
 *     const view = new Uint16Array(module.HEAPU16.buffer, ptr, count);
 *     const owned = new Uint16Array(view);  // copies once
 *     module._free(ptr);
 *     return { pixels: owned, ... };
 *
 * See docs/PLUGIN_DEVELOPMENT.md §7 for the full contract.
 */
export interface DecodedImage {
    /**
     * Pixel data, JS-owned (NOT a WASM heap view).
     * Element type matches `pixelFormat`:
     *  - 'rgba16unorm' → Uint16Array (4x uint16 per pixel, [0, 65535])
     *  - 'rgba32float' → Float32Array (4x float32 per pixel, normalized [0, 1])
     *  - 'bayer16'     → Uint16Array (1x uint16 per pixel, raw mosaic)
     */
    pixels: Uint16Array | Float32Array;

    /** GPU-friendly pixel format. Determines how the host uploads the data. */
    pixelFormat: PixelFormat;

    /** Image width in pixels. */
    width: number;

    /** Image height in pixels. */
    height: number;

    /**
     * Number of channels. For 'rgba16unorm' and 'rgba32float' this is always 4.
     * For 'bayer16' this is 1.
     */
    channels: number;

    /**
     * Bits per sample of the SOURCE data (e.g., 14 for typical camera RAW).
     * Informational only — the actual element width comes from `pixels.constructor`.
     */
    bitsPerSample: number;

    /**
     * OCIO color space name. The host uses this as the input color space for
     * the OCIO display transform pipeline. Examples: 'ACES2065-1',
     * 'sRGB - Texture', 'ACEScg', 'Linear Rec.709'.
     */
    colorSpace: string;

    /** Bayer mosaic pattern (only set when `pixelFormat === 'bayer16'`). */
    cfaPattern?: CFAPattern;

    /**
     * Optional 3×3 matrix applied to each pixel's RGB channels on the GPU
     * before the OCIO display transform. Row-major.
     *
     * Use this to encode a color-space conversion (camera RGB → ACES,
     * XYZ → ACES, etc.) that the host can run as a single matrix multiply
     * in a compute shader, avoiding any CPU-side conversion loop.
     *
     * Semantics:
     *  - undefined or omitted → host treats the pixel data as already in
     *    `colorSpace` and skips the pre-transform pass.
     *  - present              → host applies `out = M * in.rgb` (alpha
     *    preserved) and treats the result as `colorSpace`.
     *
     * Available since plugin API 0.3.0.
     */
    preTransformMatrix?: readonly [
        readonly [number, number, number],
        readonly [number, number, number],
        readonly [number, number, number]
    ];
}

// =============================================================================
// Process Options
// =============================================================================

/**
 * Options passed to InputPlugin.getImageData(). All fields are optional and
 * plugins should fall back to sensible defaults.
 */
export interface ProcessOptions {
    /** Output at half resolution. Useful for fast preview. */
    halfSize?: boolean;

    /** Compute auto white balance instead of camera WB. */
    autoWhiteBalance?: boolean;

    /** Use the camera's recorded white balance (default: true for camera RAW). */
    useCameraWhiteBalance?: boolean;

    /**
     * Requested output pixel format. Plugins should respect this if possible.
     *
     * The host passes this based on the active renderer mode:
     *  - WebGPU (Tier 1, default) → 'rgba16unorm'
     *  - WebGL2 fallback (Tier 2) → 'rgba32float'
     *
     * If a plugin can only produce one format, it should return that format
     * regardless and the host will convert (slow path) if necessary.
     */
    outputFormat?: PixelFormat;
}

// =============================================================================
// Plugin Error
// =============================================================================

/**
 * Standardized error codes that plugins can use to signal failure modes.
 * The host uses these to choose an appropriate user-facing message.
 */
export type PluginErrorCode =
    | 'INVALID_FILE'
    | 'UNSUPPORTED_FORMAT'
    | 'UNSUPPORTED_CAMERA'
    | 'DECODE_ERROR'
    | 'OUT_OF_MEMORY'
    | 'NOT_INITIALIZED'
    | 'UNKNOWN';

/**
 * Typed error class for plugin failures. Using PluginError instead of plain
 * Error lets the host display a more appropriate UI based on the error code.
 *
 * Plain Error subclasses are also accepted; they are treated as 'UNKNOWN'.
 */
export class PluginError extends Error {
    public readonly code: PluginErrorCode;
    public readonly cause?: Error;

    constructor(code: PluginErrorCode, message: string, cause?: Error) {
        super(message);
        this.name = 'PluginError';
        this.code = code;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

// =============================================================================
// Input Plugin
// =============================================================================

/**
 * Input plugin interface for loading image files.
 *
 * Lifecycle (called by the host in this order):
 *  1. constructor()             — plugin is created
 *  2. init?()                   — optional async setup (load WASM, etc.)
 *  3. registerInputPlugin(this) — host stores the instance
 *  4. canHandle(extension)      — cheap sync check on each file open
 *  5. load(data)                — async, may be called many times
 *  6. getImageData(options?)    — async, may be called multiple times after load
 *  7. getMetadata()             — sync, must be available after load
 *  8. dispose()                 — release resources at end of lifetime
 *
 * See docs/PLUGIN_DEVELOPMENT.md for the full contract and examples.
 */
export interface InputPlugin {
    /**
     * Globally unique plugin identifier.
     * Recommended format: `<publisher>.<plugin-name>` (e.g., `nordsound.libraw`).
     */
    readonly id: string;

    /** Human-readable plugin name. */
    readonly name: string;

    /** Plugin version (SemVer). Not the API version. */
    readonly version: string;

    /** SPDX license identifier of the plugin (and its bundled libraries). */
    readonly license: LicenseType;

    /** Supported file extensions (lowercase, without dot). */
    readonly supportedExtensions: readonly string[];

    /**
     * Optional one-time initialization (e.g., load a WASM module). Called by
     * the host once after the plugin is constructed and before
     * registerInputPlugin(). Safe to omit if the plugin needs no setup.
     */
    init?(): Promise<void>;

    /**
     * Check whether this plugin can handle the given file. Should be a cheap
     * synchronous check. The host currently does not pass `data`, but future
     * versions may pass the first few KB for magic-byte detection.
     */
    canHandle(extension: string, data?: Uint8Array): boolean;

    /**
     * Load file data. May be called multiple times on the same instance; each
     * call replaces the previous loaded state.
     *
     * @throws {PluginError} on failure (or any Error subclass — plain Error is
     *   treated as PluginError with code 'UNKNOWN' by the host).
     */
    load(data: Uint8Array): Promise<void>;

    /**
     * Get processed image data. Must be called after load() has resolved.
     * May be called multiple times after a single load() (e.g., to re-decode
     * with a different outputFormat).
     *
     * @throws {PluginError} on failure.
     */
    getImageData(options?: ProcessOptions): Promise<DecodedImage>;

    /**
     * Get image metadata. Must be available immediately after load() returns.
     * Synchronous.
     */
    getMetadata(): ImageMetadata;

    /**
     * Release all resources held by this plugin instance. Called once at the
     * end of the plugin's lifetime. After dispose, no other method will be
     * called.
     */
    dispose(): void;
}

// =============================================================================
// Demosaic Plugin
// =============================================================================

/**
 * Demosaic quality level. Used by DemosaicPlugin.quality.
 *
 * Note: As of 0.2.0, DemosaicPlugin is defined but not yet wired into the
 * rendering pipeline. It will become useful when the host adds a Bayer
 * compute shader path.
 */
export type DemosaicQuality = 'fast' | 'balanced' | 'high' | 'highest';

/** Demosaic processing options. */
export interface DemosaicOptions {
    halfSize?: boolean;
    noiseThreshold?: number;
    onProgress?: (percent: number) => void;
}

/**
 * Demosaic plugin interface for Bayer pattern interpolation.
 *
 * Note: As of 0.2.0, this interface is defined but not yet consumed by the
 * host's rendering pipeline. Plugins implementing it can register, but the
 * host will not call demosaic() until the Bayer compute shader path lands.
 */
export interface DemosaicPlugin {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly license: LicenseType;
    readonly quality: DemosaicQuality;
    readonly supportedPatterns: readonly CFAPattern[];

    demosaic(
        bayerData: Uint16Array,
        width: number,
        height: number,
        pattern: CFAPattern,
        options?: DemosaicOptions
    ): Promise<Float32Array>;

    readonly cancellable: boolean;
    cancel?(): void;
}

// =============================================================================
// Plugin API (exposed by dctl-workbench host)
// =============================================================================

/**
 * The API exposed by the dctl-workbench host extension's `activate()` return
 * value. Plugin extensions retrieve this via:
 *
 *     const host = vscode.extensions.getExtension('nordsound.dctl-workbench');
 *     const api = await host?.activate() as DctlWorkbenchApi;
 */
export interface DctlWorkbenchApi {
    /**
     * Register an input plugin with the host. Returns true on success, false
     * if a plugin with the same id is already registered.
     */
    registerInputPlugin(plugin: InputPlugin): boolean;

    /**
     * Unregister a previously registered input plugin. Returns true if a
     * plugin was removed, false if no plugin with that id was registered.
     * The host will call the plugin's dispose() before removing it.
     */
    unregisterInputPlugin(id: string): boolean;

    /**
     * Register a demosaic plugin. Returns true on success, false on duplicate.
     * (Demosaic plugins are accepted but not yet consumed as of API 0.2.0.)
     */
    registerDemosaicPlugin(plugin: DemosaicPlugin): boolean;

    /** Unregister a demosaic plugin. */
    unregisterDemosaicPlugin(id: string): boolean;

    /** Plugin API version (SemVer). */
    readonly apiVersion: string;

    /**
     * URI of the host extension's installation directory.
     *
     * Plugins that declare their own `customEditors` contribution create
     * their own `WebviewPanel`s. Such panels need the host's install dir in
     * `localResourceRoots` at creation time so the renderer can load host
     * assets (scripts, CSS, WASM) via `panel.webview.asWebviewUri(...)`.
     *
     * `localResourceRoots` is effectively immutable after the panel is
     * created, which is why the plugin must get this Uri before creating
     * the panel rather than having the host set it post-hoc.
     *
     * Available since plugin API 0.4.0.
     */
    readonly extensionUri: vscode.Uri;

    /**
     * Render an image into a plugin-owned `WebviewPanel` using the host's
     * renderer. The plugin keeps ownership of the panel (it created the
     * custom-editor tab); the host drives HTML generation, message
     * routing, and the display-transform pipeline.
     *
     * Preconditions:
     *  - The plugin is registered via `registerInputPlugin(plugin)`.
     *  - `panel.webview.options.localResourceRoots` contains the host's
     *    `out`, `wasm`, and `media` subfolders (derived from
     *    `extensionUri`). Missing roots cause the webview to refuse to
     *    load the host's scripts.
     *
     * Lifecycle:
     *  - The returned `Disposable` must be disposed when the panel is
     *    disposed. It releases file watchers, message listeners, and any
     *    per-panel GPU state the host held. Typical pattern:
     *
     *        const disposable = await api.renderImage(panel, uri, plugin);
     *        panel.onDidDispose(() => disposable.dispose());
     *
     * @param panel       The plugin's custom-editor WebviewPanel.
     * @param documentUri The URI of the image file being opened.
     * @param plugin      The `InputPlugin` that can decode `documentUri`.
     *                    Must already be registered; passed here so the
     *                    host doesn't need a second registry lookup.
     * @returns A Disposable that cleans up host-side listeners and state.
     *
     * Available since plugin API 0.4.0.
     */
    renderImage(
        panel: vscode.WebviewPanel,
        documentUri: vscode.Uri,
        plugin: InputPlugin,
    ): Promise<vscode.Disposable>;
}
