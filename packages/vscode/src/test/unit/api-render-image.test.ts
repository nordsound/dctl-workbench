/**
 * T013 — RED-phase unit tests for the v0.4.0 plugin API contract.
 *
 * What this file forces:
 *   - Bump PLUGIN_API_VERSION from '0.3.0' to '0.4.0'.
 *   - isCompatibleApiVersion correctly gates plugins across the bump.
 *
 * The runtime shape of the `api` object (extensionUri, renderImage) is
 * exercised at a higher tier — see the Extension Host integration test
 * added alongside GREEN. A unit test can't meaningfully build a genuine
 * vscode.Uri without the Extension Host, so we pin the version contract
 * here and leave the object-shape check to an environment that can.
 *
 * Why these matter together:
 *   A v0.4.0 plugin that calls api.renderImage on a v0.3.0 host crashes
 *   with `api.renderImage is not a function`. The only defense is the
 *   version gate, so the gate itself needs regression tests.
 *
 * Context:
 *   See docs/tasks/T013_host_render_api.md in the dctl-workbench-raw repo
 *   for the full motivation (T011 twin-tab bug, T012 selector-ownership
 *   tradeoffs, T013 render-API approach).
 */

import { strict as assert } from 'assert';
import {
    PLUGIN_API_VERSION,
    isCompatibleApiVersion,
} from '../../plugins/types';

describe('T013: plugin API v0.4.0 — version constant', () => {
    it('T013-U1 — PLUGIN_API_VERSION is bumped to 0.4.0 (renderImage + extensionUri added)', () => {
        assert.equal(PLUGIN_API_VERSION, '0.4.0');
    });
});

describe('T013: plugin API v0.4.0 — compatibility gate', () => {
    it('T013-U2 — accepts v0.4.x plugins on a v0.4.x host', () => {
        assert.equal(isCompatibleApiVersion('0.4.0', '0.4.0'), true);
        assert.equal(isCompatibleApiVersion('0.4.0', '0.4.5'), true);
    });

    it('T013-U3 — rejects a v0.4.0 plugin on a v0.3.0 host (renderImage missing)', () => {
        // A plugin that calls api.renderImage on a v0.3.0 host crashes at
        // runtime. The version gate catches this before the plugin invokes
        // the new surface, so the host can display a clean upgrade prompt.
        assert.equal(isCompatibleApiVersion('0.4.0', '0.3.0'), false);
    });

    it('T013-U4 — remains forward-compatible: v0.3.0 plugin runs on a v0.4.0 host', () => {
        // Old plugins that never touch renderImage must keep working after
        // the host bumps. The rule is "same major, actual >= required minor".
        assert.equal(isCompatibleApiVersion('0.3.0', '0.4.0'), true);
    });

    it('T013-U5 — rejects a major-version mismatch even when the minor would match', () => {
        // Defensive: once 1.0.0 ships, 0.4 plugins should NOT silently run
        // on a 1.0 host, even though 0 < 1.
        assert.equal(isCompatibleApiVersion('0.4.0', '1.0.0'), false);
        assert.equal(isCompatibleApiVersion('1.0.0', '0.4.0'), false);
    });
});
