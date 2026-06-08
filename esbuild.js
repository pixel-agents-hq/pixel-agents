const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Extension version read from package.json at build time, inlined via esbuild `define`. */
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
).version;
const versionDefine = {
  'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(pkgVersion),
};

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
  const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');

  if (fs.existsSync(srcDir)) {
    // Remove existing dist/assets if present
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }

    // Copy recursively
    fs.cpSync(srcDir, dstDir, { recursive: true });
    console.log('✓ Copied assets/ → dist/assets/');
  } else {
    console.log('ℹ️  assets/ folder not found (optional)');
  }
}

/**
 * Bundle hook scripts (TypeScript) to dist/hooks via esbuild.
 * Produces self-contained CJS files with shebangs for agent CLIs to execute.
 */
function buildHooks() {
  const outdir = path.join(__dirname, 'dist', 'hooks');
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });

  const entries = ['claude', 'codex']
    .map((provider) => ({
      provider,
      entry: path.join(
        __dirname,
        'server',
        'src',
        'providers',
        'hook',
        provider,
        'hooks',
        `${provider}-hook.ts`,
      ),
    }))
    .filter(({ entry }) => fs.existsSync(entry));
  if (entries.length === 0) return;
  for (const { provider, entry } of entries) {
    require('esbuild').buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'cjs',
      outfile: path.join(outdir, `${provider}-hook.js`),
      banner: { js: '#!/usr/bin/env node' },
    });
  }
  console.log('✓ Built hooks/ → dist/hooks/');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['adapters/vscode/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    define: versionDefine,
    logLevel: 'silent',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    // Copy assets and hooks after build
    copyAssets();
    buildHooks();
    await buildCli();
  }
}

/** Bundle the standalone CLI entry point. */
async function buildCli() {
  await esbuild.build({
    entryPoints: ['server/src/cli.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/cli.js',
    external: ['fastify', '@fastify/websocket', '@fastify/static', '@fastify/cors'],
    define: versionDefine,
    logLevel: 'silent',
  });
  if (!production) {
    console.log('[build] CLI bundled: dist/cli.mjs');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
