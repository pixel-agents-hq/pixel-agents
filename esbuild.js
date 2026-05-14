const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
  const srcDir = path.join(__dirname, "webview-ui", "public", "assets");
  const dstDir = path.join(__dirname, "dist", "assets");

  if (fs.existsSync(srcDir)) {
    // Remove existing dist/assets if present
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }

    // Copy recursively
    fs.cpSync(srcDir, dstDir, { recursive: true });
    console.log("✓ Copied assets/ → dist/assets/");
  } else {
    console.log("ℹ️  assets/ folder not found (optional)");
  }
}

/**
 * Bundle hook scripts (TypeScript) to dist/hooks via esbuild.
 * Produces a self-contained CJS file with shebang for Claude Code to execute.
 */
function buildHooks() {
  const entry = path.join(
    __dirname,
    "server",
    "src",
    "providers",
    "file",
    "hooks",
    "claude-hook.ts",
  );
  if (!fs.existsSync(entry)) return;
  require("esbuild").buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    outdir: path.join(__dirname, "dist", "hooks"),
    banner: { js: "#!/usr/bin/env node" },
  });
  console.log("✓ Built hooks/ → dist/hooks/");
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
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
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
