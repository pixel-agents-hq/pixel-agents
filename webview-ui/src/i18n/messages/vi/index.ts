import type { Messages } from '../../index.js';
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

export const vi: Messages = {
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
};
