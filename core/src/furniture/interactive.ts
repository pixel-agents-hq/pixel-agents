/**
 * The furniture contract (CONTEXT.md → Interactive furniture; docs/adr/0005): a
 * furniture manifest's optional `interactive` block, and the ONE validator every
 * reader of manifests runs — the server's asset loader (bundled furniture and
 * external asset directories alike) and the office's own (core/src/assets/build.ts,
 * the dev server's catalogue). A block that fails is dropped with a warning and the
 * furniture loads as plain furniture; a valid one is carried, normalized, on every
 * asset of that furniture, and so travels with the catalogue to the office.
 *
 * The block's parts are independent and each optional:
 *   agentUse  `workstation` — agents work here
 *   label     a Furniture label: a name and lines, each shown under a condition
 *   panel     the panel the office provides that a click opens (`terminal`)
 *   states    which declared state shows under which condition
 * Conditions are a closed vocabulary over facts the office holds about a piece
 * (FURNITURE_CONDITIONS); it grows by decision, one condition at a time.
 *
 * Pure: no fs, no DOM. The rules over a block are pieceRules.ts.
 */

import { isRecord } from '../isRecord.js';
import type {
  FurnitureAgentUse,
  FurnitureCondition,
  FurnitureInteractive,
  FurnitureLabelLine,
  FurnitureLabelSpec,
  FurniturePanel,
  FurnitureStateRule,
} from '../messages.js';

export type {
  FurnitureAgentUse,
  FurnitureCondition,
  FurnitureInteractive,
  FurnitureLabelLine,
  FurnitureLabelSpec,
  FurniturePanel,
  FurnitureStateRule,
};

// Records keyed by the contract's unions, so a value added to the contract
// without its entry here (or the reverse) fails to compile.
const AGENT_USES: Record<FurnitureAgentUse, true> = { workstation: true };
const PANELS: Record<FurniturePanel, true> = { terminal: true };
const CONDITIONS: Record<FurnitureCondition, true> = {
  agentWorking: true,
  agentSeated: true,
  panelInUse: true,
  free: true,
};

export const FURNITURE_AGENT_USES = Object.keys(AGENT_USES) as FurnitureAgentUse[];
export const FURNITURE_PANELS = Object.keys(PANELS) as FurniturePanel[];
export const FURNITURE_CONDITIONS = Object.keys(CONDITIONS) as FurnitureCondition[];

/**
 * The placeholders a label line may name, each with the conditions its line must be
 * shown on alone (so the fact it names is always there to fill it).
 */
export const LABEL_PLACEHOLDERS = {
  /** The agent working at the piece, else the one seated at it. */
  agent: ['agentWorking', 'agentSeated'],
  /** What the piece's panel holds: a PC shell's Directory. */
  panel: ['panelInUse'],
} as const satisfies Record<string, readonly FurnitureCondition[]>;

export type LabelPlaceholder = keyof typeof LABEL_PLACEHOLDERS;

/** A `{name}` placeholder in a label line: the validator's reading and the label's fill. */
export const LABEL_PLACEHOLDER = /\{([^{}]*)\}/g;

const BLOCK_KEYS = new Set(['agentUse', 'label', 'panel', 'states']);
const LABEL_KEYS = new Set(['name', 'lines']);
const LINE_KEYS = new Set(['when', 'text']);
const RULE_KEYS = new Set(['state', 'when']);

export type ParsedInteractive =
  { ok: true; interactive: FurnitureInteractive } | { ok: false; problem: string };

class Refusal extends Error {}

function refuse(problem: string): never {
  throw new Refusal(problem);
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(`${where}: unknown key "${key}"`);
  }
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    refuse(`${where} must be a non-empty string`);
  return value;
}

/** A condition list: one condition, or a non-empty list of them (any holds). */
function conditions(value: unknown, where: string): FurnitureCondition[] {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0) {
    refuse(`${where} must be a condition or a non-empty list of conditions`);
  }
  return list.map((c) => {
    if (typeof c !== 'string' || !Object.hasOwn(CONDITIONS, c)) {
      refuse(`${where}: unknown condition ${JSON.stringify(c)}`);
    }
    return c as FurnitureCondition;
  });
}

function labelLine(value: unknown, where: string): FurnitureLabelLine {
  if (!isRecord(value)) refuse(`${where} must be an object`);
  onlyKeys(value, LINE_KEYS, where);
  const when = conditions(value.when, `${where}.when`);
  if (typeof value.text !== 'string') refuse(`${where}.text must be a string`);
  for (const [, name] of value.text.matchAll(LABEL_PLACEHOLDER)) {
    if (!Object.hasOwn(LABEL_PLACEHOLDERS, name))
      refuse(`${where}.text: unknown placeholder {${name}}`);
    const needs: readonly FurnitureCondition[] = LABEL_PLACEHOLDERS[name as LabelPlaceholder];
    if (when.some((c) => !needs.includes(c))) {
      refuse(`${where}.text: {${name}} needs a line shown on "${needs.join('" / "')}" alone`);
    }
  }
  return { when, text: value.text };
}

function label(value: unknown): FurnitureLabelSpec {
  if (!isRecord(value)) refuse('label must be an object');
  onlyKeys(value, LABEL_KEYS, 'label');
  const name = nonEmptyString(value.name, 'label.name');
  if (value.lines === undefined) return { name };
  if (!Array.isArray(value.lines)) refuse('label.lines must be a list');
  return { name, lines: value.lines.map((line, i) => labelLine(line, `label.lines[${i}]`)) };
}

function stateRule(
  value: unknown,
  where: string,
  declared: ReadonlySet<string>,
): FurnitureStateRule {
  if (!isRecord(value)) refuse(`${where} must be an object`);
  onlyKeys(value, RULE_KEYS, where);
  const state = nonEmptyString(value.state, `${where}.state`);
  if (!declared.has(state)) refuse(`${where}: the furniture declares no state "${state}"`);
  return { state, when: conditions(value.when, `${where}.when`) };
}

/**
 * Validate a manifest's `interactive` block against the states its furniture
 * declares (its assets' `state` values). Answers the block normalized (every
 * condition a list), or what is wrong with it.
 */
export function parseInteractive(
  raw: unknown,
  declaredStates: ReadonlySet<string>,
): ParsedInteractive {
  try {
    if (!isRecord(raw)) refuse('the interactive block must be an object');
    onlyKeys(raw, BLOCK_KEYS, 'interactive');
    const out: FurnitureInteractive = {};
    if (raw.agentUse !== undefined) {
      if (typeof raw.agentUse !== 'string' || !Object.hasOwn(AGENT_USES, raw.agentUse)) {
        refuse(`unknown agent use ${JSON.stringify(raw.agentUse)}`);
      }
      out.agentUse = raw.agentUse as FurnitureAgentUse;
    }
    if (raw.label !== undefined) out.label = label(raw.label);
    if (raw.panel !== undefined) {
      if (typeof raw.panel !== 'string' || !Object.hasOwn(PANELS, raw.panel)) {
        refuse(`unknown panel ${JSON.stringify(raw.panel)}`);
      }
      out.panel = raw.panel as FurniturePanel;
    }
    if (raw.states !== undefined) {
      if (!Array.isArray(raw.states)) refuse('states must be a list');
      out.states = raw.states.map((r, i) => stateRule(r, `states[${i}]`, declaredStates));
    }
    return { ok: true, interactive: out };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, problem: err.message };
    throw err;
  }
}

/**
 * Where a manifest is read: its furniture's flattened assets, each carrying the
 * validated block — or, with no block or a malformed one, unchanged (plain
 * furniture), a malformed one logged through `warn`, and so is an electronics
 * piece with states and no block (it was a workstation by category before).
 */
export function withInteractive<A extends { state?: string; category?: string }>(
  raw: unknown,
  assets: A[],
  furniture: string,
  warn: (message: string) => void = console.warn,
): Array<A & { interactive?: FurnitureInteractive }> {
  if (raw === undefined) {
    // Before the contract, electronics paired with seats and lit up by their
    // category alone; now only a block says so (docs/external-assets.md).
    if (assets.some((a) => a.category === 'electronics' && a.state)) {
      warn(
        `[Furniture] ${furniture}: electronics no longer pair with seats by category; add an interactive block with agentUse "workstation" and a states rule to keep it a workstation`,
      );
    }
    return assets;
  }
  const declared = new Set(assets.flatMap((a) => (a.state ? [a.state] : [])));
  const parsed = parseInteractive(raw, declared);
  if (!parsed.ok) {
    warn(
      `[Furniture] ${furniture}: interactive block dropped (${parsed.problem}); it loads as plain furniture`,
    );
    return assets;
  }
  return assets.map((a) => ({ ...a, interactive: parsed.interactive }));
}
