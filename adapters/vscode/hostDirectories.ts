/**
 * This host's Directory contribution.
 *
 * Every host contributes its native context as read-only `source: 'host'`
 * Directories — VS Code its workspace folders, standalone the directory the
 * server was started from (server/src/hostDirectory.ts). Only the adapter can
 * read `vscode.workspace`, so the shared Directory module takes these as an
 * input; this is the single place that builds them.
 */

import * as vscode from 'vscode';

import type { HostDirectoryEntry } from '../../server/src/directories.js';

/** Every workspace folder, read at call time so a folder added to the workspace
 *  shows up on the next union build. */
export function workspaceDirectories(): HostDirectoryEntry[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
  }));
}
