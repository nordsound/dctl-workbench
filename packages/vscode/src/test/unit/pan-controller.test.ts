/**
 * Unit tests for PanController
 *
 * Tests drag-to-pan state machine for the EXR Viewer.
 * PanController manages scroll-based panning when zoomed in.
 */

import * as assert from 'assert';
import { PanController } from '../../webview/shared/pan-controller';

describe('PanController', () => {
    describe('Initial State', () => {
        it('should start with isDragging = false', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            const state = controller.getState();
            assert.strictEqual(state.isDragging, false);
        });

        it('should return "default" cursor when image fits in container', () => {
            const controller = new PanController({ imageFitsInContainer: true });
            assert.strictEqual(controller.getState().cursor, 'default');
        });

        it('should return "grab" cursor when image does not fit', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            assert.strictEqual(controller.getState().cursor, 'grab');
        });
    });

    describe('Start Drag', () => {
        it('should set isDragging = true when image does not fit', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            const state = controller.startDrag(100, 200, 50, 75);
            assert.strictEqual(state.isDragging, true);
        });

        it('should return "grabbing" cursor when dragging', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            const state = controller.startDrag(100, 200, 0, 0);
            assert.strictEqual(state.cursor, 'grabbing');
        });

        it('should NOT start drag when image fits in container', () => {
            const controller = new PanController({ imageFitsInContainer: true });
            const state = controller.startDrag(100, 200, 0, 0);
            assert.strictEqual(state.isDragging, false);
            assert.strictEqual(state.cursor, 'default');
        });
    });

    describe('Update Drag', () => {
        it('should return null when not dragging', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            const result = controller.updateDrag(100, 200);
            assert.strictEqual(result, null);
        });

        it('should calculate correct scroll delta (inverted movement)', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(100, 200, 50, 75);

            // Mouse moved right 50px, down 50px → scroll left decreases, scroll top decreases
            const result = controller.updateDrag(150, 250);
            assert.ok(result);
            assert.strictEqual(result.scrollLeft, 0);   // 50 + (100 - 150) = 0
            assert.strictEqual(result.scrollTop, 25);    // 75 + (200 - 250) = 25
        });

        it('should handle drag to the left (scroll right)', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(200, 200, 100, 100);

            // Mouse moved left 50px → scroll increases
            const result = controller.updateDrag(150, 200);
            assert.ok(result);
            assert.strictEqual(result.scrollLeft, 150);  // 100 + (200 - 150) = 150
            assert.strictEqual(result.scrollTop, 100);   // 100 + (200 - 200) = 100
        });

        it('should handle large drags', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(500, 500, 0, 0);

            const result = controller.updateDrag(100, 100);
            assert.ok(result);
            assert.strictEqual(result.scrollLeft, 400);  // 0 + (500 - 100) = 400
            assert.strictEqual(result.scrollTop, 400);   // 0 + (500 - 100) = 400
        });
    });

    describe('End Drag', () => {
        it('should set isDragging = false', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(100, 200, 0, 0);
            assert.strictEqual(controller.getState().isDragging, true);

            const state = controller.endDrag();
            assert.strictEqual(state.isDragging, false);
        });

        it('should return "grab" cursor after drag ends (image does not fit)', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(100, 200, 0, 0);
            const state = controller.endDrag();
            assert.strictEqual(state.cursor, 'grab');
        });

        it('should be a no-op when not dragging', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            const state = controller.endDrag();
            assert.strictEqual(state.isDragging, false);
            assert.strictEqual(state.cursor, 'grab');
        });
    });

    describe('Update Options', () => {
        it('should cancel active drag when image changes to fit mode', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(100, 200, 0, 0);
            assert.strictEqual(controller.getState().isDragging, true);

            controller.updateOptions({ imageFitsInContainer: true });
            assert.strictEqual(controller.getState().isDragging, false);
            assert.strictEqual(controller.getState().cursor, 'default');
        });

        it('should allow new drags after switching to non-fit mode', () => {
            const controller = new PanController({ imageFitsInContainer: true });
            controller.updateOptions({ imageFitsInContainer: false });

            const state = controller.startDrag(100, 200, 0, 0);
            assert.strictEqual(state.isDragging, true);
        });

        it('should return null from updateDrag after drag cancelled by fit mode', () => {
            const controller = new PanController({ imageFitsInContainer: false });
            controller.startDrag(100, 200, 0, 0);
            controller.updateOptions({ imageFitsInContainer: true });

            const result = controller.updateDrag(150, 250);
            assert.strictEqual(result, null);
        });
    });

    describe('Multiple Drags', () => {
        it('should handle sequential drags correctly', () => {
            const controller = new PanController({ imageFitsInContainer: false });

            // First drag
            controller.startDrag(100, 100, 0, 0);
            let result = controller.updateDrag(50, 50);
            assert.ok(result);
            assert.strictEqual(result.scrollLeft, 50);
            assert.strictEqual(result.scrollTop, 50);
            controller.endDrag();

            // Second drag from different position
            controller.startDrag(200, 200, 50, 50);
            result = controller.updateDrag(150, 150);
            assert.ok(result);
            assert.strictEqual(result.scrollLeft, 100);  // 50 + (200 - 150) = 100
            assert.strictEqual(result.scrollTop, 100);
        });
    });
});
