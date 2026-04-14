/**
 * WASM Memory Management Utilities
 *
 * Provides safe, RAII-style memory management for Emscripten WASM modules.
 * Prevents common pitfalls like memory leaks and detached buffer access.
 *
 * Originally derived from vscode-raw-viewer's src/utils/wasm-memory.ts.
 * Extended in dctl-workbench with int32 scalar accessors so that EXR
 * dimension queries (i32 reads) can also use the WasmMemoryBlock API.
 */

/**
 * Emscripten module interface (minimal)
 *
 * Only the heap views and the malloc/free pair that this utility uses
 * are required. Real Emscripten modules expose many more symbols, but
 * the WasmMemoryBlock implementation deliberately stays narrow.
 */
export interface EmscriptenModule {
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAP8: Int8Array;
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
    HEAPU16: Uint16Array;
    HEAP32: Int32Array;
    HEAPU32: Uint32Array;
    HEAPF32: Float32Array;
    HEAPF64: Float64Array;
}

/**
 * Managed WASM memory block
 *
 * Wraps a malloc'd memory region with safe accessors.
 * Always call free() when done, or use useWasmMemory() for automatic cleanup.
 */
export class WasmMemoryBlock {
    private _ptr: number;
    private _size: number;
    private _module: EmscriptenModule;
    private _isFreed: boolean = false;

    constructor(module: EmscriptenModule, size: number) {
        if (size <= 0) {
            throw new Error('Memory size must be positive');
        }
        this._module = module;
        this._size = size;

        // Allocate memory
        this._ptr = module._malloc(size);
        if (this._ptr === 0) {
            throw new Error('Failed to allocate WASM memory (OOM)');
        }
    }

    /**
     * WASM memory address (pointer)
     * Pass this to C++ functions
     */
    get ptr(): number {
        this.checkFreed();
        return this._ptr;
    }

    /**
     * Allocated size in bytes
     */
    get size(): number {
        return this._size;
    }

    /**
     * Check if memory has been freed
     */
    get isFreed(): boolean {
        return this._isFreed;
    }

    /**
     * Write JS data to WASM memory
     * @param data Data to write (TypedArray or ArrayBuffer)
     * @param offset Offset in WASM memory (default: 0)
     */
    write(data: Uint8Array | ArrayBuffer, offset: number = 0): void {
        this.checkFreed();
        const src = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

        if (offset + src.byteLength > this._size) {
            throw new Error('Data size exceeds allocated memory block');
        }

        // Always access HEAPU8 fresh to avoid detached buffer issues
        this._module.HEAPU8.set(src, this._ptr + offset);
    }

    /**
     * Write Float32Array to WASM memory
     * @param data Float32 data to write
     */
    writeFloat32(data: Float32Array): void {
        this.checkFreed();
        if (data.byteLength > this._size) {
            throw new Error('Data size exceeds allocated memory block');
        }

        // Create fresh view and copy
        const heapView = new Float32Array(
            this._module.HEAPF32.buffer,
            this._ptr,
            data.length
        );
        heapView.set(data);
    }

    /**
     * Write a single signed 32-bit integer at the given byte offset.
     *
     * @param value Value to write
     * @param offset Byte offset within the block (default: 0). Must be 4-byte aligned.
     */
    writeInt32(value: number, offset: number = 0): void {
        this.checkFreed();
        if (offset < 0 || offset + 4 > this._size) {
            throw new Error('Int32 write would exceed allocated memory block');
        }
        if ((this._ptr + offset) % 4 !== 0) {
            throw new Error('Int32 write requires 4-byte aligned offset');
        }
        const index = (this._ptr + offset) / 4;
        this._module.HEAP32[index] = value;
    }

    /**
     * Read WASM memory as Uint8Array (copy)
     * Safe to use after memory operations
     */
    readBytes(length?: number): Uint8Array {
        this.checkFreed();
        const len = length ?? this._size;
        // slice() creates a copy, safe from detachment
        return this._module.HEAPU8.slice(this._ptr, this._ptr + len);
    }

    /**
     * Read WASM memory as Float32Array (copy)
     */
    readFloat32(length?: number): Float32Array {
        this.checkFreed();
        const floatLength = length ?? (this._size / 4);
        const offset = this._ptr / 4;
        return this._module.HEAPF32.slice(offset, offset + floatLength);
    }

    /**
     * Read a single signed 32-bit integer at the given byte offset.
     *
     * @param offset Byte offset within the block (default: 0). Must be 4-byte aligned.
     */
    readInt32(offset: number = 0): number {
        this.checkFreed();
        if (offset < 0 || offset + 4 > this._size) {
            throw new Error('Int32 read would exceed allocated memory block');
        }
        if ((this._ptr + offset) % 4 !== 0) {
            throw new Error('Int32 read requires 4-byte aligned offset');
        }
        const index = (this._ptr + offset) / 4;
        return this._module.HEAP32[index];
    }

    /**
     * Get Float32Array view (reference, not copy)
     * WARNING: May become invalid if WASM memory grows
     */
    asFloat32View(length?: number): Float32Array {
        this.checkFreed();
        const floatLength = length ?? (this._size / 4);
        return new Float32Array(
            this._module.HEAPF32.buffer,
            this._ptr,
            floatLength
        );
    }

    /**
     * Get Uint16Array view (reference, not copy)
     * WARNING: May become invalid if WASM memory grows
     */
    asUint16View(length?: number): Uint16Array {
        this.checkFreed();
        const len = length ?? (this._size / 2);
        return new Uint16Array(
            this._module.HEAPU16.buffer,
            this._ptr,
            len
        );
    }

    /**
     * Get Uint8Array view (reference, not copy)
     * WARNING: May become invalid if WASM memory grows
     */
    asUint8View(length?: number): Uint8Array {
        this.checkFreed();
        const len = length ?? this._size;
        return new Uint8Array(
            this._module.HEAPU8.buffer,
            this._ptr,
            len
        );
    }

    /**
     * Free the memory block
     * Safe to call multiple times
     */
    free(): void {
        if (!this._isFreed) {
            this._module._free(this._ptr);
            this._isFreed = true;
            this._ptr = 0;
        }
    }

    private checkFreed(): void {
        if (this._isFreed) {
            throw new Error('Accessing freed memory block');
        }
    }
}

/**
 * RAII-style memory management helper
 *
 * Automatically frees memory when callback completes (success or error)
 *
 * @example
 * const result = await useWasmMemory(module, 1024, (block) => {
 *     block.write(inputData);
 *     module._process(block.ptr, block.size);
 *     return block.readBytes();
 * });
 */
export async function useWasmMemory<T>(
    module: EmscriptenModule,
    size: number,
    callback: (block: WasmMemoryBlock) => Promise<T> | T
): Promise<T> {
    const block = new WasmMemoryBlock(module, size);
    try {
        return await callback(block);
    } finally {
        block.free();
    }
}

/**
 * Synchronous version of useWasmMemory
 */
export function useWasmMemorySync<T>(
    module: EmscriptenModule,
    size: number,
    callback: (block: WasmMemoryBlock) => T
): T {
    const block = new WasmMemoryBlock(module, size);
    try {
        return callback(block);
    } finally {
        block.free();
    }
}

/**
 * FinalizationRegistry for emergency cleanup
 * Only used as a safety net - always prefer explicit free()
 */
const memoryRegistry = new FinalizationRegistry<{
    module: EmscriptenModule;
    ptr: number;
}>((heldValue) => {
    console.warn('[WasmMemory] Emergency cleanup triggered - memory was not explicitly freed');
    if (heldValue.ptr !== 0) {
        heldValue.module._free(heldValue.ptr);
    }
});

/**
 * Create a memory block with FinalizationRegistry backup
 * Use this for long-lived allocations where you might forget to free
 */
export function createTrackedMemoryBlock(
    module: EmscriptenModule,
    size: number
): WasmMemoryBlock {
    const block = new WasmMemoryBlock(module, size);

    // Register for emergency cleanup if JS object is GC'd without free()
    memoryRegistry.register(block, { module, ptr: block.ptr }, block);

    // Override free to unregister from registry
    const originalFree = block.free.bind(block);
    block.free = () => {
        memoryRegistry.unregister(block);
        originalFree();
    };

    return block;
}
