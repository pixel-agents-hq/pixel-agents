import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import {
  HOOK_API_PREFIX,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
} from "../../../../constants.js";
import type { ServerConfig } from "../../../../server.js";

const SERVER_JSON = path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  let server: ServerConfig;
  try {
    server = JSON.parse(fs.readFileSync(SERVER_JSON, "utf-8"));
  } catch {
    process.exit(0);
  }

  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: `${HOOK_API_PREFIX}/claude`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${server.token}`,
        },
        timeout: 2000,
      },
      () => resolve(),
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
