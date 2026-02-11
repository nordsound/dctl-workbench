/**
 * GPU Limits Checker
 *
 * Validates resource requirements against GPU limits before creation.
 * Prevents runtime errors from exceeding GPU capabilities.
 */

// ============================================
// Types
// ============================================

export interface ValidationResult {
    valid: boolean;
    error?: string;
    suggestion?: string;
}

export interface GPULimitsInfo {
    maxTextureDimension2D: number;
    maxTextureDimension3D: number;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxBindGroups: number;
    maxComputeWorkgroupSizeX: number;
    maxComputeWorkgroupSizeY: number;
    maxComputeWorkgroupSizeZ: number;
}

export interface GPULimitsChecker {
    /** Get the underlying limits */
    readonly limits: GPULimitsInfo;

    /** Check if a 2D texture can be created */
    canCreateTexture2D(width: number, height: number): boolean;

    /** Check if a 3D texture can be created */
    canCreateTexture3D(size: number): boolean;

    /** Check if a buffer can be created */
    canCreateBuffer(size: number): boolean;

    /** Validate image dimensions and get detailed result */
    validateImageSize(width: number, height: number): ValidationResult;

    /** Validate 3D LUT size and get detailed result */
    validateLUTSize(size: number): ValidationResult;

    /** Validate buffer size and get detailed result */
    validateBufferSize(size: number, usage?: string): ValidationResult;

    /** Get maximum supported image dimension */
    getMaxImageDimension(): number;

    /** Get maximum supported LUT size */
    getMaxLUTSize(): number;

    /** Log adapter info for debugging */
    logAdapterInfo(): void;
}

// ============================================
// Implementation
// ============================================

export interface CreateGPULimitsCheckerOptions {
    /** GPUDevice to get limits from */
    device: GPUDevice;
    /** GPUAdapter for additional info (optional) */
    adapter?: GPUAdapter;
    /** Logging function */
    log: (message: string) => void;
}

export function createGPULimitsChecker(options: CreateGPULimitsCheckerOptions): GPULimitsChecker {
    const { device, adapter, log } = options;
    const deviceLimits = device.limits;

    const limits: GPULimitsInfo = {
        maxTextureDimension2D: deviceLimits.maxTextureDimension2D,
        maxTextureDimension3D: deviceLimits.maxTextureDimension3D,
        maxBufferSize: deviceLimits.maxBufferSize,
        maxStorageBufferBindingSize: deviceLimits.maxStorageBufferBindingSize,
        maxBindGroups: deviceLimits.maxBindGroups,
        maxComputeWorkgroupSizeX: deviceLimits.maxComputeWorkgroupSizeX,
        maxComputeWorkgroupSizeY: deviceLimits.maxComputeWorkgroupSizeY,
        maxComputeWorkgroupSizeZ: deviceLimits.maxComputeWorkgroupSizeZ,
    };

    function formatBytes(bytes: number): string {
        if (bytes >= 1024 * 1024 * 1024) {
            return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        }
        if (bytes >= 1024 * 1024) {
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        }
        if (bytes >= 1024) {
            return `${(bytes / 1024).toFixed(2)} KB`;
        }
        return `${bytes} bytes`;
    }

    return {
        get limits(): GPULimitsInfo {
            return { ...limits };
        },

        canCreateTexture2D(width: number, height: number): boolean {
            return width <= limits.maxTextureDimension2D && height <= limits.maxTextureDimension2D;
        },

        canCreateTexture3D(size: number): boolean {
            return size <= limits.maxTextureDimension3D;
        },

        canCreateBuffer(size: number): boolean {
            return size <= limits.maxBufferSize;
        },

        validateImageSize(width: number, height: number): ValidationResult {
            const maxDim = limits.maxTextureDimension2D;

            if (width <= 0 || height <= 0) {
                return {
                    valid: false,
                    error: 'Invalid image dimensions (must be positive)',
                };
            }

            if (width > maxDim || height > maxDim) {
                const exceedingDim = width > maxDim ? 'width' : 'height';
                const exceedingValue = width > maxDim ? width : height;
                return {
                    valid: false,
                    error: `Image ${exceedingDim} (${exceedingValue}) exceeds GPU limit (${maxDim})`,
                    suggestion: `Resize the image to ${maxDim}x${maxDim} or smaller`,
                };
            }

            // Check memory estimate (4 channels * 4 bytes per channel = 16 bytes per pixel for rgba32float)
            const estimatedBytes = width * height * 16;
            if (estimatedBytes > limits.maxBufferSize) {
                return {
                    valid: false,
                    error: `Image memory requirement (${formatBytes(estimatedBytes)}) exceeds GPU limit (${formatBytes(limits.maxBufferSize)})`,
                    suggestion: 'Use a smaller image or lower precision format',
                };
            }

            return { valid: true };
        },

        validateLUTSize(size: number): ValidationResult {
            const maxDim = limits.maxTextureDimension3D;

            if (size <= 0) {
                return {
                    valid: false,
                    error: 'Invalid LUT size (must be positive)',
                };
            }

            if (size > maxDim) {
                return {
                    valid: false,
                    error: `LUT size (${size}) exceeds GPU 3D texture limit (${maxDim})`,
                    suggestion: `Use a LUT size of ${maxDim} or smaller`,
                };
            }

            // Check memory estimate (size^3 * 4 channels * 4 bytes for rgba32float)
            const estimatedBytes = size * size * size * 16;
            if (estimatedBytes > limits.maxBufferSize) {
                return {
                    valid: false,
                    error: `LUT memory requirement (${formatBytes(estimatedBytes)}) exceeds GPU limit`,
                    suggestion: 'Use a smaller LUT size',
                };
            }

            return { valid: true };
        },

        validateBufferSize(size: number, usage?: string): ValidationResult {
            if (size <= 0) {
                return {
                    valid: false,
                    error: 'Invalid buffer size (must be positive)',
                };
            }

            if (size > limits.maxBufferSize) {
                const usageStr = usage ? ` for ${usage}` : '';
                return {
                    valid: false,
                    error: `Buffer size${usageStr} (${formatBytes(size)}) exceeds GPU limit (${formatBytes(limits.maxBufferSize)})`,
                    suggestion: 'Split data into smaller chunks or use streaming',
                };
            }

            return { valid: true };
        },

        getMaxImageDimension(): number {
            return limits.maxTextureDimension2D;
        },

        getMaxLUTSize(): number {
            return limits.maxTextureDimension3D;
        },

        logAdapterInfo(): void {
            log('[GPU Limits]');
            log(`  maxTextureDimension2D: ${limits.maxTextureDimension2D}`);
            log(`  maxTextureDimension3D: ${limits.maxTextureDimension3D}`);
            log(`  maxBufferSize: ${formatBytes(limits.maxBufferSize)}`);
            log(`  maxStorageBufferBindingSize: ${formatBytes(limits.maxStorageBufferBindingSize)}`);
            log(`  maxBindGroups: ${limits.maxBindGroups}`);
            log(`  maxComputeWorkgroupSize: ${limits.maxComputeWorkgroupSizeX}x${limits.maxComputeWorkgroupSizeY}x${limits.maxComputeWorkgroupSizeZ}`);

            if (adapter) {
                try {
                    const info = adapter.info;
                    log('[GPU Adapter]');
                    log(`  vendor: ${info.vendor}`);
                    log(`  architecture: ${info.architecture}`);
                    log(`  device: ${info.device || '(not specified)'}`);
                    log(`  description: ${info.description || '(not specified)'}`);
                } catch {
                    log('[GPU Adapter] Info not available');
                }
            }
        },
    };
}
