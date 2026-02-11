/**
 * DCTL Parameter Buffer Manager
 *
 * Manages GPU uniform buffer for DCTL parameters.
 * Enables fast parameter updates without shader recompilation.
 */

import type { DctlColorValue } from './shared/dctl-controls';

/**
 * Parameter type mapping for buffer layout
 */
export type DctlParamType = 'float' | 'int' | 'bool' | 'color';

/**
 * Parameter mapping information
 */
export interface DctlParamMapping {
    /** Parameter name (original from DCTL) */
    name: string;
    /** Parameter type */
    type: DctlParamType;
    /** Buffer array type */
    bufferType: 'float_params' | 'int_params' | 'color_params';
    /** Index within the buffer array */
    index: number;
    /** Default value */
    default: number | boolean | DctlColorValue;
}

/**
 * Buffer layout constants (std140 alignment)
 *
 * struct DctlParams {
 *     enabled: u32,        // offset 0
 *     _pad0-2: u32[3],     // offset 4-12 (padding to 16-byte alignment)
 *     float_params: f32[32], // offset 16, 128 bytes
 *     int_params: i32[16],   // offset 144, 64 bytes
 *     color_params: vec4[8], // offset 208, 128 bytes
 * }
 * Total: 336 bytes
 */
const BUFFER_LAYOUT = {
    ENABLED_OFFSET: 0,
    FLOAT_PARAMS_OFFSET: 16,
    FLOAT_PARAMS_COUNT: 32,
    INT_PARAMS_OFFSET: 16 + 32 * 4,  // 144
    INT_PARAMS_COUNT: 16,
    COLOR_PARAMS_OFFSET: 16 + 32 * 4 + 16 * 4,  // 208
    COLOR_PARAMS_COUNT: 8,
    TOTAL_SIZE: 16 + 32 * 4 + 16 * 4 + 8 * 16,  // 336 bytes
} as const;

/**
 * DCTL Parameter Buffer Manager
 *
 * Provides fast parameter updates via GPU uniform buffer.
 */
export class DctlParamBuffer {
    private device: GPUDevice;
    private buffer: GPUBuffer | null = null;
    private mapping: DctlParamMapping[] = [];
    private currentValues: Map<string, number | boolean | DctlColorValue> = new Map();

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /**
     * Initialize buffer with parameter mapping
     * Preserves existing parameter values when possible (e.g., during HDR toggle rebuild)
     */
    initialize(mapping: DctlParamMapping[]): void {
        // Save current values before re-initialization
        const savedValues = new Map(this.currentValues);

        this.mapping = mapping;
        this.currentValues.clear();

        // Destroy existing buffer
        if (this.buffer) {
            this.buffer.destroy();
        }

        // Create new buffer
        this.buffer = this.device.createBuffer({
            size: BUFFER_LAYOUT.TOTAL_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'DCTL Parameters Uniform Buffer',
        });

        // Initialize with default values
        this.resetToDefaults();

        // Restore previously set values for matching params
        for (const param of this.mapping) {
            const saved = savedValues.get(param.name);
            if (saved !== undefined) {
                this.updateParam(param.name, saved);
            }
        }
    }

    /**
     * Update a single parameter (fast path)
     */
    updateParam(name: string, value: number | boolean | DctlColorValue): void {
        const param = this.mapping.find(m => m.name === name);
        if (!param || !this.buffer) return;

        // Skip if value hasn't changed
        const current = this.currentValues.get(name);
        if (this.valuesEqual(current, value)) return;

        this.currentValues.set(name, value);
        this.writeParamToBuffer(param, value);
    }

    /**
     * Update multiple parameters at once
     */
    updateParams(values: Record<string, number | boolean | DctlColorValue>): void {
        for (const [name, value] of Object.entries(values)) {
            this.updateParam(name, value);
        }
    }

    /**
     * Set enabled/disabled state
     */
    setEnabled(enabled: boolean): void {
        if (!this.buffer) return;
        const data = new Uint32Array([enabled ? 1 : 0]);
        this.device.queue.writeBuffer(this.buffer, BUFFER_LAYOUT.ENABLED_OFFSET, data);
    }

    /**
     * Reset all parameters to default values
     */
    resetToDefaults(): void {
        if (!this.buffer) return;

        // Clear buffer first
        const zeros = new Uint8Array(BUFFER_LAYOUT.TOTAL_SIZE);
        this.device.queue.writeBuffer(this.buffer, 0, zeros);

        // Set enabled to true
        this.setEnabled(true);

        // Set default values
        for (const param of this.mapping) {
            this.currentValues.set(param.name, param.default);
            this.writeParamToBuffer(param, param.default);
        }
    }

    /**
     * Get the GPU buffer for bind group creation
     */
    getBuffer(): GPUBuffer | null {
        return this.buffer;
    }

    /**
     * Get buffer size
     */
    getBufferSize(): number {
        return BUFFER_LAYOUT.TOTAL_SIZE;
    }

    /**
     * Get current parameter mapping
     */
    getMapping(): DctlParamMapping[] {
        return this.mapping;
    }

    /**
     * Check if buffer is initialized
     */
    isInitialized(): boolean {
        return this.buffer !== null && this.mapping.length > 0;
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.buffer) {
            this.buffer.destroy();
            this.buffer = null;
        }
        this.mapping = [];
        this.currentValues.clear();
    }

    /**
     * Write a parameter value to the buffer
     */
    private writeParamToBuffer(param: DctlParamMapping, value: number | boolean | DctlColorValue): void {
        if (!this.buffer) return;

        switch (param.type) {
            case 'float': {
                const data = new Float32Array([value as number]);
                const offset = BUFFER_LAYOUT.FLOAT_PARAMS_OFFSET + param.index * 4;
                this.device.queue.writeBuffer(this.buffer, offset, data);
                break;
            }
            case 'int': {
                const data = new Int32Array([value as number]);
                const offset = BUFFER_LAYOUT.INT_PARAMS_OFFSET + param.index * 4;
                this.device.queue.writeBuffer(this.buffer, offset, data);
                break;
            }
            case 'bool': {
                const data = new Int32Array([value ? 1 : 0]);
                const offset = BUFFER_LAYOUT.INT_PARAMS_OFFSET + param.index * 4;
                this.device.queue.writeBuffer(this.buffer, offset, data);
                break;
            }
            case 'color': {
                const color = value as DctlColorValue;
                // vec4 for alignment (w = 1.0)
                const data = new Float32Array([color.r, color.g, color.b, 1.0]);
                const offset = BUFFER_LAYOUT.COLOR_PARAMS_OFFSET + param.index * 16;
                this.device.queue.writeBuffer(this.buffer, offset, data);
                break;
            }
        }
    }

    /**
     * Check if two values are equal
     */
    private valuesEqual(
        a: number | boolean | DctlColorValue | undefined,
        b: number | boolean | DctlColorValue
    ): boolean {
        if (a === undefined) return false;
        if (typeof a !== typeof b) return false;

        if (typeof a === 'object' && typeof b === 'object') {
            const colorA = a as DctlColorValue;
            const colorB = b as DctlColorValue;
            return colorA.r === colorB.r && colorA.g === colorB.g && colorA.b === colorB.b;
        }

        return a === b;
    }
}

/**
 * Build parameter mapping from DCTL params
 */
export function buildParamMapping(params: Array<{
    name: string;
    type: string;
    default: number | boolean | DctlColorValue;
}>): DctlParamMapping[] {
    const mapping: DctlParamMapping[] = [];
    let floatIndex = 0;
    let intIndex = 0;
    let colorIndex = 0;

    for (const param of params) {
        switch (param.type) {
            case 'DCTL_SLIDER_FLOAT':
            case 'DCTL_VALUE_BOX':
                if (floatIndex >= BUFFER_LAYOUT.FLOAT_PARAMS_COUNT) {
                    console.warn(`Too many float params, skipping ${param.name}`);
                    continue;
                }
                mapping.push({
                    name: param.name,
                    type: 'float',
                    bufferType: 'float_params',
                    index: floatIndex++,
                    default: param.default as number,
                });
                break;

            case 'DCTL_SLIDER_INT':
            case 'DCTL_COMBO_BOX':
                if (intIndex >= BUFFER_LAYOUT.INT_PARAMS_COUNT) {
                    console.warn(`Too many int params, skipping ${param.name}`);
                    continue;
                }
                mapping.push({
                    name: param.name,
                    type: 'int',
                    bufferType: 'int_params',
                    index: intIndex++,
                    default: param.default as number,
                });
                break;

            case 'DCTL_CHECK_BOX':
                if (intIndex >= BUFFER_LAYOUT.INT_PARAMS_COUNT) {
                    console.warn(`Too many bool params, skipping ${param.name}`);
                    continue;
                }
                mapping.push({
                    name: param.name,
                    type: 'bool',
                    bufferType: 'int_params',
                    index: intIndex++,
                    default: param.default as boolean,
                });
                break;

            case 'DCTL_COLOR_PICKER':
                if (colorIndex >= BUFFER_LAYOUT.COLOR_PARAMS_COUNT) {
                    console.warn(`Too many color params, skipping ${param.name}`);
                    continue;
                }
                mapping.push({
                    name: param.name,
                    type: 'color',
                    bufferType: 'color_params',
                    index: colorIndex++,
                    default: param.default as DctlColorValue,
                });
                break;
        }
    }

    return mapping;
}

/**
 * Get buffer layout constants (for shader generation)
 */
export function getBufferLayout(): typeof BUFFER_LAYOUT {
    return BUFFER_LAYOUT;
}
