// @ts-check
const esbuild = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  treeShaking: true,
};

async function removeStaleVsixArtifacts() {
  const entries = await fs.readdir(process.cwd(), { withFileTypes: true });
  const staleArtifacts = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.vsix'))
    .map(entry => path.join(process.cwd(), entry.name));

  await Promise.all(staleArtifacts.map(filePath => fs.rm(filePath, { force: true })));

  if (staleArtifacts.length > 0) {
    console.log(`Removed ${staleArtifacts.length} stale VSIX artifact(s).`);
  }
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    await removeStaleVsixArtifacts();

    // Build D3 bundle for knowledge graph webview
    await esbuild.build({
      stdin: {
        contents: `
          export { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from 'd3-force';
          export { select, selectAll } from 'd3-selection';
          export { zoom, zoomIdentity } from 'd3-zoom';
          export { drag } from 'd3-drag';
          export { scaleLinear } from 'd3-scale';
        `,
        resolveDir: '.',
      },
      bundle: true,
      format: 'iife',
      globalName: 'd3',
      minify: true,
      outfile: 'dist/d3-bundle.js',
    });

    console.log('Build complete.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
