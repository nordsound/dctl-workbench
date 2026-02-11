/**
 * Test Texture Utilities
 *
 * Helper functions for creating test textures and images
 */

import { MockGPUDevice, MockGPUTexture, GPUTextureUsage } from './webgpu-mock';

/**
 * Create a test image with gradient pattern
 * Returns Float32Array in RGBA format
 */
export function createGradientImageData(width: number, height: number): Float32Array {
    const data = new Float32Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            // Create gradient pattern
            data[idx + 0] = x / width;      // R: horizontal gradient
            data[idx + 1] = y / height;     // G: vertical gradient
            data[idx + 2] = 0.5;            // B: constant
            data[idx + 3] = 1.0;            // A: opaque
        }
    }

    return data;
}

/**
 * Create a test image with color checker pattern
 * Based on Macbeth ColorChecker layout
 */
export function createColorCheckerImageData(width: number, height: number): Float32Array {
    const data = new Float32Array(width * height * 4);

    // Simple 6x4 color grid
    const colors = [
        // Row 1: Dark skin, Light skin, Blue sky, Foliage, Blue flower, Bluish green
        [0.4, 0.2, 0.1], [0.7, 0.5, 0.4], [0.2, 0.3, 0.5], [0.2, 0.4, 0.1], [0.4, 0.3, 0.5], [0.3, 0.5, 0.4],
        // Row 2: Orange, Purplish blue, Moderate red, Purple, Yellow green, Orange yellow
        [0.8, 0.4, 0.1], [0.2, 0.2, 0.5], [0.6, 0.2, 0.2], [0.3, 0.1, 0.3], [0.5, 0.6, 0.1], [0.8, 0.6, 0.1],
        // Row 3: Blue, Green, Red, Yellow, Magenta, Cyan
        [0.1, 0.2, 0.6], [0.1, 0.5, 0.1], [0.6, 0.1, 0.1], [0.8, 0.8, 0.1], [0.6, 0.1, 0.5], [0.1, 0.5, 0.6],
        // Row 4: White, Neutral 8, Neutral 6.5, Neutral 5, Neutral 3.5, Black
        [0.9, 0.9, 0.9], [0.6, 0.6, 0.6], [0.4, 0.4, 0.4], [0.3, 0.3, 0.3], [0.15, 0.15, 0.15], [0.05, 0.05, 0.05],
    ];

    const cellWidth = Math.floor(width / 6);
    const cellHeight = Math.floor(height / 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const cellX = Math.min(Math.floor(x / cellWidth), 5);
            const cellY = Math.min(Math.floor(y / cellHeight), 3);
            const colorIdx = cellY * 6 + cellX;
            const color = colors[colorIdx] || [0.5, 0.5, 0.5];

            const idx = (y * width + x) * 4;
            data[idx + 0] = color[0];
            data[idx + 1] = color[1];
            data[idx + 2] = color[2];
            data[idx + 3] = 1.0;
        }
    }

    return data;
}

/**
 * Create a test image with out-of-gamut colors
 * Useful for testing RGC (Reference Gamut Compression)
 */
export function createOutOfGamutImageData(width: number, height: number): Float32Array {
    const data = new Float32Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;

            // Create various out-of-gamut scenarios
            const region = Math.floor((x / width) * 5);

            switch (region) {
                case 0: // Highly saturated red
                    data[idx + 0] = 2.0;
                    data[idx + 1] = -0.5;
                    data[idx + 2] = -0.5;
                    break;
                case 1: // Highly saturated green
                    data[idx + 0] = -0.3;
                    data[idx + 1] = 1.5;
                    data[idx + 2] = -0.3;
                    break;
                case 2: // Highly saturated blue
                    data[idx + 0] = -0.2;
                    data[idx + 1] = -0.2;
                    data[idx + 2] = 1.8;
                    break;
                case 3: // Negative values
                    data[idx + 0] = -0.5;
                    data[idx + 1] = -0.5;
                    data[idx + 2] = 0.5;
                    break;
                case 4: // HDR values
                    data[idx + 0] = 3.0;
                    data[idx + 1] = 2.5;
                    data[idx + 2] = 0.5;
                    break;
            }

            data[idx + 3] = 1.0;
        }
    }

    return data;
}

/**
 * Create a solid color test image
 */
export function createSolidColorImageData(
    width: number,
    height: number,
    r: number,
    g: number,
    b: number,
    a: number = 1.0
): Float32Array {
    const data = new Float32Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
        data[i * 4 + 0] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }

    return data;
}

/**
 * Create a mock GPU texture with test data
 */
export function createMockTestTexture(
    device: MockGPUDevice,
    width: number,
    height: number,
    pattern: 'gradient' | 'colorchecker' | 'outofgamut' | 'solid' = 'gradient'
): MockGPUTexture {
    const texture = device.createTexture({
        size: { width, height },
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        label: `Test Texture (${pattern})`,
    });

    // Generate data based on pattern
    let data: Float32Array;
    switch (pattern) {
        case 'gradient':
            data = createGradientImageData(width, height);
            break;
        case 'colorchecker':
            data = createColorCheckerImageData(width, height);
            break;
        case 'outofgamut':
            data = createOutOfGamutImageData(width, height);
            break;
        case 'solid':
            data = createSolidColorImageData(width, height, 0.5, 0.5, 0.5);
            break;
    }

    // Write data to texture via queue
    device.queue.writeTexture(
        { texture },
        data,
        { bytesPerRow: width * 16 },
        { width, height }
    );

    return texture;
}

/**
 * Count non-zero pixels in Float32Array (RGBA format)
 */
export function countNonZeroPixels(data: Float32Array): number {
    let count = 0;
    const epsilon = 1e-6;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        if (Math.abs(r) > epsilon || Math.abs(g) > epsilon || Math.abs(b) > epsilon) {
            count++;
        }
    }

    return count;
}

/**
 * Calculate pixel statistics
 */
export function calculatePixelStats(data: Float32Array): {
    min: { r: number; g: number; b: number };
    max: { r: number; g: number; b: number };
    avg: { r: number; g: number; b: number };
    nonZeroCount: number;
    totalPixels: number;
} {
    const totalPixels = data.length / 4;
    let minR = Infinity, minG = Infinity, minB = Infinity;
    let maxR = -Infinity, maxG = -Infinity, maxB = -Infinity;
    let sumR = 0, sumG = 0, sumB = 0;
    let nonZeroCount = 0;
    const epsilon = 1e-6;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        minR = Math.min(minR, r);
        minG = Math.min(minG, g);
        minB = Math.min(minB, b);

        maxR = Math.max(maxR, r);
        maxG = Math.max(maxG, g);
        maxB = Math.max(maxB, b);

        sumR += r;
        sumG += g;
        sumB += b;

        if (Math.abs(r) > epsilon || Math.abs(g) > epsilon || Math.abs(b) > epsilon) {
            nonZeroCount++;
        }
    }

    return {
        min: { r: minR, g: minG, b: minB },
        max: { r: maxR, g: maxG, b: maxB },
        avg: { r: sumR / totalPixels, g: sumG / totalPixels, b: sumB / totalPixels },
        nonZeroCount,
        totalPixels,
    };
}

/**
 * Compare two pixel arrays and return difference metrics
 */
export function comparePixels(
    a: Float32Array,
    b: Float32Array
): {
    maxDifference: number;
    avgDifference: number;
    matchingPixels: number;
    totalPixels: number;
} {
    if (a.length !== b.length) {
        throw new Error(`Pixel arrays have different lengths: ${a.length} vs ${b.length}`);
    }

    const totalPixels = a.length / 4;
    let maxDiff = 0;
    let sumDiff = 0;
    let matchingPixels = 0;
    const tolerance = 0.001;

    for (let i = 0; i < a.length; i += 4) {
        const diffR = Math.abs(a[i] - b[i]);
        const diffG = Math.abs(a[i + 1] - b[i + 1]);
        const diffB = Math.abs(a[i + 2] - b[i + 2]);

        const pixelDiff = Math.max(diffR, diffG, diffB);
        maxDiff = Math.max(maxDiff, pixelDiff);
        sumDiff += (diffR + diffG + diffB) / 3;

        if (pixelDiff < tolerance) {
            matchingPixels++;
        }
    }

    return {
        maxDifference: maxDiff,
        avgDifference: sumDiff / totalPixels,
        matchingPixels,
        totalPixels,
    };
}

/**
 * Check if all pixels are zero (black)
 */
export function isAllBlack(data: Float32Array, epsilon: number = 1e-6): boolean {
    for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i]) > epsilon ||
            Math.abs(data[i + 1]) > epsilon ||
            Math.abs(data[i + 2]) > epsilon) {
            return false;
        }
    }
    return true;
}

/**
 * Sample specific pixels from array
 */
export function samplePixels(
    data: Float32Array,
    width: number,
    positions: Array<{ x: number; y: number }>
): Array<{ x: number; y: number; r: number; g: number; b: number; a: number }> {
    return positions.map(pos => {
        const idx = (pos.y * width + pos.x) * 4;
        return {
            x: pos.x,
            y: pos.y,
            r: data[idx],
            g: data[idx + 1],
            b: data[idx + 2],
            a: data[idx + 3],
        };
    });
}
