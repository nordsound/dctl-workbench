/**
 * Pan Controller for EXR Viewer
 *
 * Manages scroll-based drag-to-pan when the image is zoomed in
 * beyond the container size. Pure logic class with no DOM dependency.
 */

export interface PanState {
    isDragging: boolean;
    cursor: 'grab' | 'grabbing' | 'default';
}

export interface PanOptions {
    /** Whether the image fits entirely in the container (no panning needed) */
    imageFitsInContainer: boolean;
}

export class PanController {
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private scrollStartX = 0;
    private scrollStartY = 0;
    private options: PanOptions;

    constructor(options: PanOptions) {
        this.options = options;
    }

    /**
     * Start a drag operation.
     * Only allows drag if the image doesn't fit in the container.
     */
    startDrag(clientX: number, clientY: number, scrollX: number, scrollY: number): PanState {
        if (this.options.imageFitsInContainer) {
            return this.getState();
        }

        this.isDragging = true;
        this.dragStartX = clientX;
        this.dragStartY = clientY;
        this.scrollStartX = scrollX;
        this.scrollStartY = scrollY;

        return this.getState();
    }

    /**
     * Update drag position and return new scroll values.
     * Returns null if not currently dragging.
     */
    updateDrag(clientX: number, clientY: number): { scrollLeft: number; scrollTop: number } | null {
        if (!this.isDragging) {
            return null;
        }

        return {
            scrollLeft: this.scrollStartX + (this.dragStartX - clientX),
            scrollTop: this.scrollStartY + (this.dragStartY - clientY),
        };
    }

    /** End the current drag operation. */
    endDrag(): PanState {
        this.isDragging = false;
        return this.getState();
    }

    /** Update options (e.g., when zoom changes). Cancels drag if image now fits. */
    updateOptions(options: PanOptions): void {
        this.options = options;
        if (options.imageFitsInContainer && this.isDragging) {
            this.isDragging = false;
        }
    }

    /** Get current pan state. */
    getState(): PanState {
        return {
            isDragging: this.isDragging,
            cursor: this.options.imageFitsInContainer
                ? 'default'
                : this.isDragging
                    ? 'grabbing'
                    : 'grab',
        };
    }
}
