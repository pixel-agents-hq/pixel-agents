/** Every English namespace. Adding a namespace = its en + vi files and a line here and in vi/index.ts. */
import { app } from './app.js';
import { characters } from './characters.js';
import { common } from './common.js';
import { conversations } from './conversations.js';
import { editor } from './editor.js';
import { intro } from './intro.js';
import { launch } from './launch.js';
import { mobile } from './mobile.js';
import { music } from './music.js';
import { office } from './office.js';
import { settings } from './settings.js';
import { terminal } from './terminal.js';
import { usage } from './usage.js';

export const en = {
  common,
  settings,
  app,
  editor,
  characters,
  launch,
  intro,
  conversations,
  mobile,
  terminal,
  music,
  usage,
  office,
} as const;
