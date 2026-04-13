/**
 * Zoom math utilities for the EXR Viewer.
 *
 * Pure functions — no DOM dependency — so they can be unit tested
 * without a browser.
 */

export interface ZoomScrollAdjustParams {
    /** Zoom factor before the change (image CSS-px per image-px). */
    oldZoom: number;
    /** Zoom factor after the change. */
    newZoom: number;
    /** Cursor X in viewport coordinates (event.clientX). */
    cursorClientX: number;
    /** Cursor Y in viewport coordinates (event.clientY). */
    cursorClientY: number;
    /** Canvas bounding rect BEFORE the zoom change (getBoundingClientRect). */
    canvasRectBefore: { left: number; top: number };
    /** Canvas bounding rect AFTER the zoom change (after layout settles). */
    canvasRectAfter: { left: number; top: number };
}

export interface ScrollDelta {
    /** Amount to add to canvasContainer.scrollLeft to keep the cursor's image point fixed. */
    deltaX: number;
    /** Amount to add to canvasContainer.scrollTop to keep the cursor's image point fixed. */
    deltaY: number;
}

/**
 * Compute the scroll adjustment needed to keep the image point that
 * was under the cursor at the same viewport position after a zoom change.
 *
 * Caller applies the result as:
 *   container.scrollLeft += delta.deltaX;
 *   container.scrollTop  += delta.deltaY;
 *
 * The browser will clamp scroll to [0, maxScroll], so at the extremes
 * the cursor-anchor is best-effort rather than exact.
 */
export function calculateZoomScrollAdjustment(params: ZoomScrollAdjustParams): ScrollDelta {
    // Image pixel under the cursor BEFORE zoom
    const cursorOnCanvasX_before = params.cursorClientX - params.canvasRectBefore.left;
    const cursorOnCanvasY_before = params.cursorClientY - params.canvasRectBefore.top;
    const imageX = cursorOnCanvasX_before / params.oldZoom;
    const imageY = cursorOnCanvasY_before / params.oldZoom;

    // After zoom, the same image pixel lives at (imageX * newZoom, imageY * newZoom)
    // in CSS-px on the canvas. We want that point to coincide with the cursor:
    //
    //   desiredCanvasLeft + imageX * newZoom == cursorClientX
    //
    // So the canvas needs to be at desiredCanvasLeft. The layout already placed
    // it at canvasRectAfter.left; adjust scroll by the difference.
    const desiredCanvasLeft = params.cursorClientX - imageX * params.newZoom;
    const desiredCanvasTop = params.cursorClientY - imageY * params.newZoom;

    return {
        deltaX: params.canvasRectAfter.left - desiredCanvasLeft,
        deltaY: params.canvasRectAfter.top - desiredCanvasTop,
    };
}
