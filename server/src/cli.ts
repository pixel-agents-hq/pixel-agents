#!/usr/bin/env node

/**
 * Standalone CLI entry point: `npx pixel-agents`
 *
 * Starts the Fastify server in standalone mode with SPA serving and WebSocket.
 * In this mode, the browser UI connects via WebSocket (not VS Code postMessage).
 */

import * as path from 'path';

import { AgentStateStore } from './agentStateStore.js';
import { PixelAgentsServer } from './server.js';

// ── Argument parsing ──────────────────────────────────────────

interface CliArgs {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: 3100, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === '--host' && argv[i + 1]) {
      args.host = argv[i + 1];
      i++;
    } else if (argv[i] === '--help') {
      console.log(`Usage: pixel-agents [options]

Options:
  --port, -p <number>   Port to listen on (default: 3100)
  --host <string>       Host to bind to (default: 127.0.0.1)
  --help                Show this help message`);
      process.exit(0);
    }
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const store = new AgentStateStore();
  // Future: store.setAdapter(new FileStateAdapter()) for standalone persistence

  const server = new PixelAgentsServer();

  try {
    // __dirname equivalent for bundled CJS output
    // When bundled by esbuild to dist/cli.js, __dirname = dist/.
    // Vite outputs the SPA to dist/webview/.
    const staticDir = path.join(__dirname, 'webview');
    const config = await server.start({
      store,
      embedded: false,
      host: args.host,
      port: args.port,
      staticDir,
    });

    console.log(`\n  Pixel Agents server running at http://${args.host}:${config.port}\n`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }

  // Graceful shutdown
  function shutdown(): void {
    console.log('\nShutting down...');
    server.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
