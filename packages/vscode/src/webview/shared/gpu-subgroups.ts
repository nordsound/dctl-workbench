/**
 * GPU Subgroups Utilities
 *
 * Provides subgroup-optimized WGSL shader code generators.
 * Subgroups enable SIMD-level optimizations for reductions, broadcasts, and shuffles.
 *
 * When subgroups are not available, fallback implementations using atomics are provided.
 */

// ============================================
// Types
// ============================================

export interface SubgroupConfig {
    /** Whether subgroups feature is enabled */
    enabled: boolean;
    /** Minimum subgroup size (for workgroup size calculations) */
    minSize: number;
    /** Maximum subgroup size */
    maxSize: number;
}

// ============================================
// Shader Code Generators
// ============================================

/**
 * Get the enable directive for subgroups if available
 */
export function getSubgroupsEnableDirective(config: SubgroupConfig): string {
    return config.enabled ? 'enable subgroups;\n' : '';
}

/**
 * Generate subgroup reduction for sum
 *
 * This generates WGSL code for a subgroup-optimized sum reduction.
 * Falls back to workgroup shared memory reduction when subgroups not available.
 */
export function generateSubgroupSumReduction(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
// Subgroup-optimized sum reduction
fn subgroup_sum_f32(value: f32) -> f32 {
    return subgroupAdd(value);
}

fn subgroup_sum_u32(value: u32) -> u32 {
    return subgroupAdd(value);
}

fn subgroup_sum_vec3f(value: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        subgroupAdd(value.x),
        subgroupAdd(value.y),
        subgroupAdd(value.z)
    );
}
`;
    }

    // Fallback: no subgroups, use atomics or workgroup reduction
    return /* wgsl */`
// Fallback sum reduction (no subgroups available)
// Note: Caller should use atomicAdd directly for simple cases
fn subgroup_sum_f32(value: f32) -> f32 {
    // Without subgroups, return the value unchanged
    // Caller must handle reduction via atomics or shared memory
    return value;
}

fn subgroup_sum_u32(value: u32) -> u32 {
    return value;
}

fn subgroup_sum_vec3f(value: vec3<f32>) -> vec3<f32> {
    return value;
}
`;
}

/**
 * Generate subgroup reduction for min
 */
export function generateSubgroupMinReduction(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
// Subgroup-optimized min reduction
fn subgroup_min_f32(value: f32) -> f32 {
    return subgroupMin(value);
}

fn subgroup_min_u32(value: u32) -> u32 {
    return subgroupMin(value);
}
`;
    }

    return /* wgsl */`
// Fallback min reduction
fn subgroup_min_f32(value: f32) -> f32 {
    return value;
}

fn subgroup_min_u32(value: u32) -> u32 {
    return value;
}
`;
}

/**
 * Generate subgroup reduction for max
 */
export function generateSubgroupMaxReduction(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
// Subgroup-optimized max reduction
fn subgroup_max_f32(value: f32) -> f32 {
    return subgroupMax(value);
}

fn subgroup_max_u32(value: u32) -> u32 {
    return subgroupMax(value);
}
`;
    }

    return /* wgsl */`
// Fallback max reduction
fn subgroup_max_f32(value: f32) -> f32 {
    return value;
}

fn subgroup_max_u32(value: u32) -> u32 {
    return value;
}
`;
}

/**
 * Generate subgroup broadcast (share value from first invocation)
 */
export function generateSubgroupBroadcast(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
// Subgroup broadcast - get value from first invocation
fn subgroup_broadcast_f32(value: f32) -> f32 {
    return subgroupBroadcastFirst(value);
}

fn subgroup_broadcast_u32(value: u32) -> u32 {
    return subgroupBroadcastFirst(value);
}
`;
    }

    return /* wgsl */`
// Fallback broadcast (no-op without subgroups)
fn subgroup_broadcast_f32(value: f32) -> f32 {
    return value;
}

fn subgroup_broadcast_u32(value: u32) -> u32 {
    return value;
}
`;
}

/**
 * Generate subgroup ballot (get bitmask of invocations where predicate is true)
 */
export function generateSubgroupBallot(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
// Subgroup ballot - count invocations where predicate is true
fn subgroup_ballot_count(predicate: bool) -> u32 {
    let ballot = subgroupBallot(predicate);
    return countOneBits(ballot.x) + countOneBits(ballot.y) +
           countOneBits(ballot.z) + countOneBits(ballot.w);
}

// Check if any invocation in subgroup has predicate true
fn subgroup_any(predicate: bool) -> bool {
    return subgroupAny(predicate);
}

// Check if all invocations in subgroup have predicate true
fn subgroup_all(predicate: bool) -> bool {
    return subgroupAll(predicate);
}
`;
    }

    return /* wgsl */`
// Fallback ballot operations
fn subgroup_ballot_count(predicate: bool) -> u32 {
    return select(0u, 1u, predicate);
}

fn subgroup_any(predicate: bool) -> bool {
    return predicate;
}

fn subgroup_all(predicate: bool) -> bool {
    return predicate;
}
`;
}

/**
 * Generate subgroup prefix scan (exclusive scan)
 */
export function generateSubgroupExclusiveScan(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
// Subgroup exclusive prefix sum
fn subgroup_exclusive_add_u32(value: u32) -> u32 {
    return subgroupExclusiveAdd(value);
}

fn subgroup_exclusive_add_f32(value: f32) -> f32 {
    return subgroupExclusiveAdd(value);
}
`;
    }

    return /* wgsl */`
// Fallback exclusive scan (identity for single invocation)
fn subgroup_exclusive_add_u32(value: u32) -> u32 {
    return 0u;
}

fn subgroup_exclusive_add_f32(value: f32) -> f32 {
    return 0.0;
}
`;
}

// ============================================
// Complete Shader Header Generator
// ============================================

/**
 * Generate a complete subgroups utility header for shaders
 *
 * This combines all commonly used subgroup operations into a single header.
 */
export function generateSubgroupsHeader(config: SubgroupConfig): string {
    const parts: string[] = [];

    // Enable directive
    parts.push(getSubgroupsEnableDirective(config));

    // Comment indicating subgroup status
    if (config.enabled) {
        parts.push(`// Subgroups enabled (size: ${config.minSize}-${config.maxSize})\n`);
    } else {
        parts.push('// Subgroups not available - using fallback implementations\n');
    }

    // Add all reduction functions
    parts.push(generateSubgroupSumReduction(config));
    parts.push(generateSubgroupMinReduction(config));
    parts.push(generateSubgroupMaxReduction(config));
    parts.push(generateSubgroupBroadcast(config));
    parts.push(generateSubgroupBallot(config));
    parts.push(generateSubgroupExclusiveScan(config));

    return parts.join('\n');
}

// ============================================
// Optimized Histogram Shader Generator
// ============================================

/**
 * Generate a subgroup-optimized histogram compute shader
 *
 * When subgroups are available, uses subgroup reductions to minimize atomic contention.
 * Each subgroup first reduces its counts locally, then one thread per subgroup
 * performs the atomic update.
 */
export function generateOptimizedHistogramShader(
    config: SubgroupConfig,
    binCount: number = 256
): string {
    if (config.enabled) {
        return /* wgsl */`
enable subgroups;

// Subgroup-optimized histogram shader
// Uses subgroup reductions to minimize atomic contention

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, ${binCount * 4}>;

struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(0) @binding(2) var<uniform> params: Params;

// Local histogram for subgroup reduction
var<private> local_r: array<u32, ${binCount}>;
var<private> local_g: array<u32, ${binCount}>;
var<private> local_b: array<u32, ${binCount}>;
var<private> local_luma: array<u32, ${binCount}>;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>,
        @builtin(subgroup_invocation_id) subgroup_id: u32,
        @builtin(subgroup_size) subgroup_size: u32) {
    let x = global_id.x;

    // Process multiple rows per invocation
    for (var y = 0u; y < params.height; y++) {
        if (x >= params.width) {
            continue;
        }

        let coords = vec2<u32>(x, y);
        let color = textureLoad(source_texture, coords, 0);

        let r = clamp(color.r, 0.0, 1.0);
        let g = clamp(color.g, 0.0, 1.0);
        let b = clamp(color.b, 0.0, 1.0);

        let rBin = u32(r * ${binCount - 1}.0);
        let gBin = u32(g * ${binCount - 1}.0);
        let bBin = u32(b * ${binCount - 1}.0);

        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let lumaBin = u32(clamp(luma, 0.0, 1.0) * ${binCount - 1}.0);

        // Use subgroup ballot to count how many invocations hit each bin
        // This reduces atomic contention significantly
        for (var bin = 0u; bin < ${binCount}u; bin++) {
            let r_count = subgroup_ballot_count(rBin == bin);
            let g_count = subgroup_ballot_count(gBin == bin);
            let b_count = subgroup_ballot_count(bBin == bin);
            let luma_count = subgroup_ballot_count(lumaBin == bin);

            // Only first invocation in subgroup does the atomic update
            if (subgroup_id == 0u) {
                if (r_count > 0u) {
                    atomicAdd(&histogram[bin], r_count);
                }
                if (g_count > 0u) {
                    atomicAdd(&histogram[${binCount}u + bin], g_count);
                }
                if (b_count > 0u) {
                    atomicAdd(&histogram[${binCount * 2}u + bin], b_count);
                }
                if (luma_count > 0u) {
                    atomicAdd(&histogram[${binCount * 3}u + bin], luma_count);
                }
            }
        }
    }
}

fn subgroup_ballot_count(predicate: bool) -> u32 {
    let ballot = subgroupBallot(predicate);
    return countOneBits(ballot.x) + countOneBits(ballot.y) +
           countOneBits(ballot.z) + countOneBits(ballot.w);
}
`;
    }

    // Fallback: standard atomic histogram
    return /* wgsl */`
// Standard histogram shader (no subgroups)
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, ${binCount * 4}>;

struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    let color = textureLoad(source_texture, coords, 0);

    let r = clamp(color.r, 0.0, 1.0);
    let g = clamp(color.g, 0.0, 1.0);
    let b = clamp(color.b, 0.0, 1.0);

    let rBin = u32(r * ${binCount - 1}.0);
    let gBin = u32(g * ${binCount - 1}.0);
    let bBin = u32(b * ${binCount - 1}.0);

    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let lumaBin = u32(clamp(luma, 0.0, 1.0) * ${binCount - 1}.0);

    atomicAdd(&histogram[rBin], 1u);
    atomicAdd(&histogram[${binCount}u + gBin], 1u);
    atomicAdd(&histogram[${binCount * 2}u + bBin], 1u);
    atomicAdd(&histogram[${binCount * 3}u + lumaBin], 1u);
}
`;
}

// ============================================
// Optimized Statistics Shader Generator
// ============================================

/**
 * Generate a subgroup-optimized statistics compute shader
 *
 * When subgroups are available, uses subgroup min/max/sum to reduce
 * the number of atomic operations.
 */
export function generateOptimizedStatisticsShader(config: SubgroupConfig): string {
    if (config.enabled) {
        return /* wgsl */`
enable subgroups;

// Subgroup-optimized statistics shader
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> stats: array<atomic<u32>, 16>;

struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(0) @binding(2) var<uniform> params: Params;

fn float_to_fixed(v: f32) -> u32 {
    return u32(clamp(v, 0.0, 1.0) * 1000000.0);
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>,
        @builtin(subgroup_invocation_id) subgroup_id: u32) {
    let x = global_id.x;

    var local_min_r = 1000000u;
    var local_min_g = 1000000u;
    var local_min_b = 1000000u;
    var local_min_luma = 1000000u;

    var local_max_r = 0u;
    var local_max_g = 0u;
    var local_max_b = 0u;
    var local_max_luma = 0u;

    var local_sum_r = 0u;
    var local_sum_g = 0u;
    var local_sum_b = 0u;
    var local_sum_luma = 0u;

    var local_count = 0u;

    // Process all rows for this column
    for (var y = 0u; y < params.height; y++) {
        if (x >= params.width) {
            continue;
        }

        let coords = vec2<u32>(x, y);
        let color = textureLoad(source_texture, coords, 0);

        let r = clamp(color.r, 0.0, 1.0);
        let g = clamp(color.g, 0.0, 1.0);
        let b = clamp(color.b, 0.0, 1.0);
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        let rFixed = float_to_fixed(r);
        let gFixed = float_to_fixed(g);
        let bFixed = float_to_fixed(b);
        let lumaFixed = float_to_fixed(luma);

        local_min_r = min(local_min_r, rFixed);
        local_min_g = min(local_min_g, gFixed);
        local_min_b = min(local_min_b, bFixed);
        local_min_luma = min(local_min_luma, lumaFixed);

        local_max_r = max(local_max_r, rFixed);
        local_max_g = max(local_max_g, gFixed);
        local_max_b = max(local_max_b, bFixed);
        local_max_luma = max(local_max_luma, lumaFixed);

        local_sum_r += u32(r * 1000.0);
        local_sum_g += u32(g * 1000.0);
        local_sum_b += u32(b * 1000.0);
        local_sum_luma += u32(luma * 1000.0);

        local_count += 1u;
    }

    // Subgroup reduction
    let sg_min_r = subgroupMin(local_min_r);
    let sg_min_g = subgroupMin(local_min_g);
    let sg_min_b = subgroupMin(local_min_b);
    let sg_min_luma = subgroupMin(local_min_luma);

    let sg_max_r = subgroupMax(local_max_r);
    let sg_max_g = subgroupMax(local_max_g);
    let sg_max_b = subgroupMax(local_max_b);
    let sg_max_luma = subgroupMax(local_max_luma);

    let sg_sum_r = subgroupAdd(local_sum_r);
    let sg_sum_g = subgroupAdd(local_sum_g);
    let sg_sum_b = subgroupAdd(local_sum_b);
    let sg_sum_luma = subgroupAdd(local_sum_luma);

    let sg_count = subgroupAdd(local_count);

    // Only first invocation in subgroup does atomic update
    if (subgroup_id == 0u) {
        atomicMin(&stats[0], sg_min_r);
        atomicMin(&stats[1], sg_min_g);
        atomicMin(&stats[2], sg_min_b);
        atomicMin(&stats[3], sg_min_luma);

        atomicMax(&stats[4], sg_max_r);
        atomicMax(&stats[5], sg_max_g);
        atomicMax(&stats[6], sg_max_b);
        atomicMax(&stats[7], sg_max_luma);

        atomicAdd(&stats[8], sg_sum_r);
        atomicAdd(&stats[9], sg_sum_g);
        atomicAdd(&stats[10], sg_sum_b);
        atomicAdd(&stats[11], sg_sum_luma);

        atomicAdd(&stats[12], sg_count);
    }
}
`;
    }

    // Fallback: standard atomic statistics
    return /* wgsl */`
// Standard statistics shader (no subgroups)
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> stats: array<atomic<u32>, 16>;

struct Params {
    width: u32,
    height: u32,
    _padding: vec2<u32>,
}
@group(0) @binding(2) var<uniform> params: Params;

fn float_to_fixed(v: f32) -> u32 {
    return u32(clamp(v, 0.0, 1.0) * 1000000.0);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coords = global_id.xy;

    if (coords.x >= params.width || coords.y >= params.height) {
        return;
    }

    let color = textureLoad(source_texture, coords, 0);

    let r = clamp(color.r, 0.0, 1.0);
    let g = clamp(color.g, 0.0, 1.0);
    let b = clamp(color.b, 0.0, 1.0);
    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    let rFixed = float_to_fixed(r);
    let gFixed = float_to_fixed(g);
    let bFixed = float_to_fixed(b);
    let lumaFixed = float_to_fixed(luma);

    atomicMin(&stats[0], rFixed);
    atomicMin(&stats[1], gFixed);
    atomicMin(&stats[2], bFixed);
    atomicMin(&stats[3], lumaFixed);

    atomicMax(&stats[4], rFixed);
    atomicMax(&stats[5], gFixed);
    atomicMax(&stats[6], bFixed);
    atomicMax(&stats[7], lumaFixed);

    atomicAdd(&stats[8], u32(r * 1000.0));
    atomicAdd(&stats[9], u32(g * 1000.0));
    atomicAdd(&stats[10], u32(b * 1000.0));
    atomicAdd(&stats[11], u32(luma * 1000.0));

    atomicAdd(&stats[12], 1u);
}
`;
}

// ============================================
// Utility: Get Subgroup Config from Device
// ============================================

/**
 * Create SubgroupConfig from a GPUDevice
 */
export function getSubgroupConfig(device: GPUDevice): SubgroupConfig {
    const hasSubgroups = device.features.has('subgroups');

    if (!hasSubgroups) {
        return {
            enabled: false,
            minSize: 1,
            maxSize: 1,
        };
    }

    // Access subgroup limits
    const limits = device.limits as GPUSupportedLimits & {
        minSubgroupSize?: number;
        maxSubgroupSize?: number;
    };

    return {
        enabled: true,
        minSize: limits.minSubgroupSize ?? 4,
        maxSize: limits.maxSubgroupSize ?? 64,
    };
}
