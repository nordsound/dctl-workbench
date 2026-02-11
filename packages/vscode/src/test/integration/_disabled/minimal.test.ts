/**
 * Minimal integration test to verify VS Code test runner works
 */

import * as assert from 'assert';

describe('Minimal Integration Test', () => {
    it('should run in VS Code environment', () => {
        console.log('Minimal test is running!');
        assert.ok(true, 'Test should pass');
    });

    it('should have access to vscode module', () => {
        try {
            const vscode = require('vscode');
            console.log('vscode module loaded:', typeof vscode);
            assert.ok(vscode, 'vscode module should be available');
        } catch (e: any) {
            console.log('Failed to load vscode:', e.message);
            assert.fail('vscode module should be available in VS Code tests');
        }
    });
});
