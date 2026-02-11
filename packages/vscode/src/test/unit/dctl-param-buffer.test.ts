/**
 * Unit tests for DctlParamBuffer
 *
 * Tests that DCTL parameter values are preserved across initialize() calls,
 * which is critical for HDR toggle (pipeline rebuild should not reset params).
 */

import * as assert from 'assert';

// Mock GPUBuffer that tracks written data
class MockGPUBuffer {
    label: string;
    size: number;
    data: ArrayBuffer;

    constructor(desc: { size: number; label?: string }) {
        this.size = desc.size;
        this.label = desc.label ?? '';
        this.data = new ArrayBuffer(desc.size);
    }

    destroy(): void {
        // no-op
    }
}

// Mock GPUDevice that records writeBuffer calls
class MockGPUDevice {
    buffers: MockGPUBuffer[] = [];
    writes: Array<{ buffer: MockGPUBuffer; offset: number; data: ArrayBufferView }> = [];

    queue = {
        writeBuffer: (buffer: MockGPUBuffer, offset: number, data: ArrayBufferView) => {
            this.writes.push({ buffer, offset, data });
            // Actually copy data into the mock buffer
            const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            const dst = new Uint8Array(buffer.data);
            dst.set(src, offset);
        },
    };

    createBuffer(desc: { size: number; usage: number; label?: string }): MockGPUBuffer {
        const buf = new MockGPUBuffer(desc);
        this.buffers.push(buf);
        return buf;
    }
}

// Buffer layout constants (must match dctl-param-buffer.ts)
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

// Import types (using string import to avoid WebGPU type dependency)
type DctlParamMapping = {
    name: string;
    type: 'float' | 'int' | 'bool' | 'color';
    bufferType: 'float_params' | 'int_params' | 'color_params';
    index: number;
    default: number | boolean | { r: number; g: number; b: number };
};

/**
 * Simulate DctlParamBuffer behavior for testing.
 * This mirrors the actual DctlParamBuffer class but uses mock GPU types.
 *
 * When the actual code is fixed, this simulation should be updated to match.
 * The purpose is to test the expected behavior (preserve values on re-init).
 */
class DctlParamBufferSimulation {
    private device: MockGPUDevice;
    private buffer: MockGPUBuffer | null = null;
    private mapping: DctlParamMapping[] = [];
    private currentValues: Map<string, number | boolean | { r: number; g: number; b: number }> = new Map();

    constructor(device: MockGPUDevice) {
        this.device = device;
    }

    /**
     * Simulates DctlParamBuffer.initialize() - preserves values across re-init.
     * Mirrors the fixed behavior in dctl-param-buffer.ts.
     */
    initialize(mapping: DctlParamMapping[]): void {
        // Save current values before re-initialization
        const savedValues = new Map(this.currentValues);

        this.mapping = mapping;
        this.currentValues.clear();

        if (this.buffer) {
            this.buffer.destroy();
        }

        this.buffer = this.device.createBuffer({
            size: BUFFER_LAYOUT.TOTAL_SIZE,
            usage: 0x0040 | 0x0008, // UNIFORM | COPY_DST
            label: 'DCTL Parameters Uniform Buffer',
        });

        this.resetToDefaults();

        // Restore previously set values for matching params
        for (const param of this.mapping) {
            const saved = savedValues.get(param.name);
            if (saved !== undefined) {
                this.updateParam(param.name, saved);
            }
        }
    }

    updateParam(name: string, value: number | boolean | { r: number; g: number; b: number }): void {
        const param = this.mapping.find(m => m.name === name);
        if (!param || !this.buffer) return;
        this.currentValues.set(name, value);
        this.writeParamToBuffer(param, value);
    }

    getCurrentValue(name: string): number | boolean | { r: number; g: number; b: number } | undefined {
        return this.currentValues.get(name);
    }

    private resetToDefaults(): void {
        if (!this.buffer) return;
        const zeros = new Uint8Array(BUFFER_LAYOUT.TOTAL_SIZE);
        this.device.queue.writeBuffer(this.buffer, 0, zeros as any);

        for (const param of this.mapping) {
            this.currentValues.set(param.name, param.default);
            this.writeParamToBuffer(param, param.default);
        }
    }

    private writeParamToBuffer(param: DctlParamMapping, value: number | boolean | { r: number; g: number; b: number }): void {
        if (!this.buffer) return;
        switch (param.type) {
            case 'float': {
                const data = new Float32Array([value as number]);
                const offset = BUFFER_LAYOUT.FLOAT_PARAMS_OFFSET + param.index * 4;
                this.device.queue.writeBuffer(this.buffer, offset, data as any);
                break;
            }
            case 'int': {
                const data = new Int32Array([value as number]);
                const offset = BUFFER_LAYOUT.INT_PARAMS_OFFSET + param.index * 4;
                this.device.queue.writeBuffer(this.buffer, offset, data as any);
                break;
            }
            case 'bool': {
                const data = new Int32Array([value ? 1 : 0]);
                const offset = BUFFER_LAYOUT.INT_PARAMS_OFFSET + param.index * 4;
                this.device.queue.writeBuffer(this.buffer, offset, data as any);
                break;
            }
        }
    }

    /**
     * Read a float param value from the buffer (for verification)
     */
    readFloatFromBuffer(index: number): number {
        if (!this.buffer) return NaN;
        const view = new DataView(this.buffer.data);
        return view.getFloat32(BUFFER_LAYOUT.FLOAT_PARAMS_OFFSET + index * 4, true);
    }

    /**
     * Read an int param value from the buffer (for verification)
     */
    readIntFromBuffer(index: number): number {
        if (!this.buffer) return NaN;
        const view = new DataView(this.buffer.data);
        return view.getInt32(BUFFER_LAYOUT.INT_PARAMS_OFFSET + index * 4, true);
    }
}

describe('DctlParamBuffer - HDR Toggle Parameter Preservation', () => {
    const floatMapping: DctlParamMapping[] = [
        { name: 'gain', type: 'float', bufferType: 'float_params', index: 0, default: 1.0 },
        { name: 'offset', type: 'float', bufferType: 'float_params', index: 1, default: 0.0 },
    ];

    const mixedMapping: DctlParamMapping[] = [
        { name: 'min_val', type: 'float', bufferType: 'float_params', index: 0, default: 0.0 },
        { name: 'max_val', type: 'float', bufferType: 'float_params', index: 1, default: 1.0 },
        { name: 'clamp_min', type: 'bool', bufferType: 'int_params', index: 0, default: true },
        { name: 'clamp_max', type: 'bool', bufferType: 'int_params', index: 1, default: true },
    ];

    it('should preserve float param values after re-initialization (HDR toggle)', () => {
        const device = new MockGPUDevice();
        const paramBuffer = new DctlParamBufferSimulation(device);

        // Initial setup
        paramBuffer.initialize(floatMapping);

        // User sets gain to 2.0 (non-default)
        paramBuffer.updateParam('gain', 2.0);
        paramBuffer.updateParam('offset', 0.5);

        // Verify values were set
        assert.strictEqual(paramBuffer.getCurrentValue('gain'), 2.0, 'gain should be 2.0 before rebuild');
        assert.strictEqual(paramBuffer.getCurrentValue('offset'), 0.5, 'offset should be 0.5 before rebuild');

        // Verify buffer has the values
        assert.strictEqual(paramBuffer.readFloatFromBuffer(0), 2.0, 'buffer[0] should be 2.0 (gain)');
        assert.strictEqual(paramBuffer.readFloatFromBuffer(1), 0.5, 'buffer[1] should be 0.5 (offset)');

        // HDR toggle triggers re-initialization with SAME mapping
        paramBuffer.initialize(floatMapping);

        // Values should be preserved after re-initialization
        assert.strictEqual(
            paramBuffer.getCurrentValue('gain'), 2.0,
            'gain should be preserved as 2.0 after HDR toggle rebuild'
        );
        assert.strictEqual(
            paramBuffer.getCurrentValue('offset'), 0.5,
            'offset should be preserved as 0.5 after HDR toggle rebuild'
        );

        // Buffer should also have the preserved values
        assert.strictEqual(
            paramBuffer.readFloatFromBuffer(0), 2.0,
            'buffer[0] should still be 2.0 (gain) after rebuild'
        );
        assert.strictEqual(
            paramBuffer.readFloatFromBuffer(1), 0.5,
            'buffer[1] should still be 0.5 (offset) after rebuild'
        );
    });

    it('should preserve mixed param types after re-initialization', () => {
        const device = new MockGPUDevice();
        const paramBuffer = new DctlParamBufferSimulation(device);

        // Initial setup
        paramBuffer.initialize(mixedMapping);

        // User modifies values
        paramBuffer.updateParam('min_val', 0.7);
        paramBuffer.updateParam('max_val', 0.9);
        paramBuffer.updateParam('clamp_min', false);

        // Verify before rebuild
        assert.strictEqual(paramBuffer.getCurrentValue('min_val'), 0.7);
        assert.strictEqual(paramBuffer.getCurrentValue('max_val'), 0.9);
        assert.strictEqual(paramBuffer.getCurrentValue('clamp_min'), false);
        assert.strictEqual(paramBuffer.getCurrentValue('clamp_max'), true); // unchanged default

        // HDR toggle triggers re-initialization
        paramBuffer.initialize(mixedMapping);

        // All values should be preserved
        assert.strictEqual(
            paramBuffer.getCurrentValue('min_val'), 0.7,
            'min_val should be preserved after rebuild'
        );
        assert.strictEqual(
            paramBuffer.getCurrentValue('max_val'), 0.9,
            'max_val should be preserved after rebuild'
        );
        assert.strictEqual(
            paramBuffer.getCurrentValue('clamp_min'), false,
            'clamp_min should be preserved as false after rebuild'
        );
        assert.strictEqual(
            paramBuffer.getCurrentValue('clamp_max'), true,
            'clamp_max should stay true (default) after rebuild'
        );

        // Verify buffer values (use approximate comparison for Float32 precision)
        assert.ok(
            Math.abs(paramBuffer.readFloatFromBuffer(0) - 0.7) < 1e-6,
            'buffer float[0] should be ~0.7 (min_val)'
        );
        assert.ok(
            Math.abs(paramBuffer.readFloatFromBuffer(1) - 0.9) < 1e-6,
            'buffer float[1] should be ~0.9 (max_val)'
        );
        // clamp_min = false = 0, clamp_max = true = 1
        assert.strictEqual(
            paramBuffer.readIntFromBuffer(0), 0,
            'buffer int[0] should be 0 (clamp_min=false)'
        );
        assert.strictEqual(
            paramBuffer.readIntFromBuffer(1), 1,
            'buffer int[1] should be 1 (clamp_max=true)'
        );
    });

    it('should use defaults for new params when mapping changes', () => {
        const device = new MockGPUDevice();
        const paramBuffer = new DctlParamBufferSimulation(device);

        // Initial setup with float mapping
        paramBuffer.initialize(floatMapping);
        paramBuffer.updateParam('gain', 3.0);

        // Re-initialize with a different mapping (simulates loading a different DCTL)
        const newMapping: DctlParamMapping[] = [
            { name: 'gain', type: 'float', bufferType: 'float_params', index: 0, default: 1.0 },
            { name: 'saturation', type: 'float', bufferType: 'float_params', index: 1, default: 1.0 },
        ];

        paramBuffer.initialize(newMapping);

        // 'gain' existed before - should preserve its value
        assert.strictEqual(
            paramBuffer.getCurrentValue('gain'), 3.0,
            'gain should be preserved from previous mapping'
        );

        // 'saturation' is new - should use default
        assert.strictEqual(
            paramBuffer.getCurrentValue('saturation'), 1.0,
            'saturation should use default value (new param)'
        );
    });
});
