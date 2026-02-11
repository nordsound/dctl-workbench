/**
 * VS Code Integration Test Runner
 *
 * This script downloads and launches VS Code with the extension loaded,
 * then runs the integration test suite.
 */

import * as path from 'path';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import * as cp from 'child_process';

async function main() {
    // IMPORTANT: Unset ELECTRON_RUN_AS_NODE to prevent Electron from running in Node.js mode
    // This environment variable can be set by VS Code or other Electron apps in the shell,
    // which causes the test runner's VS Code instance to fail with "bad option" errors.
    delete process.env.ELECTRON_RUN_AS_NODE;

    try {
        // The folder containing the Extension Manifest package.json
        // __dirname is out/src/test, so we need to go up 3 levels to packages/vscode
        const extensionDevelopmentPath = path.resolve(__dirname, '../../../');

        // The path to the extension test script
        const extensionTestsPath = path.resolve(__dirname, './integration/index');

        console.log('Extension development path:', extensionDevelopmentPath);
        console.log('Extension tests path:', extensionTestsPath);

        // Download VS Code, unzip it and run the integration test
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // Use insiders version for latest features
            version: 'insiders',
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
