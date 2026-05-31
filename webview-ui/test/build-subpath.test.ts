import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function buildSubpathPreview(base: string): Promise<string> {
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-webview-build-'));
  await build({
    configFile: path.resolve(root, 'vite.config.ts'),
    logLevel: 'silent',
    base,
    build: {
      outDir,
      emptyOutDir: true,
    },
  });
  return outDir;
}

async function startStaticServer(rootDir: string, mountPath: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(mountPath)) {
      res.writeHead(404).end('Not Found');
      return;
    }

    const relPath = decodeURIComponent(url.slice(mountPath.length)).replace(/^\/+/, '');
    let filePath = path.join(rootDir, relPath || 'index.html');
    if (statSync(filePath, { throwIfNoEntry: false })?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      res.writeHead(404).end('Not Found');
      return;
    }

    res.setHeader('Content-Type', contentTypeFor(filePath));
    res.end(readFileSync(filePath));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  return server;
}

function serverUrl(server: http.Server): string {
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} returned ${res.status.toString()}`);
  return res.text();
}

async function assertUrlOk(url: string): Promise<void> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url} returned ${res.status.toString()}`);
}

function collectBundleUrls(html: string, pageUrl: string): string[] {
  const matches = Array.from(
    html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+\.(?:js|css))"/g),
    (match) => new URL(match[1], pageUrl).toString(),
  );

  return [...new Set(matches)];
}

test('production build stays accessible from a fixed subpath', async () => {
  const outDir = await buildSubpathPreview('/sub/');
  const server = await startStaticServer(outDir, '/sub/');

  try {
    const origin = serverUrl(server);
    const indexUrl = `${origin}/sub/`;
    const html = await fetchText(indexUrl);

    assert.match(html, /\/sub\/assets\//);

    const bundleUrls = collectBundleUrls(html, indexUrl);
    assert.ok(bundleUrls.length > 0, 'expected at least one built JS or CSS asset');

    for (const url of bundleUrls) {
      await assertUrlOk(url);
    }

    await assertUrlOk(`${origin}/sub/assets/asset-index.json`);
    await assertUrlOk(`${origin}/sub/assets/furniture-catalog.json`);

    const assetsDir = path.join(outDir, 'assets');
    const staticAssets = readdirSync(assetsDir).filter((entry) => entry.endsWith('.json'));
    assert.ok(
      staticAssets.includes('asset-index.json'),
      'expected asset-index.json in build output',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(outDir, { recursive: true, force: true });
  }
});
