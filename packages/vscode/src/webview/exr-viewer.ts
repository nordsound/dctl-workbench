/**
 * EXR Viewer Webview Script
 *
 * WebGPU/WebGL2-based renderer with OCIO color transform support.
 * Automatically falls back to WebGL2 if WebGPU is not available.
 */

import { WebGPURenderer } from './webgpu-renderer';
import { createLogger, calculateFitZoom, type VSCodeAPI } from './shared';
import { createHDRManager, type HDRManager } from './shared';
import { PanController, type PanState } from './shared/pan-controller';
import {
    createDctlControlsManager,
    rgbToHex,
    hexToRgb,
    renderImageMetadata,
    type DctlControlsManager,
    type DctlParam,
    type DctlParamValue,
    type DctlColorValue,
} from './shared';

declare const acquireVsCodeApi: () => {
    postMessage: (message: unknown) => void;
    getState: () => unknown;
    setState: (state: unknown) => void;
};

interface GpuTexture {
    name: string;
    samplerName: string;
    width: number;
    height: number;
    channel: number;
    dimensions: number;
    data: number[];
}

interface GpuTexture3D {
    name: string;
    samplerName: string;
    edgeLen: number;
    data: number[];
}

interface GpuShaderInfo {
    shaderText: string;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    uniforms: { name: string; type: number }[];
}

interface TextureBinding {
    binding: number;
    type: 'texture2D' | 'texture3D' | 'sampler';
    name: string;
    originalName?: string;
}

interface DctlParamMapping {
    name: string;
    type: 'float' | 'int' | 'bool' | 'color';
    bufferType: 'float_params' | 'int_params' | 'color_params';
    index: number;
    default: number | boolean | { r: number; g: number; b: number };
}

interface DctlComputeShaderInfo {
    computeWgsl: string;
    dctlFunctionWgsl: string;
    ocioFunctionWgsl: string;
    rgcFunctionWgsl?: string;
    paramMapping: Array<{
        name: string;
        glslName: string;
        type: 'float' | 'int' | 'bool' | 'color';
        index: number;
        default: number | boolean | { r: number; g: number; b: number };
    }>;
    uniformBufferBinding: number;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    rgcTextures?: GpuTexture[];
    rgcTextures3D?: GpuTexture3D[];
    bindings: TextureBinding[];
    rgcBindings?: TextureBinding[];
    hasDctl: boolean;
    hasFullRgc?: boolean;
    success: boolean;
    error?: string;
}

interface WgslShaderInfo {
    wgslCode: string;
    computeWgslCode?: string;
    textures: GpuTexture[];
    textures3D: GpuTexture3D[];
    bindings?: TextureBinding[];
    // RGC textures (from ACES 2.0 RGC shader) for export
    rgcTextures?: GpuTexture[];
    rgcTextures3D?: GpuTexture3D[];
    // Uniform buffer support for fast DCTL parameter updates
    paramMapping?: DctlParamMapping[];
    useUniformBuffer?: boolean;
    uniformBufferBinding?: number;
    // DCTL + OCIO compute shader info (for compute pipeline with DCTL support)
    dctlComputeShaderInfo?: DctlComputeShaderInfo;
}

type DctlColorSpace = 'ACES2065-1' | 'ACEScg' | 'ACEScc' | 'ACEScct' | 'linear_sRGB';

type PipelineMode = 'aces' | 'custom-ocio';

interface ExrImageData {
    width: number;
    height: number;
    channels: number;
    // ArrayBuffer transfer for efficiency (no JSON serialization)
    buffer: ArrayBuffer;
    byteOffset: number;
    byteLength: number;
    colorSpace: string;
    colorSpaceDetected: boolean;
    colorSpaces: string[];
    displays: string[];
    defaultDisplay: string;
    defaultView: string;
    displayViewMap: Record<string, string[]>;
    shaderInfo: GpuShaderInfo;
    // WGSL shader info for WebGPU (null if conversion failed)
    wgslShaderInfo: WgslShaderInfo | null;
    // EXR compression type
    compression?: string;
    // EXR pixel bit depth
    bitDepth?: string;
    // Pipeline mode: 'aces' (default) or 'custom-ocio'
    pipelineMode?: PipelineMode;
    // Scene-referred color spaces from custom OCIO config (for working CS dropdown)
    customWorkingColorSpaces?: string[];
}

// Reconstructed pixel data for reading
let pixelData: Float32Array | null = null;

const vscode = acquireVsCodeApi() as VSCodeAPI;

// Override console methods to forward to debug.log
(function setupConsoleOverride() {
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const originalConsoleError = console.error;

    const postToDebugLog = (level: string, args: unknown[]) => {
        try {
            const message = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg);
                    } catch {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ');
            vscode.postMessage({ type: 'log', message: `[${level}] ${message}` });
        } catch {
            // Ignore errors in logging
        }
    };

    console.log = function(...args: unknown[]) {
        originalConsoleLog.apply(console, args);
        postToDebugLog('LOG', args);
    };

    console.warn = function(...args: unknown[]) {
        originalConsoleWarn.apply(console, args);
        postToDebugLog('WARN', args);
    };

    console.error = function(...args: unknown[]) {
        originalConsoleError.apply(console, args);
        postToDebugLog('ERROR', args);
    };
})();

// Create logger using shared module
const log = createLogger(vscode, 'EXR-Viewer');

// Show/hide loading overlay
function showLoading(show: boolean, message?: string): void {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');

    if (overlay) {
        if (show) {
            if (loadingText && message) {
                loadingText.textContent = message;
            }
            overlay.classList.add('visible');
            overlay.classList.add('loading');
        } else {
            overlay.classList.remove('visible');
            overlay.classList.remove('loading');
        }
    }
}

// DOM elements
let canvas: HTMLCanvasElement;
let gl: WebGL2RenderingContext | null = null;
let sourceSelect: HTMLSelectElement;
let displaySelect: HTMLSelectElement;
let viewSelect: HTMLSelectElement;
let imageInfo: HTMLElement;
let colorSpaceInfo: HTMLElement;
let zoomInfo: HTMLElement;
let pixelInfo: HTMLElement;
let zoomFitBtn: HTMLButtonElement;
let zoom100Btn: HTMLButtonElement;
let hdrToggleBtn: HTMLButtonElement;
let exportExrBtn: HTMLButtonElement;

// HDR Manager (shared module)
let hdrManager: HDRManager | null = null;

let canvasContainer: HTMLElement;

// Left sidebar elements (Metadata)
let sidebarLeft: HTMLElement;
let sidebarLeftToggle: HTMLButtonElement;
let resizeHandleLeft: HTMLElement;
let metadataImageInfo: HTMLElement;

// Right sidebar elements (DCTL)
let sidebarRight: HTMLElement;
let sidebarRightToggle: HTMLButtonElement;
let resizeHandleRight: HTMLElement;

// Sidebar state
let sidebarLeftOpen = true;
let sidebarLeftWidth = 200;
let sidebarRightOpen = true;
let sidebarRightWidth = 320;
const SIDEBAR_MIN_WIDTH = 150;
const SIDEBAR_MAX_WIDTH = 500;

// DCTL Panel elements
let dctlPanel: HTMLElement;
let dctlEnabled: HTMLInputElement;
let dctlFileSelect: HTMLSelectElement;
let dctlFileBtn: HTMLButtonElement;
let dctlColorspaceSelect: HTMLSelectElement;
let dctlParamsContainer: HTMLElement;
let rgcEnabled: HTMLInputElement;
let rgcOptions: HTMLElement;
let rgcPeakLuminanceSelect: HTMLSelectElement;

// DCTL state
let dctlLoaded = false;
let dctlParams: DctlParam[] = [];
let openDctlFiles: { path: string; name: string }[] = [];
let dctlParamValues: Record<string, DctlParamValue> = {};
let dctlWorkingColorSpace: string = 'ACEScg';
let dctlControlsManager: DctlControlsManager | null = null;

// Pipeline mode state
let currentPipelineMode: PipelineMode = 'aces';

// Renderer mode
type RendererMode = 'webgpu' | 'webgl2';
let rendererMode: RendererMode = 'webgl2';

// WebGPU renderer
let webgpuRenderer: WebGPURenderer | null = null;

// WebGL state (fallback)
let program: WebGLProgram | null = null;
let imageTexture: WebGLTexture | null = null;
let ocioTextures: WebGLTexture[] = [];
let ocio3DTextures: WebGLTexture[] = [];
let vao: WebGLVertexArrayObject | null = null;
let uniformCache: {
    u_image: WebGLUniformLocation | null;
    ocioSamplers: { name: string; location: WebGLUniformLocation | null }[];
    ocio3DSamplers: { name: string; location: WebGLUniformLocation | null }[];
} | null = null;

// Image state
let currentImage: ExrImageData | null = null;
let zoom = 1.0;

// Zoom mode: 'fit' or 'manual'
let zoomMode: 'fit' | 'manual' = 'fit';

// Pan controller for drag-to-pan
let panController: PanController | null = null;

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
    sourceSelect = document.getElementById('source-select') as HTMLSelectElement;
    displaySelect = document.getElementById('display-select') as HTMLSelectElement;
    viewSelect = document.getElementById('view-select') as HTMLSelectElement;
    imageInfo = document.getElementById('image-info') as HTMLElement;
    colorSpaceInfo = document.getElementById('color-space-info') as HTMLElement;
    zoomInfo = document.getElementById('zoom-info') as HTMLElement;
    pixelInfo = document.getElementById('pixel-info') as HTMLElement;
    zoomFitBtn = document.getElementById('zoom-fit') as HTMLButtonElement;
    zoom100Btn = document.getElementById('zoom-100') as HTMLButtonElement;
    hdrToggleBtn = document.getElementById('hdr-toggle') as HTMLButtonElement;
    exportExrBtn = document.getElementById('export-exr-btn') as HTMLButtonElement;
    canvasContainer = document.getElementById('canvas-container') as HTMLElement;

    // Left sidebar elements (Metadata)
    sidebarLeft = document.getElementById('sidebar-left') as HTMLElement;
    sidebarLeftToggle = document.getElementById('sidebar-left-toggle') as HTMLButtonElement;
    resizeHandleLeft = document.getElementById('resize-handle-left') as HTMLElement;
    metadataImageInfo = document.getElementById('metadata-image-info') as HTMLElement;

    // Right sidebar elements (DCTL)
    sidebarRight = document.getElementById('sidebar-right') as HTMLElement;
    sidebarRightToggle = document.getElementById('sidebar-right-toggle') as HTMLButtonElement;
    resizeHandleRight = document.getElementById('resize-handle-right') as HTMLElement;

    // DCTL Panel elements
    dctlPanel = document.getElementById('dctl-panel') as HTMLElement;
    dctlEnabled = document.getElementById('dctl-enabled') as HTMLInputElement;
    dctlFileSelect = document.getElementById('dctl-file-select') as HTMLSelectElement;
    dctlFileBtn = document.getElementById('dctl-file-btn') as HTMLButtonElement;
    dctlColorspaceSelect = document.getElementById('dctl-colorspace') as HTMLSelectElement;
    dctlParamsContainer = document.getElementById('dctl-params') as HTMLElement;
    rgcEnabled = document.getElementById('rgc-enabled') as HTMLInputElement;
    rgcOptions = document.getElementById('rgc-options') as HTMLElement;
    rgcPeakLuminanceSelect = document.getElementById('rgc-peak-luminance') as HTMLSelectElement;

    // Initialize DCTL controls manager
    dctlControlsManager = createDctlControlsManager({
        container: dctlParamsContainer,
        onChange: (name, value) => {
            dctlParamValues[name] = value;
            log(`Sending updateDctlParam: ${name} = ${JSON.stringify(value)}`);
            vscode.postMessage({ type: 'updateDctlParam', name, value });
        },
        emptyMessage: 'Select a DCTL file to see parameters',
        log,  // Pass unified logger
    });

    // Try WebGPU first, fall back to WebGL2
    const webgpuSupported = await WebGPURenderer.isSupported();
    if (webgpuSupported) {
        webgpuRenderer = new WebGPURenderer();
        const initialized = await webgpuRenderer.init(canvas);
        if (initialized) {
            rendererMode = 'webgpu';
            log('Using WebGPU renderer');
        } else {
            webgpuRenderer = null;
            log('WebGPU initialization failed, falling back to WebGL2');
        }
    }

    // Fall back to WebGL2 if WebGPU is not available
    if (rendererMode !== 'webgpu') {
        gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            premultipliedAlpha: false,
        });

        if (!gl) {
            showError('Neither WebGPU nor WebGL2 is supported');
            return;
        }

        rendererMode = 'webgl2';
        log('Using WebGL2 renderer');

        // Enable float textures
        const ext = gl.getExtension('EXT_color_buffer_float');
        if (!ext) {
            console.warn('EXT_color_buffer_float not available');
        }

        // Enable linear filtering for float textures (needed for smooth LUT interpolation)
        const floatLinearExt = gl.getExtension('OES_texture_float_linear');
        if (!floatLinearExt) {
            console.warn('OES_texture_float_linear not available - LUT interpolation may be affected');
        }
    }

    // Initialize HDR display detection using shared module (must be after renderer mode is set)
    hdrManager = createHDRManager({
        log,
        onCapabilityChange: (supported, wasSupported) => {
            // Update button state (disable if WebGL2 mode)
            hdrManager?.updateButtonState(
                hdrToggleBtn,
                rendererMode !== 'webgpu',
                'HDR mode requires WebGPU'
            );

            // If HDR was enabled but display no longer supports it, disable HDR mode
            if (wasSupported && !supported && webgpuRenderer?.isHDREnabled) {
                log('[HDR] Display changed from HDR to SDR, disabling HDR mode');
                disableHDRMode();
            }
        },
    });
    hdrManager.init();

    // Setup event listeners
    sourceSelect.addEventListener('change', onSourceChange);
    displaySelect.addEventListener('change', onDisplayChange);
    viewSelect.addEventListener('change', onViewChange);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    zoomFitBtn.addEventListener('click', zoomToFit);
    zoom100Btn.addEventListener('click', zoomTo100);
    hdrToggleBtn.addEventListener('click', toggleHDRMode);
    exportExrBtn.addEventListener('click', onExportExr);
    window.addEventListener('resize', onWindowResize);

    // Pan (drag-to-scroll) event listeners
    panController = new PanController({ imageFitsInContainer: true });
    canvasContainer.addEventListener('mousedown', onPanStart);
    canvasContainer.addEventListener('mousemove', onPanMove);
    canvasContainer.addEventListener('mouseup', onPanEnd);
    canvasContainer.addEventListener('mouseleave', onPanEnd);

    // Sidebar event listeners
    sidebarLeftToggle.addEventListener('click', toggleSidebarLeft);
    sidebarRightToggle.addEventListener('click', toggleSidebarRight);
    resizeHandleLeft.addEventListener('mousedown', (e) => startSidebarResize(e, 'left'));
    resizeHandleRight.addEventListener('mousedown', (e) => startSidebarResize(e, 'right'));
    setupSectionToggles();

    // Initialize sidebar widths
    updateSidebarLeftWidth();
    updateSidebarRightWidth();

    // Set initial button state
    updateZoomButtons();

    // DCTL event listeners
    dctlFileSelect.addEventListener('change', onDctlFileSelectChange);
    dctlFileBtn.addEventListener('click', onDctlFileBrowse);
    dctlEnabled.addEventListener('change', onDctlToggle);
    dctlColorspaceSelect.addEventListener('change', onDctlColorspaceChange);
    rgcEnabled.addEventListener('change', onRgcToggle);
    rgcPeakLuminanceSelect.addEventListener('change', onRgcPeakLuminanceChange);

    // Keyboard shortcuts for debugging/testing
    document.addEventListener('keydown', onKeyDown);

    // Notify extension we're ready
    vscode.postMessage({ type: 'ready' });
});

// Handle messages from extension
window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
        case 'startLoading':
            showLoading(true, 'Loading...');
            break;
        case 'loadImage':
            loadImage(message.data);
            break;
        case 'updateShader':
            log('Received updateShader message');
            updateShader(message.shaderInfo, message.wgslShaderInfo);
            break;
        case 'loadDctl':
            loadDctl(message.dctl);
            break;
        case 'unloadDctl':
            unloadDctl();
            break;
        case 'openDctlFiles':
            updateOpenDctlFiles(message.files);
            break;
        case 'buildExportShader':
            // Build export shader and optionally export to buffer
            buildExportShader(message.wgslShaderInfo).then(() => {
                if (message.requestBuffer && message.requestId) {
                    log(`buildExportShader: requestBuffer=true, calling exportToBuffer`);
                    exportToBuffer(message.requestId);
                }
            });
            break;
        case 'exportToBuffer':
            exportToBuffer(message.requestId);
            break;
        case 'error':
            showError(message.message);
            break;
        case 'updateDctlParamFast':
            // Fast parameter update via Uniform Buffer (no shader recompilation)
            updateDctlParamFast(message.name, message.value);
            break;
        default:
            console.warn(`Unknown message type: ${message.type}`);
    }
});

async function loadImage(data: ExrImageData): Promise<void> {
    try {
        log(`loadImage: ${data.width}x${data.height}, ${data.channels}ch, colorSpace=${data.colorSpace}, detected=${data.colorSpaceDetected}, renderer=${rendererMode}, pipelineMode=${data.pipelineMode || 'aces'}`);

        currentImage = data;
        currentPipelineMode = data.pipelineMode || 'aces';

        // Update UI
        populateSources(data.colorSpaces, data.colorSpace);
        populateDisplays(data.displays, data.displayViewMap, data.defaultDisplay, data.defaultView);

        // Update working color space dropdown for custom OCIO mode
        if (currentPipelineMode === 'custom-ocio' && data.customWorkingColorSpaces) {
            populateCustomWorkingColorSpaces(data.customWorkingColorSpaces);
            // Hide RGC controls in custom mode
            const rgcContainer = document.querySelector('.dctl-rgc') as HTMLElement;
            if (rgcContainer) rgcContainer.style.display = 'none';
        } else {
            // Show RGC controls in ACES mode
            const rgcContainer = document.querySelector('.dctl-rgc') as HTMLElement;
            if (rgcContainer) rgcContainer.style.display = '';
        }
        imageInfo.textContent = `${data.width} x ${data.height}`;
        colorSpaceInfo.textContent = data.colorSpaceDetected
            ? `${data.colorSpace} (detected)`
            : `${data.colorSpace} (default)`;

        // Setup canvas
        canvas.width = data.width;
        canvas.height = data.height;
        updateZoom();

        // Reconstruct Float32Array from ArrayBuffer
        const srcPixels = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
        pixelData = srcPixels;

        if (rendererMode === 'webgpu' && webgpuRenderer) {
            // WebGPU path
            webgpuRenderer.createImageTexture({
                width: data.width,
                height: data.height,
                channels: data.channels,
                pixels: srcPixels,
            });

            // Use WGSL shader if available
            await webgpuRenderer.buildShader(data.wgslShaderInfo);
            webgpuRenderer.render();
        } else {
            // WebGL2 fallback
            createImageTexture(data);
            buildShader(data.shaderInfo);
            render();
        }

        // Update sidebar metadata
        updateMetadata(data);
    } catch (error) {
        console.error('Error loading image:', error);
        log(`loadImage error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        // Always hide loading overlay
        showLoading(false);
    }
}

async function updateShader(shaderInfo: GpuShaderInfo, wgslShaderInfo?: WgslShaderInfo | null): Promise<void> {
    if (!currentImage) {
        log('updateShader: No current image, skipping');
        return;
    }

    log(`updateShader: mode=${rendererMode}, hasWgsl=${!!wgslShaderInfo}, wgslLength=${wgslShaderInfo?.wgslCode?.length || 0}`);
    // Debug: Check if dctlComputeShaderInfo is received
    const dctlInfo = wgslShaderInfo?.dctlComputeShaderInfo;
    log(`updateShader: dctlComputeShaderInfo exists=${!!dctlInfo}, success=${dctlInfo?.success}, hasDctl=${dctlInfo?.hasDctl}, hasFullRgc=${dctlInfo?.hasFullRgc}`);
    if (dctlInfo?.hasFullRgc) {
        log(`updateShader: RGC textures count: 2D=${dctlInfo.rgcTextures?.length ?? 0}, 3D=${dctlInfo.rgcTextures3D?.length ?? 0}`);
    }

    if (rendererMode === 'webgpu' && webgpuRenderer && wgslShaderInfo) {
        // WebGPU path
        try {
            await webgpuRenderer.buildShader(wgslShaderInfo);

            // Re-apply current DCTL parameter values after shader rebuild
            if (Object.keys(dctlParamValues).length > 0) {
                log(`updateShader: Re-applying ${Object.keys(dctlParamValues).length} DCTL params after shader rebuild`);
                webgpuRenderer.updateDctlParams(dctlParamValues);
            }

            // Enable debug pixel readback when RGC is enabled (for automated verification)
            if (dctlInfo?.hasFullRgc) {
                webgpuRenderer.enableDebugPixelReadback((result) => {
                    // Send pixel verification result to Extension Host
                    log(`[RGC Verification] isBlack=${result.isBlack}, pixels=${result.pixels.slice(0, 8).join(', ')}...`);
                    vscode.postMessage({
                        type: 'rgcPixelVerification',
                        isBlack: result.isBlack,
                        pixels: result.pixels,
                        hasFullRgc: true,
                    });
                });
            }

            webgpuRenderer.render();

            // Report shader build result to extension
            // This tells the extension whether it can use the fast path (uniform buffer) for parameter updates
            const hasDctlSupport = webgpuRenderer.isUniformBufferEnabled;
            log(`updateShader: WebGPU shader rebuilt successfully, hasDctlSupport=${hasDctlSupport}`);
            vscode.postMessage({
                type: 'shaderBuildResult',
                hasDctlSupport,
            });
        } catch (e) {
            log(`updateShader: WebGPU shader build failed: ${e}`);
            vscode.postMessage({
                type: 'shaderBuildResult',
                hasDctlSupport: false,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    } else {
        // WebGL2 fallback
        log(`updateShader: Using WebGL2 fallback (webgpu=${!!webgpuRenderer}, wgsl=${!!wgslShaderInfo})`);
        cleanupOCIOTextures();
        buildShader(shaderInfo);
        render();
    }
}

function populateSources(colorSpaces: string[], selectedColorSpace: string): void {
    sourceSelect.innerHTML = '';

    for (const cs of colorSpaces) {
        const option = document.createElement('option');
        option.value = cs;
        option.textContent = cs;
        sourceSelect.appendChild(option);
    }

    // Set to detected/default color space
    if (colorSpaces.includes(selectedColorSpace)) {
        sourceSelect.value = selectedColorSpace;
    }
}

function populateDisplays(displays: string[], displayViewMap: Record<string, string[]>, defaultDisplay?: string, defaultView?: string): void {
    displaySelect.innerHTML = '';

    for (const display of displays) {
        const option = document.createElement('option');
        option.value = display;
        option.textContent = display;
        displaySelect.appendChild(option);
    }

    // Set to specified default or sRGB if available
    if (defaultDisplay && displays.includes(defaultDisplay)) {
        displaySelect.value = defaultDisplay;
    } else {
        const srgbDisplay = displays.find(d => d.includes('sRGB'));
        if (srgbDisplay) {
            displaySelect.value = srgbDisplay;
        }
    }

    // Populate views for selected display
    const views = displayViewMap[displaySelect.value] || [];
    populateViews(views, defaultView);
}

function populateViews(views: string[], defaultView?: string): void {
    viewSelect.innerHTML = '';

    for (const view of views) {
        const option = document.createElement('option');
        option.value = view;
        option.textContent = view;
        viewSelect.appendChild(option);
    }

    // Set to specified default or SDR 100 nits if available
    if (defaultView && views.includes(defaultView)) {
        viewSelect.value = defaultView;
    } else {
        const sdrView = views.find(v => v.includes('SDR 100 nits'));
        if (sdrView) {
            viewSelect.value = sdrView;
        }
    }
}

function onSourceChange(): void {
    if (!currentImage) return;

    // Update color space info display
    colorSpaceInfo.textContent = `${sourceSelect.value} (manual)`;

    // Request new shader from extension
    vscode.postMessage({
        type: 'setDisplayTransform',
        source: sourceSelect.value,
        display: displaySelect.value,
        view: viewSelect.value,
    });
}

function onDisplayChange(): void {
    if (!currentImage) return;

    const display = displaySelect.value;
    const views = currentImage.displayViewMap[display] || [];
    populateViews(views);

    // Request new shader from extension
    vscode.postMessage({
        type: 'setDisplayTransform',
        source: sourceSelect.value,
        display: displaySelect.value,
        view: viewSelect.value,
    });
}

function onViewChange(): void {
    if (!currentImage) return;

    // Request new shader from extension
    vscode.postMessage({
        type: 'setDisplayTransform',
        source: sourceSelect.value,
        display: displaySelect.value,
        view: viewSelect.value,
    });
}

function createImageTexture(data: ExrImageData): void {
    if (!gl) return;

    if (imageTexture) {
        gl.deleteTexture(imageTexture);
    }

    imageTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);

    // Reconstruct Float32Array from ArrayBuffer (efficient transfer)
    const srcPixels = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    pixelData = srcPixels; // Keep reference for pixel inspector

    // Convert to RGBA32F like vscode-raw-viewer does
    // EXR data is BGR order, we need to swap to RGB and add alpha
    const numPixels = data.width * data.height;
    const rgbaPixels = new Float32Array(numPixels * 4);

    if (data.channels === 3) {
        // BGR -> RGBA conversion (swap B and R, add A=1.0)
        let srcIdx = 0;
        let dstIdx = 0;
        for (let i = 0; i < numPixels; i++) {
            const b = srcPixels[srcIdx++];
            const g = srcPixels[srcIdx++];
            const r = srcPixels[srcIdx++];
            rgbaPixels[dstIdx++] = r;  // R
            rgbaPixels[dstIdx++] = g;  // G
            rgbaPixels[dstIdx++] = b;  // B
            rgbaPixels[dstIdx++] = 1.0; // A
        }
    } else if (data.channels === 4) {
        // BGRA -> RGBA conversion
        let srcIdx = 0;
        let dstIdx = 0;
        for (let i = 0; i < numPixels; i++) {
            const b = srcPixels[srcIdx++];
            const g = srcPixels[srcIdx++];
            const r = srcPixels[srcIdx++];
            const a = srcPixels[srcIdx++];
            rgbaPixels[dstIdx++] = r;
            rgbaPixels[dstIdx++] = g;
            rgbaPixels[dstIdx++] = b;
            rgbaPixels[dstIdx++] = a;
        }
    } else {
        // Single channel -> RGBA
        let srcIdx = 0;
        let dstIdx = 0;
        for (let i = 0; i < numPixels; i++) {
            const v = srcPixels[srcIdx++];
            rgbaPixels[dstIdx++] = v;
            rgbaPixels[dstIdx++] = v;
            rgbaPixels[dstIdx++] = v;
            rgbaPixels[dstIdx++] = 1.0;
        }
    }

    // Upload as RGBA32F
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        data.width,
        data.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        rgbaPixels
    );

    setTextureParams(gl.TEXTURE_2D);
}

function buildShader(shaderInfo: GpuShaderInfo): void {
    if (!gl) return;

    // Cleanup
    if (program) {
        gl.deleteProgram(program);
    }
    cleanupOCIOTextures();

    // Vertex shader
    const vertexShaderSrc = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_texCoord;

out vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`;

    // Fragment shader with OCIO
    const fragmentShaderSrc = buildFragmentShader(shaderInfo);

    // Compile shaders
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSrc);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSrc);

    if (!vertexShader || !fragmentShader) {
        showError('Failed to compile shaders');
        return;
    }

    // Link program
    program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const error = gl.getProgramInfoLog(program);
        showError(`Shader link error: ${error}`);
        return;
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    // Setup VAO
    if (!vao) {
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        // Fullscreen quad
        const positions = new Float32Array([
            -1, -1,  0, 1,
             1, -1,  1, 1,
            -1,  1,  0, 0,
             1,  1,  1, 0,
        ]);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    }

    // Setup OCIO textures
    setupOCIOTextures(shaderInfo);
}

/**
 * Post-process OCIO shader for WebGL2/GLSL ES 3.0 compatibility
 * - Remove C-style float suffixes (1.0f -> 1.0)
 * - Convert integer literals in float expressions to float literals
 * - GLSL ES 3.0 is strict about type conversions
 */
function fixShaderForWebGL(shaderText: string): string {
    let fixed = shaderText;

    // Step 1: Remove C-style float suffixes (1.0f, 4.f)
    fixed = fixed.replace(/(\d+\.?\d*)f\b/g, '$1');

    // Step 2: Fix float variable + integer literal -> add .0
    // e.g., "i_base + 1;" -> "i_base + 1.0;"
    fixed = fixed.replace(/(\w+_(?:base|lo|hi)) \+ (\d+);/g, '$1 + $2.0;');
    fixed = fixed.replace(/(\w+_(?:base|lo|hi)) - (\d+);/g, '$1 - $2.0;');

    // Step 3: Fix (int_var + 0.5) / int -> (float(int_var) + 0.5) / float
    // e.g., "(i_lo + 0.5) / 362" -> "(float(i_lo) + 0.5) / 362.0"
    fixed = fixed.replace(/\((\w+) \+ 0\.5\) \/ (\d+)(?!\.)/g, '(float($1) + 0.5) / $2.0');

    // Step 4: Fix (int_var - 1 + 0.5) / int patterns
    fixed = fixed.replace(/\((\w+) - (\d+) \+ 0\.5\) \/ (\d+)(?!\.)/g, '(float($1) - $2.0 + 0.5) / $3.0');

    // Step 5: Fix float(int + literal) patterns
    fixed = fixed.replace(/float\((\w+) \+ 0\)/g, 'float($1)');
    fixed = fixed.replace(/float\((\w+) \+ (\d+)\)/g, '(float($1) + $2.0)');

    return fixed;
}

function buildFragmentShader(shaderInfo: GpuShaderInfo): string {
    // Find the main function name in OCIO shader
    // OCIO v2 uses OCIODisplay or ocio_main pattern
    const mainFuncMatch = shaderInfo.shaderText.match(/vec4\s+(OCIODisplay|ocio_main|OCIOMain)\s*\(/);
    const ocioMainFunc = mainFuncMatch ? mainFuncMatch[1] : 'OCIOMain';

    // Fix OCIO shader for WebGL2 compatibility
    const glslEs3Shader = fixShaderForWebGL(shaderInfo.shaderText);

    return `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 v_texCoord;
out vec4 fragColor;

uniform sampler2D u_image;

// OCIO Generated Code
${glslEs3Shader}

void main() {
    vec4 color = texture(u_image, v_texCoord);

    // Apply OCIO transform (ACES to display)
    vec4 result = ${ocioMainFunc}(color);

    // Clamp to [0, 1] for display
    fragColor = clamp(result, 0.0, 1.0);
}
`;
}

/**
 * Set common texture parameters for LUT sampling
 */
function setTextureParams(target: number): void {
    if (!gl) return;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) {
        gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    }
}

function compileShader(type: number, source: string): WebGLShader | null {
    if (!gl) return null;

    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        const typeName = type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';
        log(`Shader compile error (${typeName}): ${error}`);
        console.error('Shader compile error:', error);
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

function setupOCIOTextures(shaderInfo: GpuShaderInfo): void {
    if (!gl || !program) return;

    gl.useProgram(program);

    // Initialize uniform cache
    uniformCache = {
        u_image: gl.getUniformLocation(program, 'u_image'),
        ocioSamplers: [],
        ocio3DSamplers: [],
    };

    // Set image texture uniform
    gl.uniform1i(uniformCache.u_image, 0);

    let textureUnit = 1;

    // 1D/2D textures
    for (const tex of shaderInfo.textures) {
        const texture = gl.createTexture()!;
        ocioTextures.push(texture);

        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        // Convert to Float32Array - postMessage serializes typed arrays to regular arrays
        const data = tex.data instanceof Float32Array ? tex.data : new Float32Array(tex.data);

        // Determine format
        const format = tex.channel === 0 ? gl.RED : gl.RGB;
        const internalFormat = tex.channel === 0 ? gl.R32F : gl.RGB32F;

        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            internalFormat,
            tex.width,
            tex.height,
            0,
            format,
            gl.FLOAT,
            data
        );

        setTextureParams(gl.TEXTURE_2D);

        // Set uniform and cache location
        const location = gl.getUniformLocation(program, tex.samplerName);
        uniformCache.ocioSamplers.push({ name: tex.samplerName, location });
        if (location) {
            gl.uniform1i(location, textureUnit);
        }

        textureUnit++;
    }

    // 3D textures
    for (const tex of shaderInfo.textures3D) {
        const texture = gl.createTexture()!;
        ocio3DTextures.push(texture);

        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_3D, texture);

        const data = new Float32Array(tex.data);

        gl.texImage3D(
            gl.TEXTURE_3D,
            0,
            gl.RGB32F,
            tex.edgeLen,
            tex.edgeLen,
            tex.edgeLen,
            0,
            gl.RGB,
            gl.FLOAT,
            data
        );

        setTextureParams(gl.TEXTURE_3D);

        // Set uniform and cache location
        const location = gl.getUniformLocation(program, tex.samplerName);
        uniformCache.ocio3DSamplers.push({ name: tex.samplerName, location });
        if (location) {
            gl.uniform1i(location, textureUnit);
        }

        textureUnit++;
    }
}

function cleanupOCIOTextures(): void {
    if (!gl) return;

    for (const tex of ocioTextures) {
        gl.deleteTexture(tex);
    }
    ocioTextures = [];

    for (const tex of ocio3DTextures) {
        gl.deleteTexture(tex);
    }
    ocio3DTextures = [];

    // Clear uniform cache
    uniformCache = null;
}

function render(): void {
    if (!gl || !program || !imageTexture || !vao || !uniformCache) {
        return;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.1, 0.1, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.bindVertexArray(vao);

    // Bind image texture to unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, imageTexture);
    gl.uniform1i(uniformCache.u_image, 0);

    // Bind OCIO textures
    let textureUnit = 1;

    for (let i = 0; i < uniformCache.ocioSamplers.length; i++) {
        const sampler = uniformCache.ocioSamplers[i];
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_2D, ocioTextures[i]);
        if (sampler.location) {
            gl.uniform1i(sampler.location, textureUnit);
        }
        textureUnit++;
    }

    for (let i = 0; i < uniformCache.ocio3DSamplers.length; i++) {
        const sampler = uniformCache.ocio3DSamplers[i];
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(gl.TEXTURE_3D, ocio3DTextures[i]);
        if (sampler.location) {
            gl.uniform1i(sampler.location, textureUnit);
        }
        textureUnit++;
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateZoom(): void {
    if (!currentImage) return;

    if (zoomMode === 'fit') {
        zoom = getCalculatedFitZoom();
    }

    canvas.style.width = `${currentImage.width * zoom}px`;
    canvas.style.height = `${currentImage.height * zoom}px`;
    zoomInfo.textContent = `${Math.round(zoom * 100)}%`;
    updateZoomButtons();

    // Update pan controller: allow panning only when image overflows container
    if (panController) {
        const imageFitsInContainer =
            currentImage.width * zoom <= canvasContainer.clientWidth &&
            currentImage.height * zoom <= canvasContainer.clientHeight;
        panController.updateOptions({ imageFitsInContainer });
        updateCursorFromPanState(panController.getState());
    }
}

function getCalculatedFitZoom(): number {
    if (!currentImage || !canvasContainer) return 1.0;

    return calculateFitZoom(
        canvasContainer.clientWidth,
        canvasContainer.clientHeight,
        currentImage.width,
        currentImage.height
    );
}

function zoomToFit(): void {
    zoomMode = 'fit';
    updateZoom();
}

function zoomTo100(): void {
    zoomMode = 'manual';
    zoom = 1.0;
    updateZoom();
}

function updateZoomButtons(): void {
    zoomFitBtn.classList.toggle('active', zoomMode === 'fit');
    zoom100Btn.classList.toggle('active', zoomMode === 'manual' && zoom === 1.0);
}

// ============================================
// HDR Display Detection
// ============================================
// Note: HDR detection and monitoring is handled by hdrManager (shared/hdr-manager.ts)

/**
 * Disable HDR mode (called when display changes to SDR)
 */
function disableHDRMode(): void {
    if (!webgpuRenderer || !webgpuRenderer.isHDREnabled) return;

    webgpuRenderer.setHDRMode(false);
    hdrToggleBtn.classList.remove('active');
    log('[HDR] HDR mode disabled (display changed to SDR)');
}

function toggleHDRMode(): void {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('HDR mode requires WebGPU renderer');
        return;
    }

    // Check if HDR is supported on current display
    if (!hdrManager?.isSupported()) {
        log('HDR not supported on this display');
        return;
    }

    const newHDRState = !webgpuRenderer.isHDREnabled;
    webgpuRenderer.setHDRMode(newHDRState);
    hdrToggleBtn.classList.toggle('active', newHDRState);
    log(`HDR mode ${newHDRState ? 'enabled' : 'disabled'}`);
}

function onExportExr(): void {
    log('Export EXR button clicked');
    vscode.postMessage({ type: 'exportExr' });
}

function onWindowResize(): void {
    if (zoomMode === 'fit') {
        updateZoom();
    }
}

function onCanvasWheel(event: WheelEvent): void {
    event.preventDefault();

    // Switch to manual mode when user scrolls to zoom
    zoomMode = 'manual';

    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    zoom = Math.max(0.1, Math.min(10, zoom * delta));
    updateZoom();
}

// ============================================
// Pan (drag-to-scroll) handlers
// ============================================

function onPanStart(event: MouseEvent): void {
    if (!panController) return;
    const state = panController.startDrag(
        event.clientX, event.clientY,
        canvasContainer.scrollLeft, canvasContainer.scrollTop
    );
    updateCursorFromPanState(state);
}

function onPanMove(event: MouseEvent): void {
    if (!panController) return;
    const scroll = panController.updateDrag(event.clientX, event.clientY);
    if (scroll) {
        canvasContainer.scrollLeft = scroll.scrollLeft;
        canvasContainer.scrollTop = scroll.scrollTop;
    }
}

function onPanEnd(): void {
    if (!panController) return;
    const state = panController.endDrag();
    updateCursorFromPanState(state);
}

function updateCursorFromPanState(state: PanState): void {
    canvasContainer.classList.toggle('can-pan', state.cursor === 'grab');
    canvasContainer.classList.toggle('is-panning', state.cursor === 'grabbing');
}

/**
 * Handle keyboard shortcuts
 * - 'C': Toggle compute pipeline mode (for testing)
 * - 'Z': Toggle Zone System (false color exposure analysis)
 * - 'T': Run Fragment vs Compute comparison test
 * - 'P': Run performance benchmark
 * - 'H': Calculate GPU histogram
 * - 'S': Calculate GPU statistics (min/max/avg)
 */
function onKeyDown(event: KeyboardEvent): void {
    // Ignore if input element is focused
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
    }

    switch (event.key.toLowerCase()) {
        case 'c':
            toggleComputePipeline();
            break;
        case 'z':
            toggleZoneSystem();
            break;
        case 't':
            runComparisonTest();
            break;
        case 'p':
            runPerformanceBenchmark();
            break;
        case 'h':
            calculateGPUHistogram();
            break;
        case 's':
            calculateGPUStatistics();
            break;
    }
}

/**
 * Toggle between fragment shader and compute shader pipeline (for testing)
 */
function toggleComputePipeline(): void {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('Cannot toggle compute pipeline: WebGPU not available');
        return;
    }

    const enabled = !webgpuRenderer.isComputePipelineEnabled;
    webgpuRenderer.setUseComputePipeline(enabled);

    // Re-render with new pipeline
    if (currentImage) {
        webgpuRenderer.render();
    }

    // Show feedback to user
    log(`Compute pipeline ${enabled ? 'enabled' : 'disabled'} (press C to toggle)`);
}

/**
 * Toggle Zone System (false color exposure analysis)
 * Requires compute pipeline to be enabled
 */
async function toggleZoneSystem(): Promise<void> {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('Cannot toggle Zone System: WebGPU not available');
        return;
    }

    // Zone System requires compute pipeline
    if (!webgpuRenderer.isComputePipelineEnabled) {
        // Auto-enable compute pipeline
        webgpuRenderer.setUseComputePipeline(true);
        log('Auto-enabled compute pipeline for Zone System');
    }

    // Build Zone System pipeline if not already built
    const success = await webgpuRenderer.buildZoneSystemPipeline();
    if (!success) {
        log('Failed to build Zone System pipeline');
        return;
    }

    // Toggle Zone System
    const enabled = !webgpuRenderer.isZoneSystemEnabled;
    webgpuRenderer.setZoneSystemEnabled(enabled);

    // Re-render with Zone System
    if (currentImage) {
        webgpuRenderer.render();
    }

    // Show feedback to user
    log(`Zone System ${enabled ? 'enabled' : 'disabled'} (press Z to toggle)`);
}

/**
 * Run Fragment vs Compute pipeline comparison test
 */
async function runComparisonTest(): Promise<void> {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('Cannot run comparison test: WebGPU not available');
        return;
    }

    if (!currentImage) {
        log('Cannot run comparison test: No image loaded');
        return;
    }

    log('Running Fragment vs Compute comparison test...');

    try {
        const result = await webgpuRenderer.compareFragmentVsCompute();

        if (!result) {
            log('Comparison test failed: Unable to render');
            return;
        }

        // Format result for display
        const status = result.passed ? 'PASSED' : 'FAILED';
        log(`[Test Result] ${status}`);
        log(`  Max Error: ${result.maxError.toExponential(4)}`);
        log(`  Avg Error: ${result.avgError.toExponential(4)}`);
        log(`  PSNR: ${result.psnr.toFixed(2)} dB`);
        log(`  Matching: ${result.matchingPixels}/${result.totalPixels} (${(result.matchingPixels/result.totalPixels*100).toFixed(2)}%)`);

        // Send result to extension for logging
        vscode.postMessage({
            type: 'log',
            message: `Comparison test ${status}: MaxErr=${result.maxError.toExponential(4)}, PSNR=${result.psnr.toFixed(2)}dB`,
        });
    } catch (e) {
        log(`Comparison test error: ${e}`);
    }
}

/**
 * Run performance benchmark comparing Fragment vs Compute pipelines
 */
async function runPerformanceBenchmark(): Promise<void> {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('Cannot run benchmark: WebGPU not available');
        return;
    }

    if (!currentImage) {
        log('Cannot run benchmark: No image loaded');
        return;
    }

    log('Running performance benchmark (10 iterations)...');
    log(`Image: ${currentImage.width} x ${currentImage.height}`);

    try {
        const result = await webgpuRenderer.runPerformanceBenchmark(10);

        if (!result) {
            log('Benchmark failed');
            return;
        }

        // Format result for display
        log('[Benchmark Result]');
        log(`  Fragment: ${result.fragmentAvgMs.toFixed(3)}ms avg`);
        log(`  Compute:  ${result.computeAvgMs.toFixed(3)}ms avg`);
        log(`  Speedup: ${result.speedup.toFixed(2)}x ${result.speedup > 1 ? '(Compute faster)' : '(Fragment faster)'}`);

        // Send result to extension for logging
        vscode.postMessage({
            type: 'log',
            message: `Benchmark: Fragment=${result.fragmentAvgMs.toFixed(3)}ms, Compute=${result.computeAvgMs.toFixed(3)}ms, Speedup=${result.speedup.toFixed(2)}x`,
        });
    } catch (e) {
        log(`Benchmark error: ${e}`);
    }
}

/**
 * Calculate GPU histogram and display results
 */
async function calculateGPUHistogram(): Promise<void> {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('Cannot calculate GPU histogram: WebGPU not available');
        return;
    }

    if (!currentImage) {
        log('Cannot calculate GPU histogram: No image loaded');
        return;
    }

    log('Calculating GPU histogram...');
    const startTime = performance.now();

    try {
        // Build histogram pipeline if needed
        const pipelineBuilt = await webgpuRenderer.buildHistogramPipeline();
        if (!pipelineBuilt) {
            log('Failed to build histogram pipeline');
            return;
        }

        // Calculate histogram
        const result = await webgpuRenderer.calculateHistogramGPU();

        if (!result) {
            log('GPU histogram calculation failed');
            return;
        }

        const endTime = performance.now();
        const elapsed = endTime - startTime;

        // Find peak values
        const findPeak = (arr: Uint32Array) => {
            let max = 0;
            let maxIdx = 0;
            for (let i = 0; i < arr.length; i++) {
                if (arr[i] > max) {
                    max = arr[i];
                    maxIdx = i;
                }
            }
            return { value: max, bin: maxIdx };
        };

        const rPeak = findPeak(result.red);
        const gPeak = findPeak(result.green);
        const bPeak = findPeak(result.blue);
        const lumaPeak = findPeak(result.luminance);

        log(`[GPU Histogram] Calculated in ${elapsed.toFixed(2)}ms`);
        log(`  R peak: bin ${rPeak.bin} (${(rPeak.bin / 255).toFixed(3)}) with ${rPeak.value} pixels`);
        log(`  G peak: bin ${gPeak.bin} (${(gPeak.bin / 255).toFixed(3)}) with ${gPeak.value} pixels`);
        log(`  B peak: bin ${bPeak.bin} (${(bPeak.bin / 255).toFixed(3)}) with ${bPeak.value} pixels`);
        log(`  Luma peak: bin ${lumaPeak.bin} (${(lumaPeak.bin / 255).toFixed(3)}) with ${lumaPeak.value} pixels`);

        // Send result to extension
        vscode.postMessage({
            type: 'log',
            message: `GPU Histogram: ${elapsed.toFixed(2)}ms, R=${rPeak.bin}/255, G=${gPeak.bin}/255, B=${bPeak.bin}/255`,
        });
    } catch (e) {
        log(`GPU histogram error: ${e}`);
    }
}

/**
 * Calculate GPU statistics (min/max/avg) and display results
 */
async function calculateGPUStatistics(): Promise<void> {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log('Cannot calculate GPU statistics: WebGPU not available');
        return;
    }

    if (!currentImage) {
        log('Cannot calculate GPU statistics: No image loaded');
        return;
    }

    log('Calculating GPU statistics...');
    const startTime = performance.now();

    try {
        // Build statistics pipeline if needed
        const pipelineBuilt = await webgpuRenderer.buildStatisticsPipeline();
        if (!pipelineBuilt) {
            log('Failed to build statistics pipeline');
            return;
        }

        // Calculate statistics
        const result = await webgpuRenderer.calculateStatisticsGPU();

        if (!result) {
            log('GPU statistics calculation failed');
            return;
        }

        const endTime = performance.now();
        const elapsed = endTime - startTime;

        log(`[GPU Statistics] Calculated in ${elapsed.toFixed(2)}ms`);
        log(`  Min:  R=${result.min.r.toFixed(4)}, G=${result.min.g.toFixed(4)}, B=${result.min.b.toFixed(4)}, Luma=${result.min.luma.toFixed(4)}`);
        log(`  Max:  R=${result.max.r.toFixed(4)}, G=${result.max.g.toFixed(4)}, B=${result.max.b.toFixed(4)}, Luma=${result.max.luma.toFixed(4)}`);
        log(`  Avg:  R=${result.avg.r.toFixed(4)}, G=${result.avg.g.toFixed(4)}, B=${result.avg.b.toFixed(4)}, Luma=${result.avg.luma.toFixed(4)}`);

        // Send result to extension
        vscode.postMessage({
            type: 'log',
            message: `GPU Stats: ${elapsed.toFixed(2)}ms, Min=${result.min.luma.toFixed(4)}, Max=${result.max.luma.toFixed(4)}, Avg=${result.avg.luma.toFixed(4)}`,
        });
    } catch (e) {
        log(`GPU statistics error: ${e}`);
    }
}

function onCanvasMouseMove(event: MouseEvent): void {
    if (!currentImage || !gl || !pixelData) return;
    // Skip pixel info during drag-to-pan
    if (panController?.getState().isDragging) return;

    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / zoom);
    const y = Math.floor((event.clientY - rect.top) / zoom);

    if (x < 0 || x >= currentImage.width || y < 0 || y >= currentImage.height) {
        pixelInfo.textContent = '';
        return;
    }

    // Get pixel value from reconstructed Float32Array
    const idx = (y * currentImage.width + x) * currentImage.channels;
    const r = pixelData[idx] || 0;
    const g = pixelData[idx + 1] || 0;
    const b = pixelData[idx + 2] || 0;

    pixelInfo.textContent = `[${x}, ${y}] R: ${r.toFixed(4)} G: ${g.toFixed(4)} B: ${b.toFixed(4)}`;
}

function showError(message: string): void {
    showLoading(false);  // Hide loading overlay
    document.body.classList.add('error');
    const container = document.getElementById('canvas-container');
    if (container) {
        container.innerHTML = `<div class="error-message">${message}</div>`;
    }
    console.error('EXR Viewer error:', message);
}

// ============================================
// Sidebar Functions
// ============================================

// Minimum width when closed (just enough for the toggle button)
const SIDEBAR_CLOSED_WIDTH = 32;

function toggleSidebarLeft(): void {
    sidebarLeftOpen = !sidebarLeftOpen;
    sidebarLeft.classList.toggle('open', sidebarLeftOpen);
    sidebarLeft.classList.toggle('closed', !sidebarLeftOpen);
    sidebarLeftToggle.innerHTML = sidebarLeftOpen ? '&#9664;' : '&#9654;';
    updateSidebarLeftWidth();

    // Update zoom when sidebar toggled (affects canvas container size)
    if (zoomMode === 'fit') {
        setTimeout(updateZoom, 150); // Wait for CSS transition
    }
}

function toggleSidebarRight(): void {
    sidebarRightOpen = !sidebarRightOpen;
    sidebarRight.classList.toggle('open', sidebarRightOpen);
    sidebarRight.classList.toggle('closed', !sidebarRightOpen);
    sidebarRightToggle.innerHTML = sidebarRightOpen ? '&#9654;' : '&#9664;';
    updateSidebarRightWidth();

    // Update zoom when sidebar toggled (affects canvas container size)
    if (zoomMode === 'fit') {
        setTimeout(updateZoom, 150); // Wait for CSS transition
    }
}

function updateSidebarLeftWidth(): void {
    if (sidebarLeftOpen) {
        sidebarLeft.style.width = `${sidebarLeftWidth}px`;
        resizeHandleLeft.style.display = 'block';
    } else {
        sidebarLeft.style.width = `${SIDEBAR_CLOSED_WIDTH}px`;
        resizeHandleLeft.style.display = 'none';
    }
}

function updateSidebarRightWidth(): void {
    if (sidebarRightOpen) {
        sidebarRight.style.width = `${sidebarRightWidth}px`;
        resizeHandleRight.style.display = 'block';
    } else {
        sidebarRight.style.width = `${SIDEBAR_CLOSED_WIDTH}px`;
        resizeHandleRight.style.display = 'none';
    }
}

function startSidebarResize(e: MouseEvent, side: 'left' | 'right'): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === 'left' ? sidebarLeftWidth : sidebarRightWidth;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e: MouseEvent) => {
        if (side === 'left') {
            // Left sidebar: dragging right increases width
            const delta = e.clientX - startX;
            sidebarLeftWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta));
            updateSidebarLeftWidth();
        } else {
            // Right sidebar: dragging left increases width
            const delta = startX - e.clientX;
            sidebarRightWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta));
            updateSidebarRightWidth();
        }
    };

    const onMouseUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Update zoom when resize finished
        if (zoomMode === 'fit') {
            updateZoom();
        }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function setupSectionToggles(): void {
    const sectionHeaders = document.querySelectorAll('.section-header');
    sectionHeaders.forEach((header) => {
        header.addEventListener('click', () => {
            const sectionId = header.getAttribute('data-section');
            if (!sectionId) return;

            const section = document.getElementById(sectionId);
            if (!section) return;

            const toggle = header.querySelector('.section-toggle');
            const isOpen = section.style.display !== 'none';

            section.style.display = isOpen ? 'none' : 'block';
            header.classList.toggle('collapsed', isOpen);
            if (toggle) {
                toggle.innerHTML = isOpen ? '&#9654;' : '&#9660;';
            }
        });
    });
}

function updateMetadata(data: ExrImageData): void {
    metadataImageInfo.innerHTML = renderImageMetadata({
        width: data.width,
        height: data.height,
        channels: data.channels,
        colorSpace: data.colorSpace,
        bitDepth: data.bitDepth,
        compression: data.compression,
    });
}

// ============================================
// DCTL Functions
// ============================================

/**
 * Update the open DCTL files dropdown
 */
function updateOpenDctlFiles(files: { path: string; name: string }[]): void {
    log(`updateOpenDctlFiles: ${files.length} files`);
    openDctlFiles = files;

    // Preserve current selection if still available
    const currentPath = dctlFileSelect.value;

    // Rebuild select options
    dctlFileSelect.innerHTML = '<option value="">-- Select DCTL --</option>';

    for (const file of files) {
        const option = document.createElement('option');
        option.value = file.path;
        option.textContent = file.name;
        dctlFileSelect.appendChild(option);
    }

    // Add "Browse..." option
    const browseOption = document.createElement('option');
    browseOption.value = '__browse__';
    browseOption.textContent = '📁 Browse...';
    dctlFileSelect.appendChild(browseOption);

    // Restore selection if still available
    if (currentPath && files.some(f => f.path === currentPath)) {
        dctlFileSelect.value = currentPath;
    } else if (files.length === 1 && !dctlLoaded) {
        // Auto-select if only one DCTL is open and no DCTL is loaded yet
        dctlFileSelect.value = files[0].path;
        // Trigger load
        vscode.postMessage({ type: 'loadDctlFromPath', path: files[0].path });
    }
}

/**
 * Handle DCTL file select dropdown change
 */
function onDctlFileSelectChange(): void {
    const selectedPath = dctlFileSelect.value;

    if (selectedPath === '__browse__') {
        // Reset to empty and open file browser
        dctlFileSelect.value = '';
        vscode.postMessage({ type: 'selectDctlFile' });
    } else if (selectedPath) {
        // Load the selected DCTL file
        vscode.postMessage({ type: 'loadDctlFromPath', path: selectedPath });
    }
}

/**
 * Handle browse button click (opens file dialog)
 */
function onDctlFileBrowse(): void {
    vscode.postMessage({ type: 'selectDctlFile' });
}

function onDctlToggle(): void {
    const enabled = dctlEnabled.checked;
    vscode.postMessage({ type: 'toggleDctl', enabled });
}

function onRgcToggle(): void {
    const enabled = rgcEnabled.checked;
    const peakLuminance = parseInt(rgcPeakLuminanceSelect.value, 10);
    log(`onRgcToggle: enabled=${enabled}, peakLuminance=${peakLuminance}`);
    // Show/hide RGC options
    rgcOptions.style.display = enabled ? 'block' : 'none';
    // Send toggle message with current options
    vscode.postMessage({
        type: 'toggleRgc',
        enabled,
        peakLuminance,
    });
}

function onRgcPeakLuminanceChange(): void {
    if (!rgcEnabled.checked) return;
    vscode.postMessage({
        type: 'updateRgcSettings',
        peakLuminance: parseInt(rgcPeakLuminanceSelect.value, 10),
    });
}

function onDctlColorspaceChange(): void {
    dctlWorkingColorSpace = dctlColorspaceSelect.value;
    vscode.postMessage({
        type: 'changeDctlColorSpace',
        colorSpace: dctlWorkingColorSpace,
    });
}

/**
 * Populate the working color space dropdown with custom OCIO config color spaces.
 */
function populateCustomWorkingColorSpaces(colorSpaces: string[]): void {
    dctlColorspaceSelect.innerHTML = '';
    for (const cs of colorSpaces) {
        const option = document.createElement('option');
        option.value = cs;
        option.textContent = cs;
        dctlColorspaceSelect.appendChild(option);
    }
    if (colorSpaces.length > 0) {
        dctlColorspaceSelect.value = colorSpaces[0];
        dctlWorkingColorSpace = colorSpaces[0];
    }
}

interface DctlLoadData {
    filePath: string;
    params: DctlParam[];
    enabled: boolean;
    workingColorSpace: DctlColorSpace;
}

function loadDctl(data: DctlLoadData): void {
    log(`loadDctl: ${data.filePath}, ${data.params.length} params`);

    dctlLoaded = true;
    dctlParams = data.params;
    dctlWorkingColorSpace = data.workingColorSpace;

    // Initialize param values with defaults
    dctlParamValues = {};
    for (const param of data.params) {
        dctlParamValues[param.name] = param.default;
    }

    // Update UI
    dctlPanel.classList.remove('disabled');
    dctlEnabled.disabled = false;
    dctlEnabled.checked = data.enabled;
    dctlColorspaceSelect.value = data.workingColorSpace;

    // Update file select - add to list if not present, then select
    if (!openDctlFiles.some(f => f.path === data.filePath)) {
        const name = getFilename(data.filePath);
        openDctlFiles.push({ path: data.filePath, name });

        // Rebuild options
        const option = document.createElement('option');
        option.value = data.filePath;
        option.textContent = name;
        // Insert before "Browse..." option
        const browseOption = dctlFileSelect.querySelector('option[value="__browse__"]');
        if (browseOption) {
            dctlFileSelect.insertBefore(option, browseOption);
        } else {
            dctlFileSelect.appendChild(option);
        }
    }
    dctlFileSelect.value = data.filePath;

    // Build parameter controls
    dctlControlsManager?.build(data.params);
}

function unloadDctl(): void {
    log('unloadDctl');

    dctlLoaded = false;
    dctlParams = [];
    dctlParamValues = {};

    // Update UI
    dctlPanel.classList.add('disabled');
    dctlEnabled.disabled = true;
    dctlEnabled.checked = false;
    dctlFileSelect.value = '';

    // Clear parameter controls
    dctlControlsManager?.clear();
}

/**
 * Fast DCTL parameter update via Uniform Buffer (no shader recompilation)
 * Called when the extension sends 'updateDctlParamFast' message
 */
function updateDctlParamFast(name: string, value: unknown): void {
    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        log(`updateDctlParamFast: WebGPU not available, ignoring`);
        return;
    }

    if (!webgpuRenderer.isUniformBufferEnabled) {
        log(`updateDctlParamFast: Uniform buffer not enabled, ignoring`);
        return;
    }

    // Update local state
    dctlParamValues[name] = value as DctlParamValue;

    // Update GPU buffer and re-render
    webgpuRenderer.updateDctlParam(name, value as number | boolean | { r: number; g: number; b: number });
    webgpuRenderer.render();
}

function getFilename(filePath: string): string {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1] || filePath;
}

// ============================================
// Export Functions
// ============================================

/**
 * Build export shader for DCTL-only rendering
 */
async function buildExportShader(wgslShaderInfo: WgslShaderInfo): Promise<void> {
    log('buildExportShader called');

    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        vscode.postMessage({
            type: 'exportShaderBuilt',
            success: false,
            error: 'WebGPU renderer not available',
        });
        return;
    }

    try {
        const success = await webgpuRenderer.buildExportShader(wgslShaderInfo);
        vscode.postMessage({
            type: 'exportShaderBuilt',
            success,
            error: success ? undefined : 'Failed to build export shader',
        });
    } catch (e) {
        const errorMsg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
        console.error('[Export] buildExportShader error:', errorMsg);
        vscode.postMessage({
            type: 'exportShaderBuilt',
            success: false,
            error: `Error building export shader: ${e instanceof Error ? e.message : e}`,
        });
    }
}

/**
 * Export current image to buffer using export pipeline
 */
async function exportToBuffer(requestId: string): Promise<void> {
    log(`exportToBuffer called, requestId=${requestId}`);

    if (rendererMode !== 'webgpu' || !webgpuRenderer) {
        vscode.postMessage({
            type: 'exportBufferReady',
            requestId,
            success: false,
            error: 'WebGPU renderer not available',
        });
        return;
    }

    if (!currentImage) {
        vscode.postMessage({
            type: 'exportBufferReady',
            requestId,
            success: false,
            error: 'No image loaded',
        });
        return;
    }

    try {
        const pixels = await webgpuRenderer.renderToBuffer(currentImage.width, currentImage.height, true);

        if (!pixels) {
            vscode.postMessage({
                type: 'exportBufferReady',
                requestId,
                success: false,
                error: 'Failed to render to buffer',
            });
            return;
        }

        // Send the pixel data back to extension
        // Convert RGBA to RGB for EXR export (remove alpha channel)
        const numPixels = currentImage.width * currentImage.height;
        const rgbPixels = new Float32Array(numPixels * 3);
        let srcIdx = 0;
        let dstIdx = 0;
        for (let i = 0; i < numPixels; i++) {
            rgbPixels[dstIdx++] = pixels[srcIdx++]; // R
            rgbPixels[dstIdx++] = pixels[srcIdx++]; // G
            rgbPixels[dstIdx++] = pixels[srcIdx++]; // B
            srcIdx++; // Skip A
        }

        vscode.postMessage({
            type: 'exportBufferReady',
            requestId,
            success: true,
            width: currentImage.width,
            height: currentImage.height,
            buffer: rgbPixels.buffer,
        });

        // Cleanup export pipeline after use
        webgpuRenderer.cleanupExportPipeline();
    } catch (e) {
        const errorMsg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
        console.error('[Export] exportToBuffer error:', errorMsg);
        vscode.postMessage({
            type: 'exportBufferReady',
            requestId,
            success: false,
            error: `Error exporting: ${e instanceof Error ? e.message : e}`,
        });
    }
}

// Note: rgbToHex and hexToRgb are imported from shared/dctl-controls.ts
