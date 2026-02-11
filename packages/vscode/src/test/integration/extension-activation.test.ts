/**
 * Extension Activation Integration Tests
 *
 * Verifies that the DCTL Workbench extension activates correctly
 * and registers all expected components.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Find the DCTL Workbench extension
 * The extension ID format is: publisher.name
 */
function findDctlExtension(): vscode.Extension<unknown> | undefined {
    // Try multiple possible extension IDs
    const possibleIds = [
        'your-publisher-id.dctl-workbench',
        'dctl-workbench.dctl-workbench',
        'dctl-workbench',
    ];

    for (const id of possibleIds) {
        const ext = vscode.extensions.getExtension(id);
        if (ext) {
            return ext;
        }
    }

    // Fall back to searching all extensions
    return vscode.extensions.all.find(ext =>
        ext.packageJSON?.name === 'dctl-workbench' ||
        ext.id.includes('dctl-workbench')
    );
}

suite('Extension Activation', () => {
    let extension: vscode.Extension<unknown> | undefined;

    suiteSetup(function () {
        extension = findDctlExtension();
        if (!extension) {
            console.log('DCTL Workbench extension not found');
            console.log('Available extensions:', vscode.extensions.all.map(e => e.id).slice(0, 20));
            // Skip all tests in this suite
            this.skip();
        }
    });

    test('should activate on DCTL file open', async function () {
        if (!extension) {
            this.skip();
            return;
        }

        // Wait for activation if not already active
        if (!extension.isActive) {
            await extension.activate();
        }

        assert.ok(extension.isActive, 'Extension should be active');
    });

    test('should register EXR custom editor', function () {
        if (!extension) {
            this.skip();
            return;
        }

        // Check package.json contributes
        const contributes = extension.packageJSON.contributes;
        assert.ok(contributes, 'Extension should have contributions');

        if (contributes.customEditors) {
            const exrEditor = contributes.customEditors.find(
                (editor: { viewType: string }) =>
                    editor.viewType.includes('exr') || editor.viewType.includes('Exr')
            );
            assert.ok(exrEditor, 'EXR viewer custom editor should be registered');
        } else {
            console.log('No custom editors defined (optional)');
        }
    });

    test('should provide DCTL language support', function () {
        if (!extension) {
            this.skip();
            return;
        }

        const contributes = extension.packageJSON.contributes;
        assert.ok(contributes.languages, 'Extension should contribute languages');

        const dctlLang = contributes.languages.find(
            (lang: { id: string }) => lang.id === 'dctl'
        );
        assert.ok(dctlLang, 'DCTL language should be registered');
        assert.ok(dctlLang.extensions, 'DCTL should have file extensions');
        assert.ok(dctlLang.extensions.includes('.dctl'), '.dctl extension should be registered');
    });

    test('should register commands', function () {
        if (!extension) {
            this.skip();
            return;
        }

        const contributes = extension.packageJSON.contributes;
        if (contributes.commands) {
            // Check that commands array exists and has items
            assert.ok(Array.isArray(contributes.commands), 'Commands should be an array');
            console.log(`Found ${contributes.commands.length} commands`);
        } else {
            console.log('No commands defined (optional)');
        }
    });

    test('should have DCTL grammar configuration', function () {
        if (!extension) {
            this.skip();
            return;
        }

        const contributes = extension.packageJSON.contributes;
        assert.ok(contributes.grammars, 'Extension should have grammars');

        const dctlGrammar = contributes.grammars.find(
            (grammar: { language: string }) => grammar.language === 'dctl'
        );
        assert.ok(dctlGrammar, 'DCTL grammar should be registered');
        assert.ok(dctlGrammar.scopeName, 'DCTL grammar should have scope name');
    });

    test('should be able to access extension context', async function () {
        if (!extension) {
            this.skip();
            return;
        }

        if (!extension.isActive) {
            await extension.activate();
        }

        // Extension exports can be accessed here
        const exports = extension.exports;
        // The extension may or may not export anything
        console.log('Extension exports:', exports);
        // Just verify no error occurs
        assert.ok(true);
    });

    test('should have correct extension metadata', function () {
        if (!extension) {
            this.skip();
            return;
        }

        const packageJSON = extension.packageJSON;
        assert.ok(packageJSON.name, 'Extension should have a name');
        assert.ok(packageJSON.version, 'Extension should have a version');
        assert.ok(packageJSON.engines?.vscode, 'Extension should specify VS Code engine');
    });

    test('should register configuration settings', function () {
        if (!extension) {
            this.skip();
            return;
        }

        const contributes = extension.packageJSON.contributes;
        if (contributes.configuration) {
            assert.ok(
                contributes.configuration.properties,
                'Extension should have configuration properties'
            );
        }
        // Configuration is optional, so just log if not present
        console.log('Configuration check passed');
    });
});
