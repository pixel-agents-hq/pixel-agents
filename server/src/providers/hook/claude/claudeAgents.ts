/**
 * Claude Code's agent definitions (subagents): markdown files with a YAML
 * frontmatter in `~/.claude/agents/` (every project) and `<project>/.claude/agents/`.
 * A character can launch as one (`claude --agent <name>`), so the Characters view
 * lists them. Only the frontmatter's `name`, `description` and `model` are read,
 * one `key: value` per line, which is how the CLI's own `/agents` writes them.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAUNCH_AGENT_RE } from '../../../../../core/src/characterProfiles.js';
import type { LaunchRole } from '../../../../../core/src/messages.js';

/** Bytes read from each file: the frontmatter sits at the top. */
const FRONTMATTER_READ_BYTES = 16 * 1024;
/** Files looked at per directory, so a huge folder can't stall a reply. */
const MAX_AGENT_FILES = 200;

/** The `key: value` lines of a markdown file's leading `---` block, or null. */
export function readFrontmatter(text: string): Record<string, string> | null {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return fields;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return null;
}

function rolesIn(dir: string, scope: 'user' | 'project', directory?: string): LaunchRole[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const roles: LaunchRole[] = [];
  for (const file of names.sort().slice(0, MAX_AGENT_FILES)) {
    let text: string;
    try {
      const fd = fs.openSync(path.join(dir, file), 'r');
      try {
        const buf = Buffer.alloc(FRONTMATTER_READ_BYTES);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const fields = readFrontmatter(text);
    const name = fields?.name || path.basename(file, '.md');
    // One the launch command could not carry is one no character can wear.
    if (!LAUNCH_AGENT_RE.test(name)) continue;
    const role: LaunchRole = { name, scope };
    if (fields?.description) role.description = fields.description;
    if (fields?.model && fields.model !== 'inherit') role.model = fields.model;
    if (directory) role.directory = directory;
    roles.push(role);
  }
  return roles;
}

/**
 * The user's agents, then each Directory's own (a project definition named like a
 * user one is listed too: inside that project it is the one the CLI runs).
 */
export function listClaudeAgents(directories: readonly string[]): LaunchRole[] {
  const roles = rolesIn(path.join(os.homedir(), '.claude', 'agents'), 'user');
  const seen = new Set<string>();
  for (const directory of directories) {
    const dir = path.join(directory, '.claude', 'agents');
    if (seen.has(dir)) continue;
    seen.add(dir);
    roles.push(...rolesIn(dir, 'project', directory));
  }
  return roles;
}
