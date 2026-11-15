import { type MessageKey, t } from '../i18n/index.js';
import type { MoodSetting } from './moods.js';

/** Each mood's display name (the keys themselves are part of the song-code format). */
const MOOD_LABEL: Record<MoodSetting, MessageKey> = {
  auto: 'music.moodAuto',
  town: 'music.moodTown',
  route: 'music.moodRoute',
  lab: 'music.moodLab',
  night: 'music.moodNight',
  orbit: 'music.moodOrbit',
  rain: 'music.moodRain',
  dawn: 'music.moodDawn',
  arcade: 'music.moodArcade',
};

/** A mood (or Auto) as people read it, in the current language. */
export const moodLabel = (mood: MoodSetting): string => t(MOOD_LABEL[mood]);
