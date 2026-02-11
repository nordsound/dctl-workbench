/**
 * Shared UI helper functions for webview components
 */

/**
 * VSCode API interface for posting messages
 */
export interface VSCodeAPI {
    postMessage(message: unknown): void;
}

/**
 * Create a logger function that logs to console and posts to VSCode
 */
export function createLogger(vscode: VSCodeAPI, prefix: string): (message: string) => void {
    return (message: string): void => {
        console.log(`[${prefix}] ${message}`);
        vscode.postMessage({ type: 'log', message });
    };
}

/**
 * Show error message in container
 */
export function showError(
    container: HTMLElement | null,
    message: string,
    log?: (msg: string) => void
): void {
    if (log) {
        log(`Error: ${message}`);
    }
    if (container) {
        container.innerHTML = `<div class="error-message">${message}</div>`;
    }
}

/**
 * Show/hide loading overlay
 */
export function showLoading(
    overlay: HTMLElement | null,
    show: boolean,
    message?: string,
    textElement?: HTMLElement | null
): void {
    if (!overlay) {
        console.error('[showLoading] ERROR: overlay element NOT FOUND!');
        return;
    }

    if (show) {
        if (textElement && message) {
            textElement.textContent = message;
        }
        overlay.classList.add('visible');
        overlay.classList.add('loading');
    } else {
        overlay.classList.remove('visible');
        overlay.classList.remove('loading');
    }
}

/**
 * Update zoom button states
 */
export function updateZoomButtons(
    zoomFitBtn: HTMLElement | null,
    zoom100Btn: HTMLElement | null,
    zoomMode: 'fit' | 'manual',
    currentZoom: number
): void {
    if (zoomFitBtn) {
        zoomFitBtn.classList.toggle('active', zoomMode === 'fit');
    }
    if (zoom100Btn) {
        zoom100Btn.classList.toggle('active', zoomMode === 'manual' && currentZoom === 1.0);
    }
}

/**
 * Calculate zoom level to fit image in container
 * @param containerWidth - Container width in pixels
 * @param containerHeight - Container height in pixels
 * @param imageWidth - Image width in pixels
 * @param imageHeight - Image height in pixels
 * @param padding - Optional padding on each side (default: 0)
 * @param maxZoom - Maximum zoom level (default: 1.0 - don't upscale)
 * @returns Zoom level (0.0 - maxZoom)
 */
export function calculateFitZoom(
    containerWidth: number,
    containerHeight: number,
    imageWidth: number,
    imageHeight: number,
    padding: number = 0,
    maxZoom: number = 1.0
): number {
    if (imageWidth <= 0 || imageHeight <= 0) return 1.0;

    const availableWidth = containerWidth - padding * 2;
    const availableHeight = containerHeight - padding * 2;

    const scaleX = availableWidth / imageWidth;
    const scaleY = availableHeight / imageHeight;

    return Math.min(scaleX, scaleY, maxZoom);
}
