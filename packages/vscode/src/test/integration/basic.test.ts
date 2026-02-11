/**
 * Basic integration test to verify VS Code test runner works
 * Uses TDD style (suite/test) to match mocha configuration
 */

console.log('[basic.test.ts] Module loading...');

import * as assert from 'assert';

console.log('[basic.test.ts] Registering suite...');

suite('Basic Integration Test Suite', () => {
    test('should pass basic assertion', () => {
        console.log('Basic test running...');
        assert.strictEqual(1 + 1, 2);
    });

    test('should have access to vscode module', () => {
        const vscode = require('vscode');
        console.log('vscode version:', vscode.version);
        assert.ok(vscode, 'vscode module should be available');
    });
});
