import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    label: 'integrationTests',
    files: 'out/src/test/integration/*.test.js',
    version: 'insiders',
    mocha: {
      ui: 'tdd',
      timeout: 60000,
      color: true,
    },
    launchArgs: [
      '--disable-extensions',
    ],
  },
]);
