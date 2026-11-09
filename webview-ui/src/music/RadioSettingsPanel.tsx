import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { writeClipboardText } from '../terminal/clipboard.js';
import { MOOD_KEYS, MOODS, type MoodSetting } from './moods.js';
import { officeRadio } from './musicEngine.js';

const MOOD_OPTIONS: MoodSetting[] = ['auto', ...MOOD_KEYS];
const moodName = (m: MoodSetting) => (m === 'auto' ? 'Auto' : MOODS[m].label);

/** The radio's settings panel: mood, and the song code to share a tune or play one. */
export function RadioSettingsPanel({ mood, code }: { mood: MoodSetting; code: string }) {
  const [copied, setCopied] = useState(false);
  const [entry, setEntry] = useState('');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => setCopied(false), [code]);

  const play = () => {
    if (officeRadio.playCode(entry)) {
      setEntry('');
      setInvalid(false);
    } else setInvalid(true);
  };

  return (
    <div className="pixel-panel p-8 flex flex-col gap-8">
      <span className="text-xs text-text-muted leading-none">Mood</span>
      <div className="flex flex-wrap gap-4">
        {MOOD_OPTIONS.map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mood === m ? 'active' : 'default'}
            onClick={() => officeRadio.setMood(m)}
            aria-pressed={mood === m}
          >
            {moodName(m)}
          </Button>
        ))}
      </div>

      <span className="text-xs text-text-muted leading-none mt-4">Song code</span>
      <div className="flex items-center gap-6">
        <span className="flex-1 min-w-0 truncate text-sm text-text select-all" title={code}>
          {code}
        </span>
        <Button
          size="sm"
          onClick={() => {
            void writeClipboardText(code).then((ok) => setCopied(ok));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <form
        className="flex items-center gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          play();
        }}
      >
        <input
          value={entry}
          onChange={(e) => {
            setEntry(e.target.value);
            setInvalid(false);
          }}
          placeholder="Paste a song code"
          aria-label="Song code to play"
          aria-invalid={invalid}
          className={`flex-1 min-w-0 bg-bg-dark border-2 ${invalid ? 'border-danger' : 'border-border'} px-6 py-2 text-sm text-text rounded-none outline-none focus:border-accent`}
        />
        <Button size="sm" type="submit" disabled={!entry.trim()}>
          Play
        </Button>
      </form>
      {invalid && (
        <span className="text-2xs text-danger leading-none">
          Not a song code. They look like TOWN-5-8F3A21C0.
        </span>
      )}

      <div className="flex items-center justify-between gap-8 mt-4">
        <span className="text-2xs text-text-muted leading-tight">Bring it back from Settings.</span>
        <Button size="sm" onClick={() => officeRadio.setHidden(true)}>
          Hide player
        </Button>
      </div>
    </div>
  );
}
