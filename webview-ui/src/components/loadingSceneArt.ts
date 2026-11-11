/**
 * The loading screen's furniture and cat, bundled with the webview: the office's assets
 * arrive from the server, and the loading screen is what shows until they do. Inlined as
 * data URIs (like the wardrobe) so VS Code's cross-origin resource host can't taint the
 * decoding canvas.
 */

import { rgbaToHex } from '../../../core/src/assets/colorUtils.js';
import {
  PET_FRAME_H,
  PET_FRAME_W_SMALL,
  PET_IDLE_FRAMES_VERT,
  PET_WALK_FRAMES_VERT,
} from '../../../core/src/assets/constants.js';
import floorUrl from '../../public/assets/floors/floor_6.png?inline';
import chairBackUrl from '../../public/assets/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_BACK.png?inline';
import chairFrontUrl from '../../public/assets/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_FRONT.png?inline';
import chairSideUrl from '../../public/assets/furniture/CUSHIONED_CHAIR/CUSHIONED_CHAIR_SIDE.png?inline';
import pcBackUrl from '../../public/assets/furniture/PC/PC_BACK.png?inline';
import pcFrontUrl from '../../public/assets/furniture/PC/PC_FRONT_OFF.png?inline';
import pcSideUrl from '../../public/assets/furniture/PC/PC_SIDE.png?inline';
import tableUrl from '../../public/assets/furniture/TABLE_FRONT/TABLE_FRONT.png?inline';
import catUrl from '../../public/assets/pets/gitcat/pet.png?inline';
import { decodePng } from '../characters/loadWardrobe.js';
import type { Rgba } from '../characters/wardrobe.js';
import { LOADING_FLOOR_COLOR } from '../constants.js';
import { colorizeSprite } from '../office/colorize.js';
import type { SpriteData } from '../office/types.js';

export interface LoadingArt {
  /** One floor tile, coloured. */
  floor: SpriteData;
  table: SpriteData;
  pcBack: SpriteData;
  pcFront: SpriteData;
  pcSide: SpriteData;
  chairFront: SpriteData;
  chairBack: SpriteData;
  chairSide: SpriteData;
  /** The cat sitting, facing down (its idle frames). */
  catSitting: SpriteData[];
}

function toSprite(img: Rgba, x0 = 0, y0 = 0, w = img.width, h = img.height): SpriteData {
  const sprite: SpriteData = [];
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * img.width + x0 + x) * 4;
      row.push(rgbaToHex(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]));
    }
    sprite.push(row);
  }
  return sprite;
}

async function sprite(url: string): Promise<SpriteData> {
  return toSprite(await decodePng(url));
}

let loading: Promise<LoadingArt> | null = null;

/** The art, decoded once. */
export function loadLoadingArt(): Promise<LoadingArt> {
  loading ??= (async () => {
    const cat = await decodePng(catUrl);
    // The pet sheet's first row: three walk frames, then three idle (sitting) frames.
    const catSitting = Array.from({ length: PET_IDLE_FRAMES_VERT }, (_, f) =>
      toSprite(
        cat,
        (PET_WALK_FRAMES_VERT + f) * PET_FRAME_W_SMALL,
        0,
        PET_FRAME_W_SMALL,
        PET_FRAME_H,
      ),
    );
    const [table, pcBack, pcFront, pcSide, chairFront, chairBack, chairSide] = await Promise.all(
      [tableUrl, pcBackUrl, pcFrontUrl, pcSideUrl, chairFrontUrl, chairBackUrl, chairSideUrl].map(
        sprite,
      ),
    );
    const floor = colorizeSprite(await sprite(floorUrl), LOADING_FLOOR_COLOR);
    return {
      floor,
      table,
      pcBack,
      pcFront,
      pcSide,
      chairFront,
      chairBack,
      chairSide,
      catSitting,
    };
  })();
  return loading;
}
