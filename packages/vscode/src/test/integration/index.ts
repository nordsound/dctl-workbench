/**
 * Integration Test Suite Entry Point
 *
 * This file is run inside VS Code and sets up mocha to run all integration tests.
 */

// Early logging to verify module is loaded
console.log('[integration/index] Module loading...');

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';
import { glob } from 'glob';

console.log('[integration/index] Imports complete');

// Write test output to a file for debugging
const logFile = path.resolve(__dirname, '../../../../test-output.log');
console.log('[integration/index] Log file path:', logFile);

const log = (msg: string) => {
    const timestamp = new Date().toISOString();
    try {
        fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    } catch (e) {
        console.error('[integration/index] Failed to write to log file:', e);
    }
    console.log(msg);
};

export function run(): Promise<void> {
    console.log('[integration/index] run() called');
    log('Starting integration tests...');

    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
        timeout: 60000, // 60 second timeout for integration tests
        reporter: 'spec', // Use spec reporter for detailed output
    });

    const testsRoot = path.resolve(__dirname, '.');
    log(`Tests root: ${testsRoot}`);

    return new Promise((resolve, reject) => {
        try {
            glob('**/*.test.js', { cwd: testsRoot, ignore: ['_disabled/**'] })
                .then((files: string[]) => {
                    log(`Found ${files.length} test files: ${files.join(', ')}`);

                    // Add files to the test suite
                    files.forEach((f: string) => {
                        const filePath = path.resolve(testsRoot, f);
                        log(`Adding test file: ${filePath}`);
                        mocha.addFile(filePath);
                    });

                    try {
                        // Run the mocha test
                        log('Running mocha tests...');
                        mocha.run((failures: number) => {
                            log(`Tests completed with ${failures} failures`);
                            if (failures > 0) {
                                reject(new Error(`${failures} tests failed.`));
                            } else {
                                resolve();
                            }
                        });
                    } catch (err) {
                        log(`Mocha run error: ${err}`);
                        console.error(err);
                        reject(err);
                    }
                })
                .catch((err: Error) => {
                    log(`Glob error: ${err}`);
                    reject(err);
                });
        } catch (err) {
            log(`Outer error: ${err}`);
            reject(err);
        }
    });
}
