import { defineConfig } from '@vscode/test-cli';

// Common mocha and launch configuration shared by all test groups
const commonConfig = {
  version: 'insiders',
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    color: true,
  },
  launchArgs: [
    '--disable-extensions',
  ],
};

export default defineConfig([
  {
    // Non-WebGPU tests run first in their own Extension Host instance.
    // This ensures diagnostic, shader, and other tests complete cleanly
    // even if the WebGPU tests crash the Extension Host on shutdown.
    label: 'integrationTests',
    files: 'out/src/test/integration/!(webgpu-*).test.js',
    ...commonConfig,
  },
  {
    // WebGPU tests run in a separate Extension Host instance.
    // The `webgpu` npm module (Dawn backend) creates a native GPU instance
    // with no destroy API, which crashes on process cleanup (exit code 6).
    label: 'webgpuTests',
    files: 'out/src/test/integration/webgpu-*.test.js',
    ...commonConfig,
  },
]);
