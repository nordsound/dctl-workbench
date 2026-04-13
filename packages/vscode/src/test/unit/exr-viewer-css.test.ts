/**
 * CSS contract tests for the EXR Viewer.
 *
 * These tests prevent regressions of CSS rules whose behavior is
 * subtle but critical — in particular, the interaction between
 * flex centering and scrollable containers. See T005 for context.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

describe('exr-viewer.css', () => {
    const cssPath = path.resolve(__dirname, '../../../media/exr-viewer.css');
    let css: string;

    before(() => {
        // Strip CSS comments so their content doesn't affect rule assertions
        css = fs.readFileSync(cssPath, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    });

    describe('#canvas-container (pan container)', () => {
        // Extract the #canvas-container block
        function getCanvasContainerBlock(): string {
            const match = css.match(/#canvas-container\s*\{[^}]*\}/);
            assert.ok(match, 'CSS must define #canvas-container');
            return match![0];
        }

        it('must have overflow: auto to enable scrolling', () => {
            const block = getCanvasContainerBlock();
            assert.match(block, /overflow:\s*auto/);
        });

        // margin:auto on a child centers in both axes ONLY inside a flex
        // container. Without display:flex the canvas would center
        // horizontally only, leaving its top edge pinned to the container
        // top when the image is smaller than the viewport (T005).
        it('must have display: flex so margin:auto centers both axes', () => {
            const block = getCanvasContainerBlock();
            assert.match(block, /display:\s*flex/);
        });

        // T005: flex centering + scrollable container causes the start-side
        // overflow (left/top) to be unreachable. Panning left/up stops working
        // after zoom-in because the scroll position is clamped to 0 while the
        // content extends into negative coordinates.
        it('must NOT use flex centering (breaks bidirectional scroll)', () => {
            const block = getCanvasContainerBlock();
            assert.doesNotMatch(block, /justify-content:\s*center/,
                'justify-content: center on a scrollable flex container ' +
                'makes left overflow unreachable (T005)');
            assert.doesNotMatch(block, /align-items:\s*center/,
                'align-items: center on a scrollable flex container ' +
                'makes top overflow unreachable (T005)');
        });
    });

    describe('canvas centering', () => {
        it('canvas inside #canvas-container centers via margin:auto', () => {
            // margin: auto centers a block child when it's smaller than the
            // container, and leaves it at the natural position (0,0) when
            // it's larger — allowing symmetric scrolling in both directions.
            assert.match(css, /#canvas-container\s*>\s*canvas\s*\{[^}]*margin:\s*auto/);
        });
    });
});
