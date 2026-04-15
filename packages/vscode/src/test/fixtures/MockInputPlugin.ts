/**
 * MockInputPlugin — a minimal InputPlugin used by plugin-lifecycle
 * integration tests. It claims to handle the `.mock` extension and
 * returns a deterministic 2x2 gradient, so tests can verify the
 * host → plugin → webview contract without real image data.
 */

import type {
    InputPlugin,
    DecodedImage,
    ImageMetadata,
    ProcessOptions,
} from '../../plugins/types';

export class MockInputPlugin implements InputPlugin {
    readonly id = 'test.mock-input';
    readonly name = 'Test Mock Input';
    readonly version = '0.1.0';
    readonly license = 'MIT';
    readonly supportedExtensions = ['mock'] as const;

    initCalls = 0;
    loadCalls = 0;
    getImageDataCalls = 0;
    getMetadataCalls = 0;
    disposeCalls = 0;

    private lastLoadedBytes = 0;

    async init(): Promise<void> {
        this.initCalls++;
    }

    canHandle(extension: string): boolean {
        return extension.toLowerCase() === 'mock';
    }

    async load(data: Uint8Array): Promise<void> {
        this.loadCalls++;
        this.lastLoadedBytes = data.byteLength;
    }

    async getImageData(options?: ProcessOptions): Promise<DecodedImage> {
        this.getImageDataCalls++;

        // Honor the host's output-format hint when possible.
        const wantU16 = options?.outputFormat === 'rgba16unorm';
        const w = 2;
        const h = 2;
        if (wantU16) {
            // Cyan / magenta / yellow / white
            const u16 = new Uint16Array([
                    0, 65535, 65535, 65535,    // cyan
                65535,     0, 65535, 65535,    // magenta
                65535, 65535,     0, 65535,    // yellow
                65535, 65535, 65535, 65535,    // white
            ]);
            return {
                pixels: u16,
                pixelFormat: 'rgba16unorm',
                width: w, height: h, channels: 4,
                bitsPerSample: 16,
                colorSpace: 'sRGB - Texture',
            };
        }
        const f32 = new Float32Array([
            0.0, 1.0, 1.0, 1.0,
            1.0, 0.0, 1.0, 1.0,
            1.0, 1.0, 0.0, 1.0,
            1.0, 1.0, 1.0, 1.0,
        ]);
        return {
            pixels: f32,
            pixelFormat: 'rgba32float',
            width: w, height: h, channels: 4,
            bitsPerSample: 32,
            colorSpace: 'sRGB - Texture',
        };
    }

    getMetadata(): ImageMetadata {
        this.getMetadataCalls++;
        return {
            make: 'test',
            model: 'MockInputPlugin',
        };
    }

    dispose(): void {
        this.disposeCalls++;
    }

    /** Expose the byte count from the last load() for assertions. */
    get lastLoadedBytesForTest(): number {
        return this.lastLoadedBytes;
    }
}
