import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { extractWorkspacePath, parseOtelRecord } from './copilot.js';

type JsonObject = Record<string, unknown>;
type EventSink = (event: JsonObject) => void;

const DEFAULT_INTERVAL_MS = 250;
const MAX_READ_BYTES = 64 * 1024;

/**
 * Append-only, partial-line-safe reader for Copilot's OTel file exporter.
 * It starts at EOF in production so historical telemetry does not resurrect
 * stale characters; tests can opt into replaying from byte zero.
 */
export class CopilotOtelTailer {
  private offset = 0;
  private remainder = '';
  private decoder = new StringDecoder('utf8');
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private readonly sessions = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly onEvent: EventSink,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
    startAtEnd = true,
  ) {
    if (startAtEnd) {
      try {
        this.offset = fs.statSync(filePath).size;
      } catch {
        this.offset = 0;
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.read(), this.intervalMs);
    this.read();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  read(): void {
    if (this.reading) return;
    this.reading = true;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size < this.offset) {
        this.offset = 0;
        this.remainder = '';
        this.decoder = new StringDecoder('utf8');
        this.sessions.clear();
      }
      if (stat.size === this.offset) return;

      const fd = fs.openSync(this.filePath, 'r');
      try {
        const bytes = Buffer.allocUnsafe(Math.min(stat.size - this.offset, MAX_READ_BYTES));
        const read = fs.readSync(fd, bytes, 0, bytes.length, this.offset);
        this.offset += read;
        this.remainder += this.decoder.write(bytes.subarray(0, read));
      } finally {
        fs.closeSync(fd);
      }

      const lines = this.remainder.split(/\r?\n/);
      this.remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let record: JsonObject;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          record = parsed as JsonObject;
        } catch {
          continue;
        }

        const events = parseOtelRecord(record);
        if (events.length === 0) continue;
        const sessionId = events[0].session_id;
        if (typeof sessionId === 'string' && !this.sessions.has(sessionId)) {
          this.sessions.add(sessionId);
          this.onEvent({
            hook_event_name: 'SessionStart',
            session_id: sessionId,
            cwd: extractWorkspacePath(record),
            modelName: record.modelName,
          });
        }
        for (const event of events) this.onEvent(event);
      }
    } catch {
      // Copilot may create or rotate the configured file between stat/open.
    } finally {
      this.reading = false;
    }
  }
}
