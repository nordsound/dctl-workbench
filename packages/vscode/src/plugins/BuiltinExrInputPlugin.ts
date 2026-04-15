/**
 * Built-in EXR input plugin for dctl-workbench.
 *
 * Wraps the existing OpenEXR WASM reader as an InputPlugin so that the
 * core viewer pipeline can treat EXR like any other image format.
 *
 * Created in A1/S8 as part of the ImageViewerCore refactoring.
 */

import { EXRReader, identifyColorSpace, initOpenEXR, setOpenEXRWasmDirectory } from '../exr';
import type { InputPlugin, DecodedImage, ImageMetadata, ProcessOptions, Chromaticities } from './types';
import { findWasmDir } from '../editor/wasm-utils';

export class BuiltinExrInputPlugin implements InputPlugin {
    readonly id = 'nordsound.builtin-exr';
    readonly name = 'Built-in EXR Reader';
    readonly version = '0.1.0';
    readonly license = 'MIT';
    readonly supportedExtensions = ['exr'] as const;

    private extensionPath: string;
    private parsedData: {
        width: number;
        height: number;
        channels: string[];
        pixels: Float32Array;
        chromaticities?: Chromaticities;
        compressionName?: string;
        pixelTypeName?: string;
    } | null = null;

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
    }

    async init(): Promise<void> {
        // Set the WASM directory once — initOpenEXR() caches with validation internally
        setOpenEXRWasmDirectory(findWasmDir(this.extensionPath));
    }

    canHandle(extension: string): boolean {
        return extension.toLowerCase() === 'exr';
    }

    async load(data: Uint8Array): Promise<void> {
        this.parsedData = null; // Release previous data before new allocation

        // Always resolve the module fresh — initOpenEXR() has internal caching with
        // HEAP-view validation. Caching the module reference at the plugin level
        // would hold a stale instance across export operations (initOpenEXR(true)).
        setOpenEXRWasmDirectory(findWasmDir(this.extensionPath));
        const exrModule = await initOpenEXR();

        const reader = new EXRReader(exrModule);
        try {
            const imageData = reader.read(data);
            if (!imageData.pixels || !(imageData.pixels instanceof Float32Array)) {
                throw new Error(`EXRReader returned invalid pixels: ${typeof imageData.pixels}`);
            }
            this.parsedData = {
                width: imageData.width,
                height: imageData.height,
                channels: imageData.channels.map((ch: any) => ch.name || ch),
                pixels: imageData.pixels,
                chromaticities: imageData.chromaticities,
                compressionName: imageData.compressionName,
                pixelTypeName: imageData.pixelTypeName,
            };
        } finally {
            reader.dispose();
        }
    }

    async getImageData(_options?: ProcessOptions): Promise<DecodedImage> {
        if (!this.parsedData) {
            throw new Error('No data loaded. Call load() first.');
        }

        const { width, height, channels, pixels } = this.parsedData;
        const srcChannels = channels.length;

        // Sanity check: pixels buffer must match declared dimensions
        const expectedLength = width * height * srcChannels;
        if (pixels.length !== expectedLength) {
            throw new Error(
                `Pixel buffer size mismatch: expected ${expectedLength} ` +
                `(${width}x${height}x${srcChannels}), got ${pixels.length}`
            );
        }

        // OpenEXR stores channels alphabetically, so the source interleave is
        // typically A,B,G,R (4ch) or B,G,R (3ch). Locate each named channel
        // by index so we can emit a canonical RGBA-order buffer, independent
        // of what order the file happened to list channels.
        const idxR = channels.indexOf('R');
        const idxG = channels.indexOf('G');
        const idxB = channels.indexOf('B');
        const idxA = channels.indexOf('A');
        const rgbaPixels = new Float32Array(width * height * 4);

        for (let i = 0; i < width * height; i++) {
            const base = i * srcChannels;
            rgbaPixels[i * 4]     = idxR >= 0 ? pixels[base + idxR] : 0;
            rgbaPixels[i * 4 + 1] = idxG >= 0 ? pixels[base + idxG] : 0;
            rgbaPixels[i * 4 + 2] = idxB >= 0 ? pixels[base + idxB] : 0;
            rgbaPixels[i * 4 + 3] = idxA >= 0 ? pixels[base + idxA] : 1.0;
        }

        // Identify OCIO color space from chromaticities
        let colorSpace = 'sRGB - Texture';
        if (this.parsedData.chromaticities) {
            const identified = identifyColorSpace(this.parsedData.chromaticities);
            if (identified !== 'unknown') {
                const ocioNameMap: Record<string, string> = {
                    'ACES2065-1': 'ACES2065-1',
                    'ACEScg': 'ACEScg',
                    'sRGB': 'sRGB - Texture',
                    'Rec.709': 'sRGB - Texture',
                    'Rec.2020': 'Rec.2020 (OETF)',
                    'DCI-P3': 'P3-D65',
                    'Display P3': 'P3-D65',
                };
                colorSpace = ocioNameMap[identified] || identified;
            }
        }

        // Determine bits per sample from EXR pixel type
        const bitsPerSample = this.parsedData.pixelTypeName === 'HALF' ? 16 : 32;

        return {
            pixels: rgbaPixels,
            pixelFormat: 'rgba32float',
            width,
            height,
            channels: 4,
            bitsPerSample,
            colorSpace,
        };
    }

    getMetadata(): ImageMetadata {
        if (!this.parsedData) {
            return {};
        }

        return {
            chromaticities: this.parsedData.chromaticities,
        };
    }

    dispose(): void {
        this.parsedData = null;
    }
}
