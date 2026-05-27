import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { ColorPicker } from '../../components/ui/ColorPicker.js';
import { Dropdown, DropdownItem } from '../../components/ui/Dropdown.js';
import { ItemSelect } from '../../components/ui/ItemSelect.js';
import type { ColorValue } from '../../components/ui/types.js';
import { VisualColorPicker } from '../../components/VisualColorPicker.js';
import {
  AREA_DEFAULT_COLORS,
  CANVAS_FALLBACK_TILE_COLOR,
  EMPTY_SPRITE_THUMBNAIL_BG,
  PET_THUMB_SCALE_MARGIN,
  PET_THUMB_ZOOM,
} from '../../constants.js';
import { getColorizedSprite } from '../colorize.js';
import { getColorizedFloorSprite, getFloorPatternCount, hasFloorSprites } from '../floorTiles.js';
import type { FurnitureCategory, LoadedAssetData } from '../layout/furnitureCatalog.js';
import {
  buildDynamicCatalog,
  getActiveCategories,
  getCatalogByCategory,
} from '../layout/furnitureCatalog.js';
import {
  getCarpetJunctionSprite,
  getCarpetSetCount,
  hasCarpetSprites,
} from '../sprites/carpetTiles.js';
import { getPetName, getPetSprites } from '../sprites/petSpriteData.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import type { AreaDefinition, CarpetTile, SpriteData, TileType as TileTypeVal } from '../types.js';
import { EditTool } from '../types.js';
import { getWallSetCount, getWallSetPreviewSprite } from '../wallTiles.js';

/** Synthetic category id used to show the carpet sub-panel inside the Furniture tab. */
const CARPET_CATEGORY_ID = '__carpet__' as const;
type CarpetCategoryId = typeof CARPET_CATEGORY_ID;
type FurniturePanelCategory = FurnitureCategory | CarpetCategoryId;

interface EditorToolbarProps {
  activeTool: EditTool;
  selectedTileType: TileTypeVal;
  selectedFurnitureType: string;
  selectedFurnitureUid: string | null;
  selectedFurnitureColor: ColorValue | null;
  floorColor: ColorValue;
  wallColor: ColorValue;
  selectedWallSet: number;
  onToolChange: (tool: EditTool) => void;
  onTileTypeChange: (type: TileTypeVal) => void;
  onFloorColorChange: (color: ColorValue) => void;
  onWallColorChange: (color: ColorValue) => void;
  onWallSetChange: (setIndex: number) => void;
  onSelectedFurnitureColorChange: (color: ColorValue | null) => void;
  onFurnitureTypeChange: (type: string) => void;
  loadedAssets?: LoadedAssetData;
  activePetTypes: number[];
  petCount: number;
  onPetToggle: (petType: number, active: boolean) => void;
  // Carpet state + handlers
  carpetVariant: number;
  carpetColor: ColorValue;
  carpetAccentColor: ColorValue;
  onCarpetVariantChange: (variant: number) => void;
  onCarpetColorChange: (color: ColorValue) => void;
  onCarpetAccentColorChange: (color: ColorValue) => void;
  onResetCarpetColor: () => void;
  onResetCarpetAccentColor: () => void;
  // Area state + handlers
  areas: AreaDefinition[];
  selectedAreaLabel: string | null;
  workspaceFolders: { name: string; path: string }[];
  areaMappings: Record<string, string[]>;
  onSelectArea: (label: string | null) => void;
  onAddArea: (label: string, color: string) => void;
  onRemoveArea: (label: string) => void;
  onRenameArea: (oldLabel: string, newLabel: string) => void;
  onAreaColorChange: (label: string, color: string) => void;
  onAreaMappingChange: (folderName: string, areaLabel: string, action: 'add' | 'remove') => void;
}

const THUMB_ZOOM = 2;

const DEFAULT_FURNITURE_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

export function EditorToolbar({
  activeTool,
  selectedTileType,
  selectedFurnitureType,
  selectedFurnitureUid,
  selectedFurnitureColor,
  floorColor,
  wallColor,
  selectedWallSet,
  onToolChange,
  onTileTypeChange,
  onFloorColorChange,
  onWallColorChange,
  onWallSetChange,
  onSelectedFurnitureColorChange,
  onFurnitureTypeChange,
  loadedAssets,
  activePetTypes,
  petCount,
  onPetToggle,
  carpetVariant,
  carpetColor,
  carpetAccentColor,
  onCarpetVariantChange,
  onCarpetColorChange,
  onCarpetAccentColorChange,
  onResetCarpetColor,
  onResetCarpetAccentColor,
  areas,
  selectedAreaLabel,
  workspaceFolders,
  areaMappings,
  onSelectArea,
  onAddArea,
  onRemoveArea,
  onRenameArea,
  onAreaColorChange,
  onAreaMappingChange,
}: EditorToolbarProps) {
  const [activeCategory, setActiveCategory] = useState<FurniturePanelCategory>('desks');
  const [showColor, setShowColor] = useState(false);
  const [showWallColor, setShowWallColor] = useState(false);
  const [showFurnitureColor, setShowFurnitureColor] = useState(false);
  const [showCarpetColor, setShowCarpetColor] = useState(false);
  const [showCarpetAccent, setShowCarpetAccent] = useState(false);

  // Build dynamic catalog from loaded assets
  useEffect(() => {
    if (loadedAssets) {
      try {
        console.log(
          `[EditorToolbar] Building dynamic catalog with ${loadedAssets.catalog.length} assets...`,
        );
        const success = buildDynamicCatalog(loadedAssets);
        console.log(`[EditorToolbar] Catalog build result: ${success}`);

        // Reset to first available category if current doesn't exist
        const activeCategories = getActiveCategories();
        if (activeCategories.length > 0) {
          const firstCat = activeCategories[0]?.id;
          if (firstCat) {
            console.log(`[EditorToolbar] Setting active category to: ${firstCat}`);
            setActiveCategory(firstCat);
          }
        }
      } catch (err) {
        console.error(`[EditorToolbar] Error building dynamic catalog:`, err);
      }
    }
  }, [loadedAssets]);

  // For selected furniture: use existing color or default
  const effectiveColor = selectedFurnitureColor ?? DEFAULT_FURNITURE_COLOR;

  const categoryItems =
    activeCategory === CARPET_CATEGORY_ID ? [] : getCatalogByCategory(activeCategory);

  const patternCount = getFloorPatternCount();
  // Wall is TileType 0, floor patterns are 1..patternCount
  const floorPatterns = Array.from({ length: patternCount }, (_, i) => i + 1);

  const thumbSize = 42; // 2x for items

  const isFloorActive = activeTool === EditTool.TILE_PAINT || activeTool === EditTool.EYEDROPPER;
  const isWallActive = activeTool === EditTool.WALL_PAINT;
  const isEraseActive = activeTool === EditTool.ERASE;
  const isCarpetActive =
    activeTool === EditTool.CARPET_PAINT || activeTool === EditTool.CARPET_PICK;
  const isAreasActive = activeTool === EditTool.AREA_PAINT;
  // Furniture button stays "active" while editing carpets — they live inside this panel.
  const isFurnitureActive =
    activeTool === EditTool.FURNITURE_PLACE ||
    activeTool === EditTool.FURNITURE_PICK ||
    isCarpetActive;
  const isPetsActive = activeTool === EditTool.PETS;
  const carpetVariantCount = getCarpetSetCount();
  const hasWorkspaceFolders = workspaceFolders.length > 0;

  /** Build a junction sprite preview for the variant carousel thumbnail. */
  const buildCarpetPreview = (variant: number): SpriteData | null => {
    if (!hasCarpetSprites()) return null;
    // Synthesize a 2×2 grid where all 4 cells have the same variant; junction at (1,1)
    // produces msCase=15 (interior piece) — the "most representative" tile.
    const tile: CarpetTile = { variant };
    const fake: Array<CarpetTile | null> = [tile, tile, tile, tile];
    return getCarpetJunctionSprite(1, 1, variant, fake, 2, 2, carpetColor, carpetAccentColor);
  };

  return (
    <div className="absolute bottom-76 left-10 z-10 pixel-panel p-4 flex flex-col-reverse gap-4 max-w-[calc(100vw-20px)]">
      {/* Tool row — at the bottom */}
      <div className="flex gap-4 flex-wrap">
        <Button
          variant={isFurnitureActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.FURNITURE_PLACE)}
          title="Place furniture"
        >
          Furniture
        </Button>
        <Button
          variant={isFloorActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.TILE_PAINT)}
          title="Paint floor tiles"
        >
          Floor
        </Button>
        <Button
          variant={isWallActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.WALL_PAINT)}
          title="Paint walls (click to toggle)"
        >
          Wall
        </Button>
        {hasWorkspaceFolders && (
          <Button
            variant={isAreasActive ? 'active' : 'default'}
            size="md"
            onClick={() => onToolChange(EditTool.AREA_PAINT)}
            title="Define folder-bound areas — agents spawn in their folder's area"
          >
            Areas
          </Button>
        )}
        <Button
          variant={isEraseActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.ERASE)}
          title="Erase tiles to void"
        >
          Erase
        </Button>
        <Button
          variant={isPetsActive ? 'active' : 'default'}
          size="md"
          onClick={() => onToolChange(EditTool.PETS)}
          title="Place pets"
        >
          Pets
        </Button>
      </div>

      {/* Sub-panel: Floor tiles — stacked bottom-to-top via column-reverse */}
      {isFloorActive && (
        <div className="flex flex-col-reverse gap-4">
          {/* Color toggle + Pick — just above tool row */}
          <div className="flex gap-4 items-center">
            <Button
              variant={showColor ? 'active' : 'default'}
              size="sm"
              onClick={() => setShowColor((v) => !v)}
              title="Adjust floor color"
            >
              Color
            </Button>
            <Button
              variant={activeTool === EditTool.EYEDROPPER ? 'active' : 'ghost'}
              size="sm"
              onClick={() => onToolChange(EditTool.EYEDROPPER)}
              title="Pick floor pattern + color from existing tile"
            >
              Pick
            </Button>
          </div>

          {/* Color controls (collapsible) — above Wall/Color/Pick */}
          {showColor && <ColorPicker value={floorColor} onChange={onFloorColorChange} colorize />}

          {/* Floor pattern horizontal carousel — at the top */}
          <div className="carousel">
            {floorPatterns.map((patIdx) => (
              <ItemSelect
                key={patIdx}
                width={32}
                height={32}
                selected={selectedTileType === patIdx}
                onClick={() => onTileTypeChange(patIdx as TileTypeVal)}
                title={`Floor ${patIdx}`}
                deps={[patIdx, floorColor]}
                draw={(ctx, w, h) => {
                  if (!hasFloorSprites()) {
                    ctx.fillStyle = CANVAS_FALLBACK_TILE_COLOR;
                    ctx.fillRect(0, 0, w, h);
                    return;
                  }
                  const sprite = getColorizedFloorSprite(patIdx, floorColor);
                  ctx.drawImage(getCachedSprite(sprite, THUMB_ZOOM), 0, 0);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sub-panel: Wall — stacked bottom-to-top via column-reverse */}
      {isWallActive && (
        <div className="flex flex-col-reverse gap-4">
          {/* Color toggle — just above tool row */}
          <div className="flex gap-4 items-center">
            <Button
              variant={showWallColor ? 'active' : 'default'}
              size="sm"
              onClick={() => setShowWallColor((v) => !v)}
              title="Adjust wall color"
            >
              Color
            </Button>
          </div>

          {/* Color controls (collapsible) */}
          {showWallColor && <ColorPicker value={wallColor} onChange={onWallColorChange} colorize />}

          {/* Wall set picker — horizontal carousel at the top */}
          {getWallSetCount() > 0 && (
            <div className="carousel">
              {Array.from({ length: getWallSetCount() }, (_, i) => (
                <ItemSelect
                  key={i}
                  width={32}
                  height={64}
                  selected={selectedWallSet === i}
                  onClick={() => onWallSetChange(i)}
                  title={`Wall ${i + 1}`}
                  deps={[i, wallColor]}
                  draw={(ctx, w, h) => {
                    const sprite = getWallSetPreviewSprite(i);
                    if (!sprite) {
                      ctx.fillStyle = CANVAS_FALLBACK_TILE_COLOR;
                      ctx.fillRect(0, 0, w, h);
                      return;
                    }
                    const cacheKey = `wall-preview-${i}-${wallColor.h}-${wallColor.s}-${wallColor.b}-${wallColor.c}`;
                    const colorized = getColorizedSprite(cacheKey, sprite, {
                      ...wallColor,
                      colorize: true,
                    });
                    ctx.drawImage(getCachedSprite(colorized, THUMB_ZOOM), 0, 0);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sub-panel: Pets — thumbnail grid above tool row */}
      {isPetsActive && petCount > 0 && (
        <div className="flex flex-col-reverse gap-4">
          <div className="carousel" data-testid="pets-carousel">
            {Array.from({ length: petCount }, (_, i) => {
              const sprites = getPetSprites(i);
              const isActive = activePetTypes.includes(i);
              return (
                <ItemSelect
                  key={i}
                  width={32}
                  height={64}
                  selected={isActive}
                  onClick={() => onPetToggle(i, !isActive)}
                  title={getPetName(i)}
                  deps={[i, isActive]}
                  draw={(ctx, w, h) => {
                    if (!sprites) {
                      ctx.fillStyle = EMPTY_SPRITE_THUMBNAIL_BG;
                      ctx.fillRect(0, 0, w, h);
                      return;
                    }
                    const cached = getCachedSprite(sprites.idleDown[0], PET_THUMB_ZOOM);
                    const scale =
                      Math.min(w / cached.width, h / cached.height) * PET_THUMB_SCALE_MARGIN;
                    const dw = cached.width * scale;
                    const dh = cached.height * scale;
                    ctx.drawImage(cached, (w - dw) / 2, (h - dh) / 2, dw, dh);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Sub-panel: Areas — Add row + card list */}
      {isAreasActive && (
        <div className="flex flex-col-reverse gap-4 max-w-[480px]">
          <AreaAddRow areas={areas} onAddArea={onAddArea} />
          <div className="flex flex-col gap-4 max-h-300 overflow-y-auto pixel-scrollbar">
            {areas.length === 0 ? (
              <span className="text-xs text-text-muted italic">No areas yet — add one above</span>
            ) : (
              areas.map((area) => (
                <AreaCard
                  key={area.label}
                  area={area}
                  isSelected={selectedAreaLabel === area.label}
                  onSelect={() => onSelectArea(area.label)}
                  onRename={(newLabel) => onRenameArea(area.label, newLabel)}
                  onRemove={() => onRemoveArea(area.label)}
                  onColorChange={(c) => onAreaColorChange(area.label, c)}
                  workspaceFolders={workspaceFolders}
                  areaMappings={areaMappings}
                  onAreaMappingChange={onAreaMappingChange}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Sub-panel: Furniture — stacked bottom-to-top via column-reverse */}
      {isFurnitureActive && (
        <div className="flex flex-col-reverse gap-4">
          {/* Category tabs + contextual Pick button — just above tool row */}
          <div className="flex gap-4 flex-wrap items-center">
            {getActiveCategories().map((cat) => (
              <Button
                key={cat.id}
                variant={activeCategory === cat.id ? 'active' : 'ghost'}
                size="sm"
                onClick={() => {
                  setActiveCategory(cat.id);
                  // Leaving carpet sub-panel → snap back to FURNITURE_PLACE
                  if (isCarpetActive) {
                    onToolChange(EditTool.FURNITURE_PLACE);
                  }
                }}
              >
                {cat.label}
              </Button>
            ))}
            {carpetVariantCount > 0 && (
              <Button
                variant={activeCategory === CARPET_CATEGORY_ID ? 'active' : 'ghost'}
                size="sm"
                onClick={() => {
                  setActiveCategory(CARPET_CATEGORY_ID);
                  onToolChange(EditTool.CARPET_PAINT);
                }}
                title="Paint carpets"
              >
                Carpet
              </Button>
            )}
            <div className="w-[1px] h-14 bg-white/15 mx-2 shrink-0" />
            {activeCategory === CARPET_CATEGORY_ID ? (
              <Button
                variant={activeTool === EditTool.CARPET_PICK ? 'active' : 'ghost'}
                size="sm"
                onClick={() =>
                  onToolChange(
                    activeTool === EditTool.CARPET_PICK
                      ? EditTool.CARPET_PAINT
                      : EditTool.CARPET_PICK,
                  )
                }
                title="Pick carpet variant + colors from existing tile (P)"
              >
                Pick
              </Button>
            ) : (
              <Button
                variant={activeTool === EditTool.FURNITURE_PICK ? 'active' : 'ghost'}
                size="sm"
                onClick={() => onToolChange(EditTool.FURNITURE_PICK)}
                title="Pick furniture type from placed item"
              >
                Pick
              </Button>
            )}
          </div>

          {/* Carpet sub-panel: color controls + accent + variant carousel */}
          {activeCategory === CARPET_CATEGORY_ID && (
            <>
              {/* Color toggle buttons */}
              <div className="flex gap-4 items-center">
                <Button
                  variant={showCarpetColor ? 'active' : 'default'}
                  size="sm"
                  onClick={() => setShowCarpetColor((v) => !v)}
                  title="Adjust carpet main color"
                >
                  Color
                </Button>
                <Button
                  variant={showCarpetAccent ? 'active' : 'default'}
                  size="sm"
                  onClick={() => setShowCarpetAccent((v) => !v)}
                  title="Adjust carpet accent color"
                >
                  Accent
                </Button>
              </div>

              {/* Collapsible visual color pickers */}
              {showCarpetColor && (
                <div className="flex flex-col gap-4">
                  <VisualColorPicker
                    label="Main Color"
                    value={carpetColor}
                    onChange={onCarpetColorChange}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onResetCarpetColor}
                    title="Reset main color to default"
                  >
                    Reset
                  </Button>
                </div>
              )}
              {showCarpetAccent && (
                <div className="flex flex-col gap-4">
                  <VisualColorPicker
                    label="Accent Color"
                    value={carpetAccentColor}
                    onChange={onCarpetAccentColorChange}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onResetCarpetAccentColor}
                    title="Reset accent color to default"
                  >
                    Reset
                  </Button>
                </div>
              )}

              {/* Variant carousel */}
              <div className="carousel">
                {Array.from({ length: carpetVariantCount }, (_, i) => i).map((variantIdx) => (
                  <ItemSelect
                    key={variantIdx}
                    width={thumbSize}
                    height={thumbSize}
                    selected={carpetVariant === variantIdx}
                    onClick={() => {
                      onCarpetVariantChange(variantIdx);
                      if (activeTool !== EditTool.CARPET_PAINT) {
                        onToolChange(EditTool.CARPET_PAINT);
                      }
                    }}
                    title={`Carpet ${variantIdx + 1}`}
                    deps={[variantIdx, carpetColor, carpetAccentColor]}
                    draw={(ctx, w, h) => {
                      const sprite: SpriteData | null = buildCarpetPreview(variantIdx);
                      if (!sprite) {
                        ctx.fillStyle = CANVAS_FALLBACK_TILE_COLOR;
                        ctx.fillRect(0, 0, w, h);
                        return;
                      }
                      const cached = getCachedSprite(sprite, 2);
                      const scale = Math.min(w / cached.width, h / cached.height) * 0.95;
                      const dw = cached.width * scale;
                      const dh = cached.height * scale;
                      ctx.drawImage(cached, (w - dw) / 2, (h - dh) / 2, dw, dh);
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {/* Furniture items grid — hidden when carpet category is active */}
          {activeCategory !== CARPET_CATEGORY_ID && (
            <div className="carousel">
              {categoryItems.map((entry) => (
                <ItemSelect
                  key={entry.type}
                  width={thumbSize}
                  height={thumbSize}
                  selected={selectedFurnitureType === entry.type}
                  onClick={() => onFurnitureTypeChange(entry.type)}
                  title={entry.label}
                  deps={[entry.type, entry.sprite]}
                  draw={(ctx, w, h) => {
                    const cached = getCachedSprite(entry.sprite, 2);
                    const scale = Math.min(w / cached.width, h / cached.height) * 0.85;
                    const dw = cached.width * scale;
                    const dh = cached.height * scale;
                    ctx.drawImage(cached, (w - dw) / 2, (h - dh) / 2, dw, dh);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Selected furniture color panel — shows when any placed furniture item is selected */}
      {selectedFurnitureUid && (
        <div className="flex flex-col-reverse gap-4">
          <div className="flex gap-4 items-center">
            <Button
              variant={showFurnitureColor ? 'active' : 'default'}
              size="sm"
              onClick={() => setShowFurnitureColor((v) => !v)}
              title="Adjust selected furniture color"
            >
              Color
            </Button>
            {selectedFurnitureColor && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSelectedFurnitureColorChange(null)}
                title="Remove color (restore original)"
              >
                Clear
              </Button>
            )}
          </div>
          {showFurnitureColor && (
            <ColorPicker
              value={effectiveColor}
              onChange={onSelectedFurnitureColorChange}
              showColorizeToggle
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Areas sub-components ───────────────────────────────────────────

function AreaAddRow({
  areas,
  onAddArea,
}: {
  areas: AreaDefinition[];
  onAddArea: (label: string, color: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const handleSubmit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (areas.some((a) => a.label === trimmed)) return;
    const color = AREA_DEFAULT_COLORS[areas.length % AREA_DEFAULT_COLORS.length];
    onAddArea(trimmed, color);
    setDraft('');
  };
  return (
    <div className="flex gap-4 items-center">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Area name…"
        className="flex-1 text-sm py-2 px-6 bg-bg-dark border-2 border-border rounded-none text-text"
      />
      <Button variant="default" size="sm" onClick={handleSubmit} title="Add a new Area">
        Add Area
      </Button>
    </div>
  );
}

function AreaCard({
  area,
  isSelected,
  onSelect,
  onRename,
  onRemove,
  onColorChange,
  workspaceFolders,
  areaMappings,
  onAreaMappingChange,
}: {
  area: AreaDefinition;
  isSelected: boolean;
  onSelect: () => void;
  onRename: (newLabel: string) => void;
  onRemove: () => void;
  onColorChange: (color: string) => void;
  workspaceFolders: { name: string; path: string }[];
  areaMappings: Record<string, string[]>;
  onAreaMappingChange: (folderName: string, areaLabel: string, action: 'add' | 'remove') => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(area.label);
  const [addFolderOpen, setAddFolderOpen] = useState(false);

  const mappedFolders = useMemo(
    () =>
      Object.entries(areaMappings)
        .filter(([, labels]) => labels.includes(area.label))
        .map(([folder]) => folder),
    [areaMappings, area.label],
  );
  const availableFolders = useMemo(
    () => workspaceFolders.filter((f) => !mappedFolders.includes(f.name)),
    [workspaceFolders, mappedFolders],
  );

  const commitRename = () => {
    setRenaming(false);
    const trimmed = renameDraft.trim();
    if (trimmed && trimmed !== area.label) {
      onRename(trimmed);
    } else {
      setRenameDraft(area.label);
    }
  };

  return (
    <div
      onClick={onSelect}
      className={`flex flex-col gap-4 w-130 min-h-170 py-4 px-8 bg-bg-dark border-2 rounded-none cursor-pointer ${
        isSelected ? 'border-accent' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-4">
        <input
          type="color"
          value={area.color}
          onChange={(e) => onColorChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          className="w-24 h-24 p-0 border-2 border-border bg-transparent cursor-pointer"
          title="Area color"
        />
        {renaming ? (
          <input
            type="text"
            value={renameDraft}
            autoFocus
            onChange={(e) => setRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitRename();
              } else if (e.key === 'Escape') {
                setRenameDraft(area.label);
                setRenaming(false);
              }
            }}
            className="flex-1 text-sm py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenaming(true);
            }}
            className="flex-1 text-sm text-text overflow-hidden text-ellipsis whitespace-nowrap"
            title={`${area.label} — double-click to rename`}
          >
            {area.label}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e?.stopPropagation();
            onRemove();
          }}
          title="Remove area"
        >
          x
        </Button>
      </div>

      <div className="flex flex-col gap-2 max-h-80 overflow-y-auto pixel-scrollbar">
        {mappedFolders.length === 0 ? (
          <span className="text-xs text-text-muted italic">No folders mapped</span>
        ) : (
          mappedFolders.map((folder) => (
            <div key={folder} className="flex items-center gap-4 py-1 px-2">
              <span
                className="flex-1 text-xs text-text overflow-hidden text-ellipsis whitespace-nowrap"
                title={folder}
              >
                {folder}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e?.stopPropagation();
                  onAreaMappingChange(folder, area.label, 'remove');
                }}
                title="Unmap folder"
              >
                x
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="relative">
        <Button
          variant="default"
          size="sm"
          onClick={(e) => {
            e?.stopPropagation();
            if (availableFolders.length === 0) return;
            setAddFolderOpen((v) => !v);
          }}
          title={availableFolders.length === 0 ? 'All folders already mapped' : 'Map a folder…'}
        >
          Add folder…
        </Button>
        <Dropdown isOpen={addFolderOpen}>
          {availableFolders.map((f) => (
            <DropdownItem
              key={f.path}
              onClick={() => {
                onAreaMappingChange(f.name, area.label, 'add');
                setAddFolderOpen(false);
              }}
            >
              {f.name}
            </DropdownItem>
          ))}
        </Dropdown>
      </div>
    </div>
  );
}
