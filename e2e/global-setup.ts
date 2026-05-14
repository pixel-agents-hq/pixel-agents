import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import fs from "fs";
import path from "path";

export const VSCODE_CACHE_DIR = path.join(__dirname, "../.vscode-test");
export const VSCODE_PATH_FILE = path.join(
  VSCODE_CACHE_DIR,
  "vscode-executable.txt",
);

/**
 * On Windows, VS Code checks for an InnoSetup mutex (`win32MutexName + "-updating"`)
 * at startup. If the host machine's VS Code installer is running (e.g. a pending
 * "Restart to Update"), the mutex is held and ALL VS Code instances — including our
 * test archive — refuse to start with "Code is currently being updated".
 *
 * The check in main.js is:
 *   if (!(isWindows && product.win32MutexName && product.win32VersionedUpdate)) return false;
 *
 * Removing `win32VersionedUpdate` from product.json makes the check short-circuit,
 * so the test instance launches regardless of installer state. This is safe because
 * the test archive is not managed by InnoSetup and never needs update coordination.
 */
function patchProductJsonForWindows(vscodePath: string): void {
  if (process.platform !== "win32") return;

  // vscodePath points to Code.exe — product.json is in the resources/app dir
  const vscodeDir = path.dirname(vscodePath);
  const candidates = fs
    .readdirSync(vscodeDir)
    .filter((d) => {
      try {
        return fs.statSync(path.join(vscodeDir, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((d) => path.join(vscodeDir, d, "resources", "app", "product.json"))
    .filter((p) => fs.existsSync(p));

  for (const productJsonPath of candidates) {
    try {
      const product = JSON.parse(fs.readFileSync(productJsonPath, "utf8"));
      let patched = false;

      if (product.win32VersionedUpdate) {
        delete product.win32VersionedUpdate;
        patched = true;
      }
      // Also check nested objects (e.g. "tunnelApplicationConfig")
      for (const key of Object.keys(product)) {
        if (
          typeof product[key] === "object" &&
          product[key]?.win32VersionedUpdate
        ) {
          delete product[key].win32VersionedUpdate;
          patched = true;
        }
      }

      if (patched) {
        fs.writeFileSync(
          productJsonPath,
          JSON.stringify(product, null, "\t") + "\n",
          "utf8",
        );
        console.log(
          `[e2e] Patched product.json to skip InnoSetup mutex check: ${productJsonPath}`,
        );
      }
    } catch (err) {
      console.warn(
        `[e2e] Failed to patch product.json at ${productJsonPath}:`,
        err,
      );
    }
  }
}

export default async function globalSetup(): Promise<void> {
  console.log("[e2e] Ensuring VS Code is downloaded...");
  const vscodePath = await downloadAndUnzipVSCode({
    version: "stable",
    cachePath: VSCODE_CACHE_DIR,
  });
  console.log(`[e2e] VS Code executable: ${vscodePath}`);

  patchProductJsonForWindows(vscodePath);

  fs.mkdirSync(VSCODE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(VSCODE_PATH_FILE, vscodePath, "utf8");
}
