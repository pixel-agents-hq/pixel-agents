import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CONFIG_FILE_NAME, LAYOUT_FILE_DIR } from './constants.js';

export interface AdapterSettings {
  soundEnabled: boolean;
  lastSeenVersion: string;
  alwaysShowLabels: boolean;
  watchAllSessions: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  showAreas: boolean;
  areaMappings: Record<string, string[]>;
}

/** All keys in AdapterSettings. Used by adapters to map `pixel-agents.foo` → `foo`. */
export const ADAPTER_SETTING_KEYS = [
  'soundEnabled',
  'lastSeenVersion',
  'alwaysShowLabels',
  'watchAllSessions',
  'hooksEnabled',
  'hooksInfoShown',
  'showAreas',
  'areaMappings',
] as const;

export type AdapterSettingKey = (typeof ADAPTER_SETTING_KEYS)[number];

/** Namespaces = adapter identities sharing the same config.json file. */
export type ConfigNamespace = 'vscode' | 'standalone';

export interface PixelAgentsConfig {
  vscode: AdapterSettings;
  standalone: AdapterSettings;
  externalAssetDirectories: string[];
}

const DEFAULT_ADAPTER_SETTINGS: AdapterSettings = {
  soundEnabled: true,
  lastSeenVersion: '',
  alwaysShowLabels: false,
  watchAllSessions: false,
  hooksEnabled: true,
  hooksInfoShown: false,
  showAreas: false,
  areaMappings: {},
};

function getConfigFilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, CONFIG_FILE_NAME);
}

/**
 * Coerce a loose object into `Record<string, string[]>`, dropping any entries
 * whose value is not an array of strings. Returns `{}` if the input isn't an
 * object. Used to defensively load folder→area mappings from config.json,
 * which may have been hand-edited or written by an older build.
 */
export function parseAreaMappings(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [folder, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof folder !== 'string') {
      continue;
    }
    if (!Array.isArray(labels)) {
      continue;
    }
    const filtered = labels.filter((l): l is string => typeof l === 'string');
    out[folder] = filtered;
  }
  return out;
}

/** Coerce a loose object into a valid AdapterSettings with defaults for missing/wrong-typed fields. */
function parseAdapterSettings(raw: unknown): AdapterSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<AdapterSettings>;
  return {
    soundEnabled:
      typeof obj.soundEnabled === 'boolean'
        ? obj.soundEnabled
        : DEFAULT_ADAPTER_SETTINGS.soundEnabled,
    lastSeenVersion:
      typeof obj.lastSeenVersion === 'string'
        ? obj.lastSeenVersion
        : DEFAULT_ADAPTER_SETTINGS.lastSeenVersion,
    alwaysShowLabels:
      typeof obj.alwaysShowLabels === 'boolean'
        ? obj.alwaysShowLabels
        : DEFAULT_ADAPTER_SETTINGS.alwaysShowLabels,
    watchAllSessions:
      typeof obj.watchAllSessions === 'boolean'
        ? obj.watchAllSessions
        : DEFAULT_ADAPTER_SETTINGS.watchAllSessions,
    hooksEnabled:
      typeof obj.hooksEnabled === 'boolean'
        ? obj.hooksEnabled
        : DEFAULT_ADAPTER_SETTINGS.hooksEnabled,
    hooksInfoShown:
      typeof obj.hooksInfoShown === 'boolean'
        ? obj.hooksInfoShown
        : DEFAULT_ADAPTER_SETTINGS.hooksInfoShown,
    showAreas:
      typeof obj.showAreas === 'boolean' ? obj.showAreas : DEFAULT_ADAPTER_SETTINGS.showAreas,
    areaMappings: parseAreaMappings(obj.areaMappings),
  };
}

export function readConfig(): PixelAgentsConfig {
  const filePath = getConfigFilePath();
  try {
    if (!fs.existsSync(filePath)) {
      return {
        vscode: { ...DEFAULT_ADAPTER_SETTINGS },
        standalone: { ...DEFAULT_ADAPTER_SETTINGS },
        externalAssetDirectories: [],
      };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PixelAgentsConfig>;
    return {
      vscode: parseAdapterSettings(parsed.vscode),
      standalone: parseAdapterSettings(parsed.standalone),
      externalAssetDirectories: Array.isArray(parsed.externalAssetDirectories)
        ? parsed.externalAssetDirectories.filter((d): d is string => typeof d === 'string')
        : [],
    };
  } catch (err) {
    console.error('[Pixel Agents] Failed to read config file:', err);
    return {
      vscode: { ...DEFAULT_ADAPTER_SETTINGS },
      standalone: { ...DEFAULT_ADAPTER_SETTINGS },
      externalAssetDirectories: [],
    };
  }
}

export function writeConfig(config: PixelAgentsConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const json = JSON.stringify(config, null, 2);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, json, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error('[Pixel Agents] Failed to write config file:', err);
  }
}
