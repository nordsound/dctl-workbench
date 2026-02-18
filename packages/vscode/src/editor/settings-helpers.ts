/**
 * Settings helper functions for mapping VS Code configuration values
 * to internal types. Kept as pure functions for testability.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { DctlColorSpace } from '@dctl-workbench/core';

/** Pipeline mode: built-in ACES or custom OCIO config */
export type PipelineMode = 'aces' | 'custom-ocio';

/** All valid DctlColorSpace values (ACES mode) */
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

/**
 * Parse the custom OCIO config path setting.
 * Returns null if the path is empty, doesn't have .ocio extension, or the file doesn't exist.
 */
export function parseOcioConfigPath(value: string): string | null {
    if (!value || value.trim() === '') {
        return null;
    }
    const resolved = path.resolve(value);
    if (path.extname(resolved).toLowerCase() !== '.ocio') {
        return null;
    }
    if (!fs.existsSync(resolved)) {
        return null;
    }
    return resolved;
}

/**
 * Determine the pipeline mode based on the OCIO config path setting.
 */
export function determinePipelineMode(ocioConfigPath: string | null): PipelineMode {
    return ocioConfigPath ? 'custom-ocio' : 'aces';
}
