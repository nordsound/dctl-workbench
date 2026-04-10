/**
 * Unit tests for the WASM memory utility.
 *
 * The utility is designed to wrap any Emscripten-shaped module, so the
 * tests use a fake module backed by a single ArrayBuffer plus a tiny
 * bump allocator. This keeps the tests fully isolated from any real
 * WASM dependency.
 */

import { strict as assert } from 'assert';
import {
    WasmMemoryBlock,
    useWasmMemory,
    useWasmMemorySync,
    type EmscriptenModule,
} from '../../utils/wasm-memory';

interface FakeModule extends EmscriptenModule {
    /** Bump allocator cursor (in bytes). */
    cursor: number;
    /** Total heap size (in bytes). */
    heapBytes: number;
    /** Track every malloc that has not been freed. */
    liveAllocations: Map<number, number>;
}

function createFakeModule(heapBytes: number = 64 * 1024): FakeModule {
    const buffer = new ArrayBuffer(heapBytes);
    // Reserve the first 16 bytes so a returned ptr === 0 is unambiguously OOM.
    let cursor = 16;
    const liveAllocations = new Map<number, number>();

    const fake: FakeModule = {
        HEAP8: new Int8Array(buffer),
        HEAPU8: new Uint8Array(buffer),
        HEAP16: new Int16Array(buffer),
        HEAPU16: new Uint16Array(buffer),
        HEAP32: new Int32Array(buffer),
        HEAPU32: new Uint32Array(buffer),
        HEAPF32: new Float32Array(buffer),
        HEAPF64: new Float64Array(buffer),
        cursor,
        heapBytes,
        liveAllocations,
        _malloc(size: number): number {
            // Round up to 8-byte alignment so all heap views stay valid.
            const aligned = (size + 7) & ~7;
            if (this.cursor + aligned > this.heapBytes) {
                return 0;
            }
            const ptr = this.cursor;
            this.cursor += aligned;
            this.liveAllocations.set(ptr, aligned);
            return ptr;
        },
        _free(ptr: number): void {
            // The bump allocator does not actually reclaim, but we still
            // track liveness so the tests can assert "no leaks".
            this.liveAllocations.delete(ptr);
        },
    };

    return fake;
}

describe('WasmMemoryBlock', () => {
    let mod: FakeModule;

    beforeEach(() => {
        mod = createFakeModule();
    });

    it('allocates memory from the module on construction', () => {
        const block = new WasmMemoryBlock(mod, 32);
        assert.ok(block.ptr >= 16, 'ptr should fall inside the fake heap');
        assert.equal(block.size, 32);
        assert.equal(block.isFreed, false);
        assert.equal(mod.liveAllocations.size, 1);
        block.free();
    });

    it('rejects non-positive sizes', () => {
        assert.throws(() => new WasmMemoryBlock(mod, 0), /positive/);
        assert.throws(() => new WasmMemoryBlock(mod, -1), /positive/);
    });

    it('throws on out-of-memory (malloc returning 0)', () => {
        // Force malloc to fail.
        const oomMod: EmscriptenModule = {
            ...mod,
            _malloc: () => 0,
        };
        assert.throws(() => new WasmMemoryBlock(oomMod, 16), /OOM/);
    });

    it('write() copies a Uint8Array into the heap at the requested offset', () => {
        const block = new WasmMemoryBlock(mod, 16);
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        block.write(payload, 2);

        assert.equal(mod.HEAPU8[block.ptr + 0], 0);
        assert.equal(mod.HEAPU8[block.ptr + 1], 0);
        assert.equal(mod.HEAPU8[block.ptr + 2], 1);
        assert.equal(mod.HEAPU8[block.ptr + 6], 5);
        block.free();
    });

    it('write() accepts an ArrayBuffer too', () => {
        const block = new WasmMemoryBlock(mod, 8);
        const ab = new Uint8Array([10, 20, 30, 40]).buffer;
        block.write(ab);

        assert.deepEqual(
            Array.from(mod.HEAPU8.slice(block.ptr, block.ptr + 4)),
            [10, 20, 30, 40]
        );
        block.free();
    });

    it('write() rejects payloads that overflow the block', () => {
        const block = new WasmMemoryBlock(mod, 4);
        assert.throws(
            () => block.write(new Uint8Array([1, 2, 3, 4, 5])),
            /exceeds allocated/
        );
        // Offset overflow
        assert.throws(
            () => block.write(new Uint8Array([1, 2]), 3),
            /exceeds allocated/
        );
        block.free();
    });

    it('writeFloat32() and readFloat32() round-trip', () => {
        const block = new WasmMemoryBlock(mod, 16);
        const data = new Float32Array([1.5, -2.25, 3.75, 0.0]);
        block.writeFloat32(data);

        const out = block.readFloat32();
        assert.equal(out.length, 4);
        assert.deepEqual(Array.from(out), Array.from(data));
        block.free();
    });

    it('writeFloat32() rejects payloads larger than the block', () => {
        const block = new WasmMemoryBlock(mod, 8);
        assert.throws(
            () => block.writeFloat32(new Float32Array([1, 2, 3])),
            /exceeds allocated/
        );
        block.free();
    });

    it('writeInt32() / readInt32() round-trip', () => {
        const block = new WasmMemoryBlock(mod, 16);
        block.writeInt32(42);
        block.writeInt32(-7, 4);
        block.writeInt32(0x7fffffff, 8);
        block.writeInt32(-0x80000000, 12);

        assert.equal(block.readInt32(0), 42);
        assert.equal(block.readInt32(4), -7);
        assert.equal(block.readInt32(8), 0x7fffffff);
        assert.equal(block.readInt32(12), -0x80000000);
        block.free();
    });

    it('writeInt32() / readInt32() reject misaligned offsets', () => {
        const block = new WasmMemoryBlock(mod, 16);
        // Block ptr is 8-byte aligned thanks to the fake malloc, so any
        // offset that is not a multiple of 4 must throw.
        assert.throws(() => block.writeInt32(1, 1), /aligned/);
        assert.throws(() => block.readInt32(2), /aligned/);
        block.free();
    });

    it('writeInt32() / readInt32() reject out-of-range offsets', () => {
        const block = new WasmMemoryBlock(mod, 8);
        assert.throws(() => block.writeInt32(1, 8), /exceed/);
        assert.throws(() => block.readInt32(-4), /exceed/);
        block.free();
    });

    it('readBytes() returns a copy detached from the heap', () => {
        const block = new WasmMemoryBlock(mod, 4);
        block.write(new Uint8Array([9, 8, 7, 6]));
        const copy = block.readBytes();
        assert.deepEqual(Array.from(copy), [9, 8, 7, 6]);

        // Mutating the copy must not touch the heap.
        copy[0] = 0;
        assert.equal(mod.HEAPU8[block.ptr], 9);
        block.free();
    });

    it('asFloat32View / asUint16View / asUint8View return live heap views', () => {
        const block = new WasmMemoryBlock(mod, 16);
        const f32 = block.asFloat32View();
        assert.equal(f32.length, 4);
        assert.equal(f32.buffer, mod.HEAPF32.buffer);

        const u16 = block.asUint16View();
        assert.equal(u16.length, 8);
        assert.equal(u16.buffer, mod.HEAPU16.buffer);

        const u8 = block.asUint8View();
        assert.equal(u8.length, 16);
        assert.equal(u8.buffer, mod.HEAPU8.buffer);
        block.free();
    });

    it('free() releases the allocation and is safe to call multiple times', () => {
        const block = new WasmMemoryBlock(mod, 32);
        const ptr = block.ptr;
        assert.equal(mod.liveAllocations.has(ptr), true);

        block.free();
        assert.equal(block.isFreed, true);
        assert.equal(mod.liveAllocations.has(ptr), false);

        // Calling free again must not throw or double-release.
        block.free();
        assert.equal(mod.liveAllocations.has(ptr), false);
    });

    it('all accessors throw after free()', () => {
        const block = new WasmMemoryBlock(mod, 16);
        block.write(new Uint8Array([1, 2, 3, 4]));
        block.free();

        assert.throws(() => block.ptr, /freed/);
        assert.throws(() => block.write(new Uint8Array([1])), /freed/);
        assert.throws(() => block.writeFloat32(new Float32Array([1])), /freed/);
        assert.throws(() => block.writeInt32(1), /freed/);
        assert.throws(() => block.readBytes(), /freed/);
        assert.throws(() => block.readFloat32(), /freed/);
        assert.throws(() => block.readInt32(), /freed/);
        assert.throws(() => block.asFloat32View(), /freed/);
        assert.throws(() => block.asUint16View(), /freed/);
        assert.throws(() => block.asUint8View(), /freed/);
    });
});

describe('useWasmMemory / useWasmMemorySync', () => {
    let mod: FakeModule;

    beforeEach(() => {
        mod = createFakeModule();
    });

    it('useWasmMemorySync() frees the block after a successful callback', () => {
        const result = useWasmMemorySync(mod, 8, (block) => {
            block.write(new Uint8Array([1, 2, 3]));
            return block.readBytes(3);
        });
        assert.deepEqual(Array.from(result), [1, 2, 3]);
        assert.equal(mod.liveAllocations.size, 0);
    });

    it('useWasmMemorySync() frees the block even when the callback throws', () => {
        assert.throws(() => {
            useWasmMemorySync(mod, 8, () => {
                throw new Error('boom');
            });
        }, /boom/);
        assert.equal(mod.liveAllocations.size, 0);
    });

    it('useWasmMemory() frees the block after an async callback resolves', async () => {
        const result = await useWasmMemory(mod, 16, async (block) => {
            block.writeInt32(99);
            await Promise.resolve();
            return block.readInt32();
        });
        assert.equal(result, 99);
        assert.equal(mod.liveAllocations.size, 0);
    });

    it('useWasmMemory() frees the block even when the callback rejects', async () => {
        await assert.rejects(
            () =>
                useWasmMemory(mod, 16, async () => {
                    throw new Error('async failure');
                }),
            /async failure/
        );
        assert.equal(mod.liveAllocations.size, 0);
    });
});
