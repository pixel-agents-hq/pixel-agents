/**
 * The pixel editor's Item section: the edited piece as a PNG (export, import) and as a
 * wardrobe item of its own (save as new, delete). Files are the piece alone, uncoloured,
 * all 24 frames in the sheet layout: the same form as the wardrobe's own art. A sheet from
 * before the seated frame (112x96) still imports: its seated frame is derived.
 */

import { useState } from 'react';

import { isItemId, MAX_WARDROBE_ITEMS } from '../../../../core/src/wardrobeItems.js';
import { castStore, registerItemArt } from '../castStore.js';
import {
  importPieceSheet,
  itemFrom,
  itemPieceOf,
  pieceName,
  pieceSheet,
  wearNewItem,
} from '../items.js';
import { decodePng } from '../loadWardrobe.js';
import { fileBaseName } from '../profiles.js';
import { decodeSheet, SHEET_H, SHEET_W } from '../sheet.js';
import { partLabel } from '../wardrobe.js';
import { ArmedButton } from './ArmedButton.js';
import { pickFiles, saveFile, sheetPng, sheetPngBase64 } from './files.js';
import { useStudio } from './studio.js';

export function ItemTools() {
  const { renderer, profile, editor, cast, status, phone } = useStudio();
  const pix = editor!.pix;
  const piece = itemPieceOf(pix);
  const worn = piece ? profile[piece] : undefined;
  const wornLabel = piece ? partLabel(renderer.wardrobe, piece, worn) : '';
  // keyed by the worn part, so the name starts over when it changes
  return (
    <ItemSection
      key={`${pix}:${worn ?? ''}`}
      defaultName={piece && worn ? `${wornLabel} 2` : ''}
      canSaveItem={!!piece && !!worn}
      custom={isItemId(worn) ? worn! : null}
      customLabel={wornLabel}
      onExport={async () => {
        const sheet = pieceSheet(renderer, profile, pix);
        if (!sheet) return;
        const filename = `${fileBaseName(profile, cast.current)}-${pieceName(renderer, profile, pix)}.png`;
        await saveFile(filename, await sheetPng(sheet));
        status(`Saved ${filename}.`, 'ok');
      }}
      onImport={() =>
        pickFiles('.png,image/png', false, ([file]) => {
          if (!file) return;
          const url = URL.createObjectURL(file);
          void decodePng(url)
            .then((img) => {
              const sheet = decodeSheet(img);
              if (!sheet) {
                status(
                  `${file.name} is ${img.width}×${img.height}. A piece sheet is ${SHEET_W}×${SHEET_H}.`,
                  'err',
                );
                return;
              }
              castStore.update((p) => importPieceSheet(renderer, p, pix, sheet), editor!.frame);
              status(`Loaded ${file.name} into ${pieceName(renderer, profile, pix)}.`, 'ok');
            })
            .catch(() => status(`Could not read ${file.name} as a PNG.`, 'err'))
            .finally(() => URL.revokeObjectURL(url));
        })
      }
      onSaveItem={(name) => {
        if (!piece) return;
        const sheet = pieceSheet(renderer, profile, pix);
        if (!sheet) return;
        const data = new Uint8ClampedArray(sheet);
        const item = itemFrom(renderer, profile, piece, name, sheetPngBase64(data));
        if (!item) return;
        registerItemArt(item.id, data);
        if (!castStore.addItem(item, (p) => wearNewItem(p, item))) {
          status(`The wardrobe holds at most ${MAX_WARDROBE_ITEMS} items of your own.`, 'err');
          return;
        }
        status(`Added ${item.label}. Save to keep it.`, 'ok');
      }}
      onDelete={(id) => castStore.removeItem(id)}
      phone={phone}
    />
  );
}

function ItemSection(props: {
  defaultName: string;
  canSaveItem: boolean;
  custom: string | null;
  customLabel: string;
  onExport: () => Promise<void>;
  onImport: () => void;
  onSaveItem: (name: string) => void;
  onDelete: (id: string) => void;
  phone: boolean;
}) {
  const [name, setName] = useState(props.defaultName);
  return (
    <div className="chv-ed-item">
      <h3>Item</h3>
      <div className="chv-toolrow">
        <button type="button" className="chv-tool" onClick={() => void props.onExport()}>
          Export PNG
        </button>
        <button type="button" className="chv-tool" onClick={props.onImport}>
          Import PNG
        </button>
      </div>
      {props.canSaveItem && (
        <form
          className="chv-ed-item-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) props.onSaveItem(name);
          }}
        >
          <input
            value={name}
            maxLength={64}
            aria-label="New item name"
            placeholder="Item name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="chv-tool" disabled={!name.trim()}>
            Save as new item
          </button>
        </form>
      )}
      {props.custom && (
        <div className="chv-toolrow">
          <ArmedButton
            className="chv-tool"
            label={`Delete ${props.customLabel}`}
            confirmLabel={props.phone ? 'Tap again' : 'Click again to delete it everywhere'}
            onConfirm={() => props.onDelete(props.custom!)}
          />
        </div>
      )}
      <p className="chv-note">
        A PNG holds this piece alone, uncoloured, every frame in the sheet layout ({SHEET_W}×
        {SHEET_H}). Importing one replaces this character’s edits to the piece. A new item joins the
        wardrobe for every character.
      </p>
    </div>
  );
}
