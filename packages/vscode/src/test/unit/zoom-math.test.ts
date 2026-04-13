/**
 * Unit tests for zoom-math cursor-anchor calculation.
 */

import * as assert from 'assert';
import { calculateZoomScrollAdjustment } from '../../webview/shared/zoom-math';

describe('calculateZoomScrollAdjustment', () => {
    it('returns zero delta when zoom does not change', () => {
        const result = calculateZoomScrollAdjustment({
            oldZoom: 1,
            newZoom: 1,
            cursorClientX: 500,
            cursorClientY: 300,
            canvasRectBefore: { left: 100, top: 50 },
            canvasRectAfter: { left: 100, top: 50 },
        });
        assert.strictEqual(result.deltaX, 0);
        assert.strictEqual(result.deltaY, 0);
    });

    it('keeps image point under cursor when zooming in (canvas stays pinned)', () => {
        // Setup: zoom 1x → 2x. Canvas pinned at (100, 50) in both before/after
        // (typical when canvas overflows and margin:auto yields 0).
        // Cursor at (200, 150) → image pixel (100, 100) before.
        // After zoom at 2x: same image pixel should appear at (200, 150) in viewport.
        // Canvas layout puts it at canvasRectAfter.left + 100*2 = 100 + 200 = 300
        // We want it at 200 → delta = 300 - 200 = 100
        const result = calculateZoomScrollAdjustment({
            oldZoom: 1,
            newZoom: 2,
            cursorClientX: 200,
            cursorClientY: 150,
            canvasRectBefore: { left: 100, top: 50 },
            canvasRectAfter: { left: 100, top: 50 },
        });
        assert.strictEqual(result.deltaX, 100);
        assert.strictEqual(result.deltaY, 100);
    });

    it('keeps image point under cursor when zooming out', () => {
        // 2x → 1x. Cursor at (300, 250), canvas at (100, 50).
        // cursorOnCanvas before = (200, 200) → image (100, 100)
        // After at 1x: imagePixel at (100, 100) on canvas → viewport pos = 100 + 100 = 200
        // We want it at 300 → delta = 200 - 300 = -100 (scroll LEFT by 100)
        const result = calculateZoomScrollAdjustment({
            oldZoom: 2,
            newZoom: 1,
            cursorClientX: 300,
            cursorClientY: 250,
            canvasRectBefore: { left: 100, top: 50 },
            canvasRectAfter: { left: 100, top: 50 },
        });
        assert.strictEqual(result.deltaX, -100);
        assert.strictEqual(result.deltaY, -100);
    });

    it('handles cursor at canvas origin (no adjustment needed)', () => {
        // Cursor exactly at canvas (0, 0) → image (0, 0).
        // After zoom: image (0,0) stays at canvas (0,0) = same viewport position.
        const result = calculateZoomScrollAdjustment({
            oldZoom: 1,
            newZoom: 2,
            cursorClientX: 100,
            cursorClientY: 50,
            canvasRectBefore: { left: 100, top: 50 },
            canvasRectAfter: { left: 100, top: 50 },
        });
        assert.strictEqual(result.deltaX, 0);
        assert.strictEqual(result.deltaY, 0);
    });

    it('accounts for canvas position change due to margin:auto re-centering', () => {
        // Before: canvas smaller than container, centered at (200, 100) by margin:auto.
        // After zoom-in: canvas larger, pinned to (0, 0) by margin:auto + overflow.
        // Cursor at (400, 200) → on canvas at (200, 100) → image (200, 100) at 1x.
        // After at 2x, image point should be at (200*2, 100*2) = (400, 200) on canvas.
        // Canvas is now at (0, 0). Viewport position of image point = 0 + 400 = 400. ✓ cursor.
        // But we also need delta = canvasRectAfter.left - desiredCanvasLeft
        // desired = 400 - 400 = 0. canvasRectAfter.left = 0. delta = 0. ✓
        const result = calculateZoomScrollAdjustment({
            oldZoom: 1,
            newZoom: 2,
            cursorClientX: 400,
            cursorClientY: 200,
            canvasRectBefore: { left: 200, top: 100 },
            canvasRectAfter: { left: 0, top: 0 },
        });
        assert.strictEqual(result.deltaX, 0);
        assert.strictEqual(result.deltaY, 0);
    });
});
