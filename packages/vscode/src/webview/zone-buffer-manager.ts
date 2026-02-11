/**
 * Zone Buffer Manager
 *
 * Manages GPU buffers for Zone System parameters and definitions.
 * Used for WebGPU-accelerated zone overlay rendering.
 */

export interface ZoneDefinition {
    color: [number, number, number];  // RGB (0-1)
    minStop: number;                   // Minimum stop value
    maxStop: number;                   // Maximum stop value
}

export interface ZoneParams {
    enabled: boolean;
    style: 'false-color' | 'bars' | 'overlay';
    opacity: number;
    zoneCount: number;
    middleGray: number;
}

// Default zone definitions (11 zones, Zone 0-X)
export const DEFAULT_ZONE_DEFINITIONS: ZoneDefinition[] = [
    { color: [0, 0, 0], minStop: -Infinity, maxStop: -5 },           // Zone 0 - Pure black
    { color: [0.1, 0.1, 0.1], minStop: -5, maxStop: -4 },            // Zone I
    { color: [0.2, 0.2, 0.2], minStop: -4, maxStop: -3 },            // Zone II
    { color: [0.3, 0.3, 0.3], minStop: -3, maxStop: -2 },            // Zone III
    { color: [0.4, 0.4, 0.4], minStop: -2, maxStop: -1 },            // Zone IV
    { color: [0.5, 0.5, 0.5], minStop: -1, maxStop: 0 },             // Zone V - Middle gray
    { color: [0.6, 0.6, 0.6], minStop: 0, maxStop: 1 },              // Zone VI
    { color: [0.7, 0.7, 0.7], minStop: 1, maxStop: 2 },              // Zone VII
    { color: [0.8, 0.8, 0.8], minStop: 2, maxStop: 3 },              // Zone VIII
    { color: [0.9, 0.9, 0.9], minStop: 3, maxStop: 4 },              // Zone IX
    { color: [1.0, 1.0, 1.0], minStop: 4, maxStop: Infinity },       // Zone X - Pure white
];

// False color palette for exposure analysis
export const FALSE_COLOR_DEFINITIONS: ZoneDefinition[] = [
    { color: [0.5, 0, 0.5], minStop: -Infinity, maxStop: -6 },       // Purple - Severely underexposed
    { color: [0, 0, 1], minStop: -6, maxStop: -4 },                  // Blue - Underexposed
    { color: [0, 0.5, 1], minStop: -4, maxStop: -3 },                // Cyan-blue
    { color: [0, 1, 1], minStop: -3, maxStop: -2 },                  // Cyan
    { color: [0, 1, 0.5], minStop: -2, maxStop: -1 },                // Cyan-green
    { color: [0, 1, 0], minStop: -1, maxStop: -0.5 },                // Green - Slightly under
    { color: [0.5, 0.5, 0.5], minStop: -0.5, maxStop: 0.5 },         // Gray - Middle gray
    { color: [1, 1, 0], minStop: 0.5, maxStop: 1.5 },                // Yellow - Slightly over
    { color: [1, 0.65, 0], minStop: 1.5, maxStop: 2.5 },             // Orange
    { color: [1, 0, 0], minStop: 2.5, maxStop: 4 },                  // Red - Overexposed
    { color: [1, 0, 1], minStop: 4, maxStop: Infinity },             // Magenta - Clipping
];

// Buffer size constants
const ZONE_PARAMS_SIZE = 32;  // 8 u32/f32 values (aligned to 16 bytes)
const ZONE_DEFINITION_SIZE = 32;  // 8 f32 values per zone (vec3 + f32 + f32 + vec3 padding)
const MAX_ZONES = 16;

export class ZoneBufferManager {
    private device: GPUDevice | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private zonesBuffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;

    private currentParams: ZoneParams = {
        enabled: false,
        style: 'false-color',
        opacity: 0.7,
        zoneCount: 11,
        middleGray: 0.18,
    };

    private currentZones: ZoneDefinition[] = FALSE_COLOR_DEFINITIONS;

    /**
     * Initialize buffers with GPU device
     */
    init(device: GPUDevice): void {
        this.device = device;

        // Create params buffer (uniform)
        this.paramsBuffer = device.createBuffer({
            size: ZONE_PARAMS_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create zones buffer (storage)
        this.zonesBuffer = device.createBuffer({
            size: ZONE_DEFINITION_SIZE * MAX_ZONES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Create bind group layout (visible to both Fragment and Compute shaders)
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        // Create bind group
        this.createBindGroup();

        // Upload initial data
        this.uploadParams();
        this.uploadZones();
    }

    /**
     * Get bind group layout for pipeline creation
     */
    getBindGroupLayout(): GPUBindGroupLayout | null {
        return this.bindGroupLayout;
    }

    /**
     * Get bind group for rendering
     */
    getBindGroup(): GPUBindGroup | null {
        return this.bindGroup;
    }

    /**
     * Update zone parameters
     */
    updateParams(params: Partial<ZoneParams>): void {
        if (params.enabled !== undefined) this.currentParams.enabled = params.enabled;
        if (params.style !== undefined) {
            this.currentParams.style = params.style;
            // Auto-switch zone definitions based on style
            this.currentZones = params.style === 'false-color'
                ? FALSE_COLOR_DEFINITIONS
                : DEFAULT_ZONE_DEFINITIONS;
            this.uploadZones();
        }
        if (params.opacity !== undefined) this.currentParams.opacity = params.opacity;
        if (params.zoneCount !== undefined) this.currentParams.zoneCount = params.zoneCount;
        if (params.middleGray !== undefined) this.currentParams.middleGray = params.middleGray;

        this.uploadParams();
    }

    /**
     * Update zone definitions
     */
    updateZones(zones: ZoneDefinition[]): void {
        this.currentZones = zones;
        this.currentParams.zoneCount = zones.length;
        this.uploadParams();
        this.uploadZones();
    }

    /**
     * Check if zone system is enabled
     */
    isEnabled(): boolean {
        return this.currentParams.enabled;
    }

    private createBindGroup(): void {
        if (!this.device || !this.bindGroupLayout || !this.paramsBuffer || !this.zonesBuffer) {
            return;
        }

        this.bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.paramsBuffer } },
                { binding: 1, resource: { buffer: this.zonesBuffer } },
            ],
        });
    }

    private uploadParams(): void {
        if (!this.device || !this.paramsBuffer) return;

        const styleMap: Record<string, number> = {
            'false-color': 0,
            'bars': 1,
            'overlay': 2,
        };

        // ZoneParams structure layout (32 bytes total):
        // u32 enabled       offset 0
        // u32 style         offset 4
        // f32 opacity       offset 8
        // u32 zone_count    offset 12
        // f32 middle_gray   offset 16
        // vec3 padding      offset 20 (12 bytes)

        const data = new ArrayBuffer(ZONE_PARAMS_SIZE);
        const u32View = new Uint32Array(data);
        const f32View = new Float32Array(data);

        u32View[0] = this.currentParams.enabled ? 1 : 0;
        u32View[1] = styleMap[this.currentParams.style] ?? 0;
        f32View[2] = this.currentParams.opacity;
        u32View[3] = this.currentParams.zoneCount;
        f32View[4] = this.currentParams.middleGray;
        // Padding at offset 5, 6, 7

        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
    }

    private uploadZones(): void {
        if (!this.device || !this.zonesBuffer) return;

        // ZoneDefinition structure layout (32 bytes per zone):
        // vec3 color       offset 0 (12 bytes)
        // f32 min_stop     offset 12
        // f32 max_stop     offset 16
        // vec3 padding     offset 20 (12 bytes)

        const zones = this.currentZones.slice(0, MAX_ZONES);
        const data = new Float32Array(MAX_ZONES * 8);  // 8 floats per zone

        for (let i = 0; i < zones.length; i++) {
            const zone = zones[i];
            const offset = i * 8;

            // color (vec3)
            data[offset + 0] = zone.color[0];
            data[offset + 1] = zone.color[1];
            data[offset + 2] = zone.color[2];

            // min_stop (f32)
            data[offset + 3] = isFinite(zone.minStop) ? zone.minStop : -100;

            // max_stop (f32)
            data[offset + 4] = isFinite(zone.maxStop) ? zone.maxStop : 100;

            // padding (vec3)
            data[offset + 5] = 0;
            data[offset + 6] = 0;
            data[offset + 7] = 0;
        }

        this.device.queue.writeBuffer(this.zonesBuffer, 0, data);
    }

    /**
     * Clean up GPU resources
     */
    dispose(): void {
        if (this.paramsBuffer) {
            this.paramsBuffer.destroy();
            this.paramsBuffer = null;
        }
        if (this.zonesBuffer) {
            this.zonesBuffer.destroy();
            this.zonesBuffer = null;
        }
        this.bindGroup = null;
        this.bindGroupLayout = null;
        this.device = null;
    }
}
