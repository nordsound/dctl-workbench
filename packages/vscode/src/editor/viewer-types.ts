/**
 * Shared type definitions for ImageViewerCore.
 *
 * Per-panel DCTL state and OCIO display transform state.
 */

import type * as vscode from 'vscode';
import type { DctlParam, DctlColorValue } from '../dctl/types';

/** OCIO display transform state per panel. */
export interface OcioState {
    source: string;
    display: string;
    view: string;
}

/** DCTL state for each webview panel. */
export interface DctlState {
    filePath: string | null;
    enabled: boolean;
    workingColorSpace: 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB';
    params: DctlParam[];
    paramValues: Record<string, number | boolean | DctlColorValue>;
    fileWatcher: vscode.FileSystemWatcher | null;
    includedFiles: string[];
    imageWidth: number;
    imageHeight: number;
    useUniformBuffer: boolean;
    hasDctlSupport: boolean;
    applyRgc: boolean;
    rgcPeakLuminance: number;
}
