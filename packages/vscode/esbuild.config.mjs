import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    treeShaking: true,
    external: [
        'vscode',
    ],
};

/** @type {esbuild.BuildOptions} */
const exrViewerOptions = {
    entryPoints: ['src/webview/exr-viewer.ts'],
    bundle: true,
    outfile: 'out/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    treeShaking: true,
};

async function main() {
    await Promise.all([
        esbuild.build(extensionOptions),
        esbuild.build(exrViewerOptions),
    ]);
    console.log('Build complete (extension + webview)');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
