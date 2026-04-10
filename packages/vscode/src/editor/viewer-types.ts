/**
 * Shared type definitions for ImageViewerCore.
 *
 * These types are extracted from ExrEditorProvider as the first step
 * of the ImageViewerCore refactoring (A1/S1). They define per-panel
 * viewer state, per-panel OCIO state, and a decode cache for sharing
 * decoded image data across panels viewing the same file.
 */

import type * as vscode from 'vscode';
import type { DctlParam, DctlColorValue, DctlShaderInfo } from '../dctl/types';

/** OCIO display transform state — will become per-panel in S2. */
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

/** Per-panel viewer state (DCTL + OCIO + panel metadata). */
export interface ViewerState {
    dctl: DctlState;
    ocio: OcioState | null;
    documentPath: string;
    lastActiveTime: number;
    dctlShaderInfo: DctlShaderInfo | null;
    editorChangeSubscriptions: vscode.Disposable[];
}

/** Cached decode result, keyed by document URI string. */
export interface DecodedImageCache {
    uri: string;
    width: number;
    height: number;
    channels: number;
    pixels: Float32Array;
    colorSpace: string;
    colorSpaceDetected: boolean;
    compression: string;
    bitDepth: string;
    timestamp: number;
}
