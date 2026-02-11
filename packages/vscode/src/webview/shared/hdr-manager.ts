/**
 * HDR Display Detection and Management
 *
 * Provides a shared module for detecting HDR display capability
 * and monitoring display changes when windows move between monitors.
 */

/**
 * Options for creating an HDR manager
 */
export interface HDRManagerOptions {
    /** Logging function */
    log: (message: string) => void;
    /** Callback when HDR capability changes */
    onCapabilityChange: (supported: boolean, wasSupported: boolean) => void;
}

/**
 * HDR Manager interface
 */
export interface HDRManager {
    /** Check if current display supports HDR */
    isSupported(): boolean;
    /** Initialize HDR detection and start monitoring */
    init(): void;
    /** Update button state based on HDR support */
    updateButtonState(
        button: HTMLButtonElement | null,
        additionalDisableCondition?: boolean,
        disabledTitle?: string
    ): void;
    /** Clean up event listeners */
    destroy(): void;
}

/**
 * Create an HDR manager instance
 */
export function createHDRManager(options: HDRManagerOptions): HDRManager {
    const { log, onCapabilityChange } = options;

    let hdrSupported = false;
    let hdrMediaQuery: MediaQueryList | null = null;

    /**
     * Handle HDR capability change (initial check or display change)
     */
    function handleCapabilityChange(e: MediaQueryList | MediaQueryListEvent): void {
        const wasSupported = hdrSupported;
        hdrSupported = e.matches;

        log(`[HDR] handleCapabilityChange - wasSupported: ${wasSupported}, nowSupported: ${hdrSupported}`);

        // Notify via callback
        onCapabilityChange(hdrSupported, wasSupported);
    }

    return {
        isSupported(): boolean {
            return hdrSupported;
        },

        init(): void {
            log('[HDR] initHDRDetection called');

            // Create MediaQueryList for HDR detection
            hdrMediaQuery = window.matchMedia('(dynamic-range: high)');
            log(`[HDR] MediaQueryList created, media: "${hdrMediaQuery.media}", matches: ${hdrMediaQuery.matches}`);

            // Log color gamut info for debugging
            const p3Gamut = window.matchMedia('(color-gamut: p3)');
            const srgbGamut = window.matchMedia('(color-gamut: srgb)');
            const rec2020Gamut = window.matchMedia('(color-gamut: rec2020)');
            log(`[HDR] Color gamut - sRGB: ${srgbGamut.matches}, P3: ${p3Gamut.matches}, Rec.2020: ${rec2020Gamut.matches}`);

            // Check standard dynamic range as well
            const sdrQuery = window.matchMedia('(dynamic-range: standard)');
            log(`[HDR] dynamic-range: standard = ${sdrQuery.matches}`);

            // Check initial state
            handleCapabilityChange(hdrMediaQuery);

            // Monitor for display changes (window moved between monitors)
            hdrMediaQuery.addEventListener('change', handleCapabilityChange);

            log('[HDR] HDR detection initialized, monitoring for display changes');
        },

        updateButtonState(
            button: HTMLButtonElement | null,
            additionalDisableCondition = false,
            disabledTitle = 'HDR mode requires WebGPU'
        ): void {
            log(`[HDR] updateButtonState - button: ${!!button}, hdrSupported: ${hdrSupported}, additionalDisable: ${additionalDisableCondition}`);

            if (!button) {
                log('[HDR] WARNING: HDR button not found!');
                return;
            }

            // Check additional disable condition first (e.g., WebGL2 mode)
            if (additionalDisableCondition) {
                button.disabled = true;
                button.title = disabledTitle;
                button.classList.remove('active');
                log(`[HDR] Button disabled (${disabledTitle})`);
            } else if (!hdrSupported) {
                button.disabled = true;
                button.title = 'HDR not supported on this display';
                button.classList.remove('active');
                log('[HDR] Button disabled (HDR not supported)');
            } else {
                button.disabled = false;
                button.title = 'Toggle HDR mode (extended tone mapping)';
                log('[HDR] Button enabled (HDR supported)');
            }

            log(`[HDR] Button state after update - disabled: ${button.disabled}, title: "${button.title}"`);
        },

        destroy(): void {
            if (hdrMediaQuery) {
                hdrMediaQuery.removeEventListener('change', handleCapabilityChange);
                hdrMediaQuery = null;
            }
            log('[HDR] HDR manager destroyed');
        },
    };
}
