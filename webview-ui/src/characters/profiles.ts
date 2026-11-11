/**
 * What the Characters view says about a profile and how it names its files: the wardrobe
 * tabs' summaries, export file names, config files read back, roster labels and the
 * Intro greeter. The profile edits themselves (wear, colour, randomize, paint) are core's
 * (core/src/characters/profiles.ts).
 */

import {
  type CharacterProfile,
  parseCharacterProfiles,
} from '../../../core/src/characterProfiles.js';
import {
  ACCESSORIES,
  eyeShape,
  type TabKey,
  TABS,
  underOf,
} from '../../../core/src/characters/slots.js';
import { partLabel, type Wardrobe } from '../../../core/src/characters/wardrobe.js';

// ── Labels ─────────────────────────────────────────────────

/** The line under each wardrobe tab's name: what the profile wears there. */
export function tabSummary(w: Wardrobe, p: CharacterProfile, tab: TabKey): string {
  switch (tab) {
    case 'body':
      return `Chest: ${partLabel(w, 'body', p.body)}`;
    case 'eyes': {
      const { label } = eyeShape(p);
      return p.colors?.eyes || p.colors?.lashes ? `${label}, recoloured` : label;
    }
    case 'acc': {
      const worn = ACCESSORIES.filter((a) => p[a.key]).length;
      return worn ? `${worn} worn` : 'None';
    }
    default: {
      const under = underOf(tab);
      if (!p[tab] && under && p[under]) return 'Underwear';
      const { inner } = TABS.find((t) => t.key === tab)!;
      const worn = partLabel(w, tab, p[tab]);
      return inner && p[inner] ? `${worn}, ${partLabel(w, inner, p[inner])}` : worn;
    }
  }
}

/** A file name from the profile's name (char_N when unnamed). */
export function fileBaseName(p: CharacterProfile, index: number): string {
  const printable = [...(p.name ?? '')].map((ch) => (ch < ' ' ? '-' : ch)).join('');
  const cleaned = printable.replace(/[\\/:*?"<>|]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '');
  return cleaned || `char_${index}`;
}

/** fileBaseName for a whole roster, numbered on from a repeat (Bob, Bob 2) so no file overwrites another. */
export function rosterFileNames(profiles: readonly CharacterProfile[]): string[] {
  const taken = new Set<string>();
  return profiles.map((p, i) => {
    const base = fileBaseName(p, i);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

/**
 * Profiles from a config file: one profile, a list, or a saved roster ({ roster: [...] }),
 * as saved by this view or the wardrobe artifact, migrated to the current format. Null when
 * the file isn't one (parseCharacterProfiles' rules, at most MAX_CHARACTER_PROFILES, and
 * every body one the wardrobe has).
 */
export function parseConfigFile(
  w: Wardrobe,
  text: string,
  fileName: string,
): CharacterProfile[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const roster = data && typeof data === 'object' && (data as { roster?: unknown }).roster;
  const profiles = parseCharacterProfiles(
    Array.isArray(data) ? data : Array.isArray(roster) ? roster : [data],
  );
  const bodies = new Set(w.manifest.parts.body.map((b) => b.id));
  if (!profiles?.every((p) => bodies.has(p.body))) return null;
  // the parsed file is ours to change: name the unnamed after it
  return profiles.map((p) => ({ ...p, name: p.name || fileName.replace(/\.json$/i, '') }));
}

/** A character's name as the rosters show it: its name, else its sheet's file name. */
export const characterLabel = (profile: CharacterProfile | undefined, index: number): string =>
  profile?.name || `char_${index}`;

export { greeterPalette } from '../../../core/src/greeterCharacter.js';
