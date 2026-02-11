/**
 * GPU Feature Detector
 *
 * Detects optional WebGPU features and provides feature-specific utilities.
 * Enables graceful degradation when features are unavailable.
 */

// ============================================
// Types
// ============================================

/** Optional WebGPU features that can be requested */
export type OptionalGPUFeature =
    | 'timestamp-query'
    | 'shader-f16'
    | 'float32-filterable'
    | 'subgroups'
    | 'subgroups-f16';

/** Feature detection result */
export interface GPUFeatureInfo {
    /** Feature name */
    name: OptionalGPUFeature;
    /** Whether the feature is supported by the adapter */
    supported: boolean;
    /** Whether the feature was requested and enabled on the device */
    enabled: boolean;
}

/** GPU capabilities summary */
export interface GPUCapabilities {
    /** Adapter vendor (e.g., "apple", "nvidia", "amd") */
    vendor: string;
    /** GPU architecture (e.g., "metal-3", "ampere") */
    architecture: string;
    /** Device description */
    description: string;
    /** Map of feature name to feature info */
    features: Map<OptionalGPUFeature, GPUFeatureInfo>;
    /** All supported feature names */
    supportedFeatures: OptionalGPUFeature[];
    /** All enabled feature names */
    enabledFeatures: OptionalGPUFeature[];
}

export interface GPUFeatureDetectorOptions {
    /** GPUAdapter to check features on */
    adapter: GPUAdapter;
    /** GPUDevice (optional, to check enabled features) */
    device?: GPUDevice;
    /** Logging function */
    log?: (message: string) => void;
}

export interface GPUFeatureDetector {
    /** Get full capabilities summary */
    readonly capabilities: GPUCapabilities;

    /** Check if a feature is supported by the adapter */
    isSupported(feature: OptionalGPUFeature): boolean;

    /** Check if a feature is enabled on the device */
    isEnabled(feature: OptionalGPUFeature): boolean;

    /** Get list of features to request when creating device */
    getRequestableFeatures(): GPUFeatureName[];

    /** Log capabilities to console */
    logCapabilities(): void;
}

// ============================================
// Implementation
// ============================================

/** Features we care about detecting */
const OPTIONAL_FEATURES: OptionalGPUFeature[] = [
    'timestamp-query',
    'shader-f16',
    'float32-filterable',
    'subgroups',
    'subgroups-f16',
];

export function createGPUFeatureDetector(options: GPUFeatureDetectorOptions): GPUFeatureDetector {
    const { adapter, device, log } = options;

    // Get adapter info
    const adapterInfo = adapter.info;
    const vendor = adapterInfo.vendor || 'unknown';
    const architecture = adapterInfo.architecture || 'unknown';
    const description = adapterInfo.description || '';

    // Detect features
    const features = new Map<OptionalGPUFeature, GPUFeatureInfo>();
    const supportedFeatures: OptionalGPUFeature[] = [];
    const enabledFeatures: OptionalGPUFeature[] = [];

    for (const feature of OPTIONAL_FEATURES) {
        const supported = adapter.features.has(feature);
        const enabled = device ? device.features.has(feature) : false;

        features.set(feature, {
            name: feature,
            supported,
            enabled,
        });

        if (supported) {
            supportedFeatures.push(feature);
        }
        if (enabled) {
            enabledFeatures.push(feature);
        }
    }

    const capabilities: GPUCapabilities = {
        vendor,
        architecture,
        description,
        features,
        supportedFeatures,
        enabledFeatures,
    };

    return {
        get capabilities(): GPUCapabilities {
            return capabilities;
        },

        isSupported(feature: OptionalGPUFeature): boolean {
            return features.get(feature)?.supported ?? false;
        },

        isEnabled(feature: OptionalGPUFeature): boolean {
            return features.get(feature)?.enabled ?? false;
        },

        getRequestableFeatures(): GPUFeatureName[] {
            // Return features that are supported and safe to request
            return supportedFeatures.filter((f) => {
                // Exclude features that might cause issues
                // For now, all supported features are safe to request
                return true;
            }) as GPUFeatureName[];
        },

        logCapabilities(): void {
            if (!log) return;

            log('[GPU Capabilities]');
            log(`  Vendor: ${vendor}`);
            log(`  Architecture: ${architecture}`);
            if (description) {
                log(`  Description: ${description}`);
            }

            log('[GPU Features]');
            for (const [name, info] of features) {
                const status = info.enabled ? 'ENABLED' : info.supported ? 'supported' : 'unsupported';
                log(`  ${name}: ${status}`);
            }
        },
    };
}

// ============================================
// Subgroups Utilities
// ============================================

export interface SubgroupsInfo {
    /** Whether subgroups feature is available */
    available: boolean;
    /** Minimum subgroup size (usually 4, 8, 16, 32, or 64) */
    minSize: number;
    /** Maximum subgroup size */
    maxSize: number;
}

/**
 * Get subgroups information from device limits
 * Note: subgroupMinSize/maxSize are exposed via device.limits when feature is enabled
 */
export function getSubgroupsInfo(device: GPUDevice): SubgroupsInfo {
    const hasSubgroups = device.features.has('subgroups');

    if (!hasSubgroups) {
        return {
            available: false,
            minSize: 1,
            maxSize: 1,
        };
    }

    // Access subgroup limits from device
    // These are available when 'subgroups' feature is enabled
    const limits = device.limits as GPUSupportedLimits & {
        minSubgroupSize?: number;
        maxSubgroupSize?: number;
    };

    return {
        available: true,
        minSize: limits.minSubgroupSize ?? 4,
        maxSize: limits.maxSubgroupSize ?? 64,
    };
}

// ============================================
// Shader Code Generation Helpers
// ============================================

/**
 * Generate shader header for optional features
 * Adds enable directives for supported features
 */
export function generateShaderFeatureHeader(device: GPUDevice): string {
    const lines: string[] = [];

    // Enable f16 if available
    if (device.features.has('shader-f16')) {
        lines.push('enable f16;');
    }

    // Enable subgroups if available
    if (device.features.has('subgroups')) {
        lines.push('enable subgroups;');
    }

    // Enable subgroups_f16 if available
    if (device.features.has('subgroups-f16')) {
        lines.push('enable subgroups_f16;');
    }

    if (lines.length > 0) {
        lines.push(''); // Empty line after enables
    }

    return lines.join('\n');
}

/**
 * Check if f16 types can be used in shaders
 */
export function canUseF16(device: GPUDevice): boolean {
    return device.features.has('shader-f16');
}

/**
 * Check if subgroup operations can be used in compute shaders
 */
export function canUseSubgroups(device: GPUDevice): boolean {
    return device.features.has('subgroups');
}
