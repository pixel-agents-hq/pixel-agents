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
 * Produces a self-contained CJS file with shebang for Claude Code to execute.
 */
function buildHooks() {
  const hookEntry = (provider, file) =>
    path.join(__dirname, 'server', 'src', 'providers', 'hook', provider, 'hooks', file);
  // One entry per provider that installs a hook script. Each bundles to its own
  // self-contained CJS file, so one provider's script never depends on another's.
  const entries = [
    hookEntry('claude', 'claude-hook.ts'),
    hookEntry('codex', 'codex-hook.ts'),
  ].filter((p) => fs.existsSync(p));
  if (entries.length === 0) return;
  require('esbuild').buildSync({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: path.join(__dirname, 'dist', 'hooks'),
    // With more than one entry esbuild mirrors the shared source tree into
    // outdir (dist/hooks/claude/hooks/claude-hook.js). Every consumer — the
    // installers, the package contracts, an already-installed settings.json
    // entry — expects them flat, so outbase pins each to its own basename.
    outbase: path.join(__dirname, 'server', 'src', 'providers', 'hook'),
    entryNames: '[name]',
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log(`✓ Built ${entries.length} hook script(s) → dist/hooks/`);
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
    await buildUninstall();
  }
}

/** Bundle the vscode:uninstall hook — plain Node, runs after extension removal. */
async function buildUninstall() {
  await esbuild.build({
    entryPoints: ['adapters/vscode/uninstall.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: false,
    platform: 'node',
    outfile: 'dist/uninstall.js',
    define: versionDefine,
    logLevel: 'silent',
  });
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
