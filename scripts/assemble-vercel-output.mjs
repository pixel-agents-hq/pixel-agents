import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Assembles the Vercel Build Output (.vercel/output/) for the hosted preview.
//
// Currently this deploys ONLY the combined Allure test report. The standalone
// webview preview (formerly served at /webview/) was removed — it needs a mock
// data layer to be useful on a static host and we don't need it for now. To
// bring it back: restore the `dist/webview-preview` copy + the `/webview/`
// override and re-add `build:webview:preview` to the `vercel:prepare` script.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(repoRoot, 'allure-report', 'allure');
const vercelOutputDir = path.join(repoRoot, '.vercel', 'output');
const staticDir = path.join(vercelOutputDir, 'static');
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

function writeRedirectPage(filePath, title, destination) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=${destination}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <script>
      window.location.replace(${JSON.stringify(destination)});
    </script>
  </head>
  <body>
    <p>Redirecting to <a href="${destination}">${destination}</a>...</p>
  </body>
</html>
`,
  );
}

if (!existsSync(reportDir)) {
  throw new Error(`Expected report build at ${reportDir}`);
}

rmSync(vercelOutputDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });

cpSync(reportDir, path.join(staticDir, 'reports', 'allure'), { recursive: true });

// Root lands directly on the Allure dashboard (no webview to choose between).
writeRedirectPage(path.join(staticDir, 'index.html'), 'Pixel Agents Reports', '/reports/allure/');
writeRedirectPage(
  path.join(staticDir, 'reports', 'index.html'),
  'Pixel Agents Reports',
  '/reports/allure/',
);
writeRedirectPage(
  path.join(staticDir, 'reports', 'e2e', 'index.html'),
  'Pixel Agents Reports',
  '/reports/allure/',
);

writeFileSync(
  path.join(vercelOutputDir, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      framework: {
        version: packageJson.version,
      },
      overrides: {
        'index.html': {
          path: '',
        },
        'reports/index.html': {
          path: 'reports',
        },
        'reports/allure/index.html': {
          path: 'reports/allure',
        },
        'reports/e2e/index.html': {
          path: 'reports/e2e',
        },
      },
    },
    null,
    2,
  ),
);
