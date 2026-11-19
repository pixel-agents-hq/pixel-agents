/**
 * The contract every Pixel Office MCP tool follows. A tool is DATA: its name,
 * description, zod input shape, whether it changes the office, the office
 * capabilities it uses, and a `run`
 * that validates nothing the schema already did, calls office operations and
 * returns `ok(value)` or `refuse(reason)`. The MCP module does the rest —
 * registering it, resolving the caller from the request's token, refusing a
 * changing tool while read-only, turning results and throws into MCP replies.
 *
 * Adding a tool: one file under ./tools/ exporting `defineTool({...})`, and
 * its line in ./tools/index.ts.
 */

import type { z } from 'zod';

import type { Capability, OfficeCapabilities } from './officeOperations.js';

/** What a tool's `run` knows about the call. */
export interface ToolContext<Uses extends Capability = Capability> {
  /** The calling agent's id (from its token: never from the request body). */
  caller: number;
  /** The office, as this tool may touch it: the capabilities it `uses`. */
  office: Pick<OfficeCapabilities, Uses>;
  /** The agent a tool acts on: `agentId` when given, else the caller. */
  target(agentId: number | undefined): number;
}

/** A picture for the agent: sent as MCP image content after the JSON, in order.
 *  What each one shows is said in the JSON (the image itself carries no label). */
export interface ToolImage {
  data: Buffer;
  mimeType: 'image/png';
}

/** A tool's outcome: a value for the agent (and pictures), or a refusal saying what to do next. */
export type ToolResult =
  { ok: true; value: unknown; images?: readonly ToolImage[] } | { ok: false; reason: string };

/** A successful result; `value` is sent to the agent as JSON, then `images`. */
export function ok(value: unknown, images?: readonly ToolImage[]): ToolResult {
  return images?.length ? { ok: true, value, images } : { ok: true, value };
}

/** A refusal. Say what went wrong AND what the agent can do about it. */
export function refuse(reason: string): ToolResult {
  return { ok: false, reason };
}

export interface OfficeTool<
  Shape extends z.ZodRawShape = z.ZodRawShape,
  Uses extends Capability = Capability,
> {
  /** snake_case; Claude Code shows it as `mcp__pixel-office__<name>`. */
  name: string;
  title: string;
  /** What the tool does and when to use it: the agent's only manual. */
  description: string;
  /** The input's fields (an empty object for none). Validated before `run`. */
  input: Shape;
  /** True when the tool changes anything (the layout, an agent, a terminal):
   *  refused while the MCP is read-only. False = a list/get tool. */
  changes: boolean;
  /** The office capabilities `run` calls. The tool is offered only where the
   *  surface supplies every one of them (VS Code has no `launch` or `close`). */
  uses: readonly Uses[];
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext<Uses>): ToolResult | Promise<ToolResult>;
}

/** Types `run`'s args from `input` and its office from `uses`, then erases
 *  both so every tool fits one table (the module validates args against
 *  `input` before `run`, and registers the tool only where `uses` is supplied). */
export function defineTool<Shape extends z.ZodRawShape, Uses extends Capability>(
  tool: OfficeTool<Shape, Uses>,
): OfficeTool {
  return tool as unknown as OfficeTool;
}
