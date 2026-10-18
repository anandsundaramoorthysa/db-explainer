// Bundles the extension and the SQLite worker so the .vsix stays small and needs no node_modules.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

async function main() {
  fs.mkdirSync('out', { recursive: true });
  const entryPoints = { sqliteWorker: 'src/db/sqliteWorker.ts' };
  if (fs.existsSync('src/extension.ts')) entryPoints.extension = 'src/extension.ts';
  const ctx = await esbuild.context({
    entryPoints,
    bundle: true,
    outdir: 'out',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
    minify: production,
    external: ['vscode', 'pg-native', 'cloudflare:sockets'],
    logLevel: 'info',
  });
  // sql.js loads its WebAssembly file at run time, so ship it next to the bundles.
  fs.copyFileSync(path.join('node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), path.join('out', 'sql-wasm.wasm'));
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
