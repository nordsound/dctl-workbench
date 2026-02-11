/**
 * GPU Profiler
 *
 * Provides GPU timing measurement using timestamp-query feature.
 * Measures actual GPU execution time for compute and render passes.
 */

// ============================================
// Types
// ============================================

export interface GPUTimingResult {
    /** Label for the measured operation */
    label: string;
    /** Duration in milliseconds */
    durationMs: number;
    /** Start timestamp in nanoseconds */
    startNs: bigint;
    /** End timestamp in nanoseconds */
    endNs: bigint;
}

export interface GPUProfilerOptions {
    /** GPUDevice to create query sets on */
    device: GPUDevice;
    /** Maximum number of concurrent timing measurements */
    maxMeasurements?: number;
    /** Logging function */
    log?: (message: string) => void;
}

export interface GPUProfiler {
    /** Check if timestamp-query is supported */
    readonly isSupported: boolean;

    /** Start a timing measurement, returns a measurement ID */
    beginMeasurement(label: string): number;

    /** End a timing measurement */
    endMeasurement(measurementId: number): void;

    /** Write timestamp queries to a command encoder */
    writeTimestamps(encoder: GPUCommandEncoder, measurementId: number, isStart: boolean): void;

    /** Resolve all pending measurements (call after queue.submit) */
    resolve(encoder: GPUCommandEncoder): void;

    /** Read results from GPU (async, call after queue.onSubmittedWorkDone) */
    readResults(): Promise<GPUTimingResult[]>;

    /** Reset profiler for next frame */
    reset(): void;

    /** Dispose of GPU resources */
    dispose(): void;
}

// ============================================
// Implementation
// ============================================

interface PendingMeasurement {
    label: string;
    queryIndex: number; // Index in query set (start = queryIndex, end = queryIndex + 1)
    resolved: boolean;
}

export function createGPUProfiler(options: GPUProfilerOptions): GPUProfiler {
    const { device, maxMeasurements = 32, log } = options;

    // Check if timestamp-query is supported
    const isSupported = device.features.has('timestamp-query');

    if (!isSupported) {
        log?.('[GPU Profiler] timestamp-query not supported, profiling disabled');
        return createNoOpProfiler();
    }

    log?.('[GPU Profiler] Initialized with timestamp-query support');

    // Each measurement needs 2 timestamps (start + end)
    const queryCount = maxMeasurements * 2;

    // Create query set for timestamps
    const querySet = device.createQuerySet({
        type: 'timestamp',
        count: queryCount,
        label: 'GPU Profiler Query Set',
    });

    // Buffer to resolve timestamps into
    const resolveBuffer = device.createBuffer({
        size: queryCount * 8, // 8 bytes per timestamp (BigInt64)
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        label: 'GPU Profiler Resolve Buffer',
    });

    // Staging buffer for CPU readback
    const readbackBuffer = device.createBuffer({
        size: queryCount * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        label: 'GPU Profiler Readback Buffer',
    });

    let measurements: PendingMeasurement[] = [];
    let nextMeasurementId = 0;
    let nextQueryIndex = 0;
    let isDisposed = false;

    return {
        get isSupported(): boolean {
            return true;
        },

        beginMeasurement(label: string): number {
            if (isDisposed) {
                log?.('[GPU Profiler] Cannot begin measurement - profiler disposed');
                return -1;
            }

            if (nextQueryIndex >= queryCount - 1) {
                log?.('[GPU Profiler] Maximum measurements exceeded');
                return -1;
            }

            const measurementId = nextMeasurementId++;
            const queryIndex = nextQueryIndex;
            nextQueryIndex += 2; // Reserve 2 slots (start + end)

            measurements.push({
                label,
                queryIndex,
                resolved: false,
            });

            return measurementId;
        },

        endMeasurement(_measurementId: number): void {
            // End is recorded via writeTimestamps
        },

        writeTimestamps(encoder: GPUCommandEncoder, measurementId: number, isStart: boolean): void {
            if (isDisposed || measurementId < 0 || measurementId >= measurements.length) {
                return;
            }

            const measurement = measurements[measurementId];
            const queryIndex = isStart ? measurement.queryIndex : measurement.queryIndex + 1;

            encoder.writeTimestamp(querySet, queryIndex);
        },

        resolve(encoder: GPUCommandEncoder): void {
            if (isDisposed || measurements.length === 0) {
                return;
            }

            // Resolve all timestamps to the resolve buffer
            const count = nextQueryIndex;
            encoder.resolveQuerySet(querySet, 0, count, resolveBuffer, 0);

            // Copy to readback buffer
            encoder.copyBufferToBuffer(resolveBuffer, 0, readbackBuffer, 0, count * 8);

            // Mark all measurements as resolved
            for (const m of measurements) {
                m.resolved = true;
            }
        },

        async readResults(): Promise<GPUTimingResult[]> {
            if (isDisposed || measurements.length === 0) {
                return [];
            }

            // Wait for GPU work to complete
            await device.queue.onSubmittedWorkDone();

            // Map the readback buffer
            await readbackBuffer.mapAsync(GPUMapMode.READ);
            const data = new BigInt64Array(readbackBuffer.getMappedRange());

            const results: GPUTimingResult[] = [];

            for (const measurement of measurements) {
                if (!measurement.resolved) {
                    continue;
                }

                const startNs = data[measurement.queryIndex];
                const endNs = data[measurement.queryIndex + 1];

                // Convert nanoseconds to milliseconds
                const durationNs = endNs - startNs;
                const durationMs = Number(durationNs) / 1_000_000;

                results.push({
                    label: measurement.label,
                    durationMs,
                    startNs,
                    endNs,
                });
            }

            readbackBuffer.unmap();

            return results;
        },

        reset(): void {
            measurements = [];
            nextMeasurementId = 0;
            nextQueryIndex = 0;
        },

        dispose(): void {
            if (isDisposed) {
                return;
            }
            isDisposed = true;
            querySet.destroy();
            resolveBuffer.destroy();
            readbackBuffer.destroy();
            log?.('[GPU Profiler] Disposed');
        },
    };
}

// ============================================
// No-op Profiler (when timestamp-query not available)
// ============================================

function createNoOpProfiler(): GPUProfiler {
    return {
        get isSupported(): boolean {
            return false;
        },
        beginMeasurement(_label: string): number {
            return -1;
        },
        endMeasurement(_measurementId: number): void {},
        writeTimestamps(_encoder: GPUCommandEncoder, _measurementId: number, _isStart: boolean): void {},
        resolve(_encoder: GPUCommandEncoder): void {},
        async readResults(): Promise<GPUTimingResult[]> {
            return [];
        },
        reset(): void {},
        dispose(): void {},
    };
}

// ============================================
// Profiler Utilities
// ============================================

/**
 * Format timing results for logging
 */
export function formatTimingResults(results: GPUTimingResult[]): string {
    if (results.length === 0) {
        return 'No timing results';
    }

    const lines = ['GPU Timing Results:'];
    let total = 0;

    for (const result of results) {
        lines.push(`  ${result.label}: ${result.durationMs.toFixed(3)}ms`);
        total += result.durationMs;
    }

    lines.push(`  Total: ${total.toFixed(3)}ms`);

    return lines.join('\n');
}

/**
 * Calculate statistics from timing results
 */
export interface TimingStats {
    min: number;
    max: number;
    avg: number;
    total: number;
    count: number;
}

export function calculateTimingStats(results: GPUTimingResult[]): TimingStats {
    if (results.length === 0) {
        return { min: 0, max: 0, avg: 0, total: 0, count: 0 };
    }

    let min = Infinity;
    let max = -Infinity;
    let total = 0;

    for (const result of results) {
        min = Math.min(min, result.durationMs);
        max = Math.max(max, result.durationMs);
        total += result.durationMs;
    }

    return {
        min,
        max,
        avg: total / results.length,
        total,
        count: results.length,
    };
}

/**
 * Helper to wrap a compute pass with timing
 */
export function profileComputePass(
    profiler: GPUProfiler,
    encoder: GPUCommandEncoder,
    label: string,
    passDescriptor: GPUComputePassDescriptor,
    callback: (pass: GPUComputePassEncoder) => void
): number {
    const measurementId = profiler.beginMeasurement(label);

    if (measurementId >= 0) {
        profiler.writeTimestamps(encoder, measurementId, true);
    }

    const pass = encoder.beginComputePass(passDescriptor);
    callback(pass);
    pass.end();

    if (measurementId >= 0) {
        profiler.writeTimestamps(encoder, measurementId, false);
    }

    return measurementId;
}

/**
 * Helper to wrap a render pass with timing
 */
export function profileRenderPass(
    profiler: GPUProfiler,
    encoder: GPUCommandEncoder,
    label: string,
    passDescriptor: GPURenderPassDescriptor,
    callback: (pass: GPURenderPassEncoder) => void
): number {
    const measurementId = profiler.beginMeasurement(label);

    if (measurementId >= 0) {
        profiler.writeTimestamps(encoder, measurementId, true);
    }

    const pass = encoder.beginRenderPass(passDescriptor);
    callback(pass);
    pass.end();

    if (measurementId >= 0) {
        profiler.writeTimestamps(encoder, measurementId, false);
    }

    return measurementId;
}
