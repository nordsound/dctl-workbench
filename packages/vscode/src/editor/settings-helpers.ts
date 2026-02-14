/**
 * Settings helper functions for mapping VS Code configuration values
 * to internal types. Kept as pure functions for testability.
 */

import type { DctlColorSpace } from '@dctl-workbench/core';

/** All valid DctlColorSpace values */
export const VALID_COLOR_SPACES: DctlColorSpace[] = [
    'ACES2065-1',
    'ACEScg',
    'ACEScc',
    'ACEScct',
    'linear_sRGB',
];

/** Map of compression setting strings to enum values (matches Compression enum in writer.ts) */
const COMPRESSION_MAP: Record<string, number> = {
    'NONE': 0,
    'RLE': 1,
    'ZIPS': 2,
    'ZIP': 3,
    'PIZ': 4,
    'PXR24': 5,
    'B44': 6,
    'B44A': 7,
    'DWAA': 8,
    'DWAB': 9,
};

const DEFAULT_COMPRESSION = 4; // PIZ

/**
 * Parse a compression setting string to the Compression enum value.
 * Falls back to PIZ if the input is invalid.
 */
export function parseCompressionSetting(value: string): number {
    return COMPRESSION_MAP[value] ?? DEFAULT_COMPRESSION;
}

/**
 * Parse a working color space setting string to a valid DctlColorSpace.
 * Falls back to ACEScct if the input is invalid.
 */
export function parseWorkingColorSpace(value: string): DctlColorSpace {
    if ((VALID_COLOR_SPACES as string[]).includes(value)) {
        return value as DctlColorSpace;
    }
    return 'ACEScct';
}
