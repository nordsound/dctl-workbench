/**
 * Metadata Display Utilities
 *
 * Shared utilities for rendering metadata in sidebar panels.
 * Used by both EXR Viewer and Analysis Viewer.
 */

// ============================================
// Types
// ============================================

export interface MetadataItem {
    label: string;
    value: string | number;
}

export interface ImageMetadata {
    width: number;
    height: number;
    channels: number | string;
    colorSpace: string;
    compression?: string;
    bitDepth?: string;
}

// ============================================
// Rendering Functions
// ============================================

/**
 * Render a single metadata item as HTML
 */
export function renderMetadataItem(item: MetadataItem): string {
    return `
        <div class="metadata-item">
            <span class="metadata-label">${item.label}</span>
            <span class="metadata-value">${item.value}</span>
        </div>
    `.trim();
}

/**
 * Render multiple metadata items as HTML
 */
export function renderMetadataItems(items: MetadataItem[]): string {
    return items.map(renderMetadataItem).join('\n');
}

/**
 * Format channel count as display string
 */
export function formatChannels(channels: number | string): string {
    if (typeof channels === 'string') return channels;
    switch (channels) {
        case 4: return 'RGBA';
        case 3: return 'RGB';
        case 2: return 'RG';
        case 1: return 'Grayscale';
        default: return String(channels);
    }
}

/**
 * Render standard image metadata (Dimensions, Channels, Color Space, Bit Depth, Compression)
 */
export function renderImageMetadata(metadata: ImageMetadata): string {
    const items: MetadataItem[] = [
        { label: 'Dimensions', value: `${metadata.width} × ${metadata.height}` },
        { label: 'Channels', value: formatChannels(metadata.channels) },
        { label: 'Color Space', value: metadata.colorSpace },
    ];

    // Add bit depth if available
    if (metadata.bitDepth) {
        items.push({ label: 'Bit Depth', value: metadata.bitDepth });
    }

    // Add compression if available
    if (metadata.compression) {
        items.push({ label: 'Compression', value: metadata.compression });
    }

    return renderMetadataItems(items);
}

/**
 * Render empty state message
 */
export function renderEmptyState(message: string): string {
    return `<span class="metadata-empty">${message}</span>`;
}

/**
 * Update metadata element with image info
 */
export function updateMetadataElement(
    elementId: string,
    metadata: ImageMetadata | null,
    emptyMessage: string = 'No image loaded'
): void {
    const element = document.getElementById(elementId);
    if (!element) return;

    if (metadata) {
        element.innerHTML = renderImageMetadata(metadata);
    } else {
        element.innerHTML = renderEmptyState(emptyMessage);
    }
}
