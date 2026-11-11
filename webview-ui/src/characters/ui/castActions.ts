/** What the roster's buttons do, shared by the desktop pane, the phone dock and the header. */

import {
  type CharacterProfile,
  MAX_CHARACTER_PROFILES,
} from '../../../../core/src/characterProfiles.js';
import { isBrowserRuntime } from '../../runtime.js';
import { castStore } from '../castStore.js';
import {
  fileBaseName,
  newProfile,
  parseConfigFile,
  randomize,
  rosterFileNames,
} from '../profiles.js';
import { pickFiles, saveFile, sheetPng, zipFiles } from './files.js';
import { type Studio, useStudio } from './studio.js';

export interface CastActions {
  add: () => void;
  addRandom: () => void;
  duplicate: () => void;
  randomizeCurrent: () => void;
  remove: (index: number) => void;
  savePng: () => Promise<void>;
  saveConfig: () => Promise<void>;
  /** Ask for .json config files and add their characters. */
  loadConfigs: () => void;
  saveRoster: () => Promise<void>;
}

/** The current studio's roster actions. */
export const useCastActions = (): CastActions => castActions(useStudio());

export function castActions(studio: Studio): CastActions {
  const { renderer, cast, profile, setTab, status } = studio;
  // the browser downloads at once; VS Code shows its own save dialog and notice
  const saved = (filename: string) => {
    if (isBrowserRuntime) status(`Saved ${filename}.`, 'ok');
  };
  const full = `The roster holds at most ${MAX_CHARACTER_PROFILES} characters.`;
  /** Add to the cast; false (and says so) when the roster is full. */
  const addOne = (p: CharacterProfile, at?: number) => {
    if (castStore.add([p], at)) return true;
    status(full, 'err');
    return false;
  };
  const loadConfigs = async (files: File[]) => {
    const added: CharacterProfile[] = [];
    const bad: string[] = [];
    for (const file of files) {
      const profiles = parseConfigFile(renderer.wardrobe, await file.text(), file.name);
      if (profiles) added.push(...profiles);
      else bad.push(file.name);
    }
    const loaded = castStore.add(added);
    const count = (n: number) => `${n} ${n === 1 ? 'character' : 'characters'}`;
    if (bad.length) status(`Could not read ${bad.join(', ')} as a character config.`, 'err');
    else if (loaded < added.length) {
      status(`${full} Loaded ${count(loaded)}, left out ${added.length - loaded}.`, 'err');
    } else if (loaded) status(`Loaded ${count(loaded)}.`, 'ok');
  };
  return {
    add: () => {
      if (addOne(newProfile())) setTab('body');
    },
    addRandom: () => {
      const p = newProfile();
      randomize(renderer, p);
      if (addOne(p)) setTab('body');
    },
    duplicate: () => {
      const copy = structuredClone(profile);
      copy.name = `${copy.name || 'Copy'} 2`;
      addOne(copy, cast.current + 1);
    },
    randomizeCurrent: () => studio.edit((p) => randomize(renderer, p)),
    remove: (index) => castStore.remove(index),
    savePng: async () => {
      const filename = `${fileBaseName(profile, cast.current)}.png`;
      await saveFile(filename, await sheetPng(renderer.sheet(profile)));
      saved(filename);
    },
    saveConfig: async () => {
      const filename = `${fileBaseName(profile, cast.current)}.json`;
      await saveFile(
        filename,
        new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }),
      );
      saved(filename);
    },
    loadConfigs: () =>
      pickFiles('.json,application/json', true, (files) => void loadConfigs(files)),
    saveRoster: async () => {
      // each character's sheet and config, named after it (char_N when unnamed)
      const names = rosterFileNames(cast.profiles);
      const files = (
        await Promise.all(
          cast.profiles.map(async (p, i) => [
            {
              name: `${names[i]}.png`,
              data: new Uint8Array(await (await sheetPng(renderer.sheet(p))).arrayBuffer()),
            },
            {
              name: `${names[i]}.json`,
              data: new TextEncoder().encode(JSON.stringify(p, null, 2)),
            },
          ]),
        )
      ).flat();
      const filename = 'pixel-agents-characters.zip';
      await saveFile(filename, zipFiles(files));
      saved(filename);
    },
  };
}
