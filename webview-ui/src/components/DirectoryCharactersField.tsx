import { useState } from 'react';

import type { DirectoryCharacterOrder } from '../../../core/src/messages.js';
import { useCast } from '../characters/castStore.js';
import { characterLabel } from '../characters/profiles.js';
import type { MessageKey } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { PixelIcon } from './ui/PixelIcon.js';
import { useCardReorder } from './useCardReorder.js';

interface DirectoryCharactersFieldProps {
  /** Default characters (palette indices), highest priority first. */
  characters: number[];
  order: DirectoryCharacterOrder;
  onChange: (characters: number[], order: DirectoryCharacterOrder) => void;
}

const ORDER_HINT: Record<DirectoryCharacterOrder, MessageKey> = {
  priority: 'launch.orderHintPriority',
  random: 'launch.orderHintRandom',
};

/**
 * The Directory modal's default characters: the chosen ones in priority order
 * (drag to reorder: a mouse drag, or a long press on touch; × removes), a `+`
 * that opens the rest of the cast to add from, and whether launches take them
 * in order or at random.
 */
export function DirectoryCharactersField({
  characters,
  order,
  onChange,
}: DirectoryCharactersFieldProps) {
  const t = useT();
  const cast = useCast();
  const [isPicking, setIsPicking] = useState(false);
  const count = getLoadedCharacterCount();
  // A default whose character was deleted is dropped on the next save.
  const chosen = characters.filter((c) => c < count);
  const available = Array.from({ length: count }, (_, i) => i).filter((i) => !chosen.includes(i));
  const reorder = useCardReorder({
    ids: chosen,
    axis: 'x',
    enabled: chosen.length > 1,
    onCommit: (next) => onChange(next, order),
  });
  const label = (i: number) => characterLabel(cast.profiles[i], i);

  return (
    <div data-testid="directory-characters-field" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-8">
        <span className="text-xs text-text-muted">{t('launch.characters')}</span>
        {chosen.length > 0 && (
          <span className="flex gap-4">
            {(['priority', 'random'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => onChange(chosen, o)}
                aria-pressed={order === o}
                className={`text-xs py-1 px-4 border-2 rounded-none cursor-pointer ${
                  order === o
                    ? 'bg-accent border-accent text-text'
                    : 'bg-transparent border-border text-text-muted hover:text-text'
                }`}
              >
                {o === 'priority' ? t('launch.orderPriority') : t('launch.orderRandom')}
              </button>
            ))}
          </span>
        )}
      </div>
      <div
        ref={reorder.containerRef}
        className="flex items-stretch gap-4 overflow-x-auto overscroll-contain pixel-scrollbar pb-2"
      >
        {reorder.displayIds.map((palette, position) => (
          <div
            key={palette}
            ref={reorder.cardRef(palette)}
            onTouchStart={reorder.onTouchStart(palette)}
            onMouseDown={reorder.onMouseDown(palette)}
            title={label(palette)}
            className={`relative shrink-0 flex border-2 bg-bg-thumb select-none [-webkit-touch-callout:none] ${
              chosen.length > 1 ? 'cursor-grab' : ''
            } ${
              reorder.draggingId === palette
                ? 'z-10 opacity-70 -translate-y-4 border-accent-bright'
                : 'border-border'
            }`}
          >
            <CharacterMugShot palette={palette} repeat={0} />
            {order === 'priority' && (
              <span className="absolute bottom-0 left-0 px-2 bg-bg text-2xs leading-none text-text-muted">
                {position + 1}
              </span>
            )}
            <button
              type="button"
              onClick={() =>
                onChange(
                  chosen.filter((c) => c !== palette),
                  order,
                )
              }
              aria-label={t('launch.removeCharacter', { name: label(palette) })}
              title={t('common.remove')}
              className="absolute top-0 right-0 flex p-2 bg-bg border-none rounded-none cursor-pointer leading-none text-text-muted hover:text-text"
            >
              <PixelIcon name="close" scale={1} />
            </button>
          </div>
        ))}
        {available.length > 0 && (
          <button
            type="button"
            onClick={() => setIsPicking((open) => !open)}
            aria-expanded={isPicking}
            aria-label={t('launch.addDefaultCharacter')}
            title={t('launch.addDefaultCharacter')}
            className={`shrink-0 w-44 flex items-center justify-center border-2 border-dashed rounded-none cursor-pointer bg-transparent ${
              isPicking
                ? 'border-accent-bright text-text'
                : 'border-border text-text-muted hover:text-text'
            }`}
          >
            <PixelIcon name="plus" />
          </button>
        )}
      </div>
      {isPicking && available.length > 0 && (
        <div
          data-testid="directory-character-options"
          className="flex flex-wrap gap-4 max-h-120 overflow-y-auto pixel-scrollbar"
        >
          {available.map((palette) => (
            <button
              key={palette}
              type="button"
              onClick={() => {
                onChange([...chosen, palette], order);
                if (available.length === 1) setIsPicking(false);
              }}
              aria-label={t('launch.addCharacter', { name: label(palette) })}
              title={label(palette)}
              className="shrink-0 flex p-0 bg-bg-thumb border-2 border-transparent rounded-none cursor-pointer hover:border-border"
            >
              <CharacterMugShot palette={palette} repeat={0} />
            </button>
          ))}
        </div>
      )}
      <span className="text-2xs text-text-muted">
        {chosen.length === 0 ? t('launch.noDefaults') : t(ORDER_HINT[order])}
      </span>
    </div>
  );
}
