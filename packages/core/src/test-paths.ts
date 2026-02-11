/**
 * Shared test path resolution.
 *
 * Provides portable paths for test fixtures and output directories.
 * Fixtures live in <repo-root>/test/fixtures/ and are checked into the repo.
 * Test output goes to a temp directory.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/** Repository root (dctl-workbench/) */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Test fixtures directory: <repo-root>/test/fixtures/ */
const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

/** Test output directory in system temp */
const TEST_OUTPUT_BASE = path.join(os.tmpdir(), 'dctl-workbench-test-output');

/**
 * Resolve a path within the test fixtures directory.
 * Returns null if the file doesn't exist.
 */
export function resolveFixture(...segments: string[]): string | null {
    const p = path.join(FIXTURES_DIR, ...segments);
    return fs.existsSync(p) ? p : null;
}

/**
 * Get the fixtures directory path.
 */
export function getFixturesDir(): string {
    return FIXTURES_DIR;
}

/**
 * Get a temp directory for test output files.
 * Creates it if it doesn't exist.
 */
export function getTestOutputDir(): string {
    if (!fs.existsSync(TEST_OUTPUT_BASE)) {
        fs.mkdirSync(TEST_OUTPUT_BASE, { recursive: true });
    }
    return TEST_OUTPUT_BASE;
}
