/**
 * A character's launch settings (`profile.launch`: the agent definition, model and effort
 * an agent launched as this character runs with), as the Characters view's Role tab edits
 * them. Pure: what a field's text means, and how a profile carries the result (never an
 * empty object: all defaults = no `launch` at all).
 */

import {
  type CharacterLaunch,
  type CharacterProfile,
  LAUNCH_AGENT_RE,
  LAUNCH_EFFORTS,
  LAUNCH_MODEL_RE,
  type LaunchEffort,
} from '../../../core/src/characterProfiles.js';
import type { LaunchRole } from '../../../core/src/messages.js';

export type LaunchField = keyof CharacterLaunch;

/** The model aliases offered as one-press choices (anything else is typed in). */
export const LAUNCH_MODEL_PRESETS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export const isLaunchEffort = (value: string): value is LaunchEffort =>
  (LAUNCH_EFFORTS as readonly string[]).includes(value);

/** Whether `value` (trimmed) may stand in `field`: nothing a command line would misread. */
export function isValidLaunchValue(field: LaunchField, value: string): boolean {
  const v = value.trim();
  if (field === 'agent') return LAUNCH_AGENT_RE.test(v);
  if (field === 'model') return LAUNCH_MODEL_RE.test(v);
  return isLaunchEffort(v);
}

/**
 * A launch draft as the profile stores it: each field trimmed, empty or invalid ones
 * dropped, and undefined when nothing is left.
 */
export function normalizeLaunch(
  draft: Partial<Record<LaunchField, string | null | undefined>> | undefined,
): CharacterLaunch | undefined {
  if (!draft) return undefined;
  const out: CharacterLaunch = {};
  for (const field of ['agent', 'model', 'effort'] as const) {
    const v = draft[field]?.trim();
    if (v && isValidLaunchValue(field, v)) out[field] = v;
  }
  return out.agent || out.model || out.effort ? out : undefined;
}

/**
 * Set one launch field on a profile (null or '' = back to the default). An invalid value
 * changes nothing and returns false; the profile never keeps an empty `launch`.
 */
export function setLaunchField(
  p: CharacterProfile,
  field: LaunchField,
  value: string | null,
): boolean {
  const v = value?.trim() ?? '';
  if (v && !isValidLaunchValue(field, v)) return false;
  const launch = normalizeLaunch({ ...p.launch, [field]: v || undefined });
  if (launch) p.launch = launch;
  else delete p.launch;
  return true;
}

/** "Role · model · effort", the parts that are set (empty when none is). */
export function launchSummary(launch: CharacterLaunch | undefined): string {
  if (!launch) return '';
  return [launch.agent, launch.model, launch.effort].filter(Boolean).join(' · ');
}

/** The one word a roster card shows for a character's launch: its role, else model, else effort. */
export function launchBadge(launch: CharacterLaunch | undefined): string {
  return launch?.agent || launch?.model || launch?.effort || '';
}

/** A path's last segment (a project role's Directory, by its folder name). */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The roles offered: user-scope ones first (they work in every Directory), then each
 * Directory's, each definition once. A name may stand in several places (Claude Code
 * picks the launch Directory's own over the user's); the profile stores only the name.
 */
export function offeredRoles(roles: readonly LaunchRole[]): LaunchRole[] {
  const seen = new Set<string>();
  const ordered = [
    ...roles.filter((r) => r.scope === 'user'),
    ...roles.filter((r) => r.scope !== 'user'),
  ];
  return ordered.filter((r) => {
    const key = `${r.scope}\0${r.directory ?? ''}\0${r.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The model a role's definition names, from the first definition of that name. */
export function roleModel(
  roles: readonly LaunchRole[],
  agent: string | undefined,
): string | undefined {
  if (!agent) return undefined;
  return offeredRoles(roles).find((r) => r.name === agent)?.model;
}
