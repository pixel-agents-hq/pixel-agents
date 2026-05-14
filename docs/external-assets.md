# External Asset Directories

Pixel Agents supports loading furniture assets from directories outside the extension. This lets you use custom or third-party pixel art asset packs alongside the built-in furniture.

## Adding an External Directory

1. Open the Pixel Agents panel and click **Settings**
2. Click **Add Asset Directory** and pick a folder
3. Your custom assets will appear in the furniture palette immediately, merged with the built-ins
4. The directory path is saved to `~/.pixel-agents/config.json` and reloaded automatically on restart

To remove a directory, open Settings and click the **X** next to it.

## Directory Structure

Your asset directory must follow this structure:

```
my-assets/
  assets/
    furniture/
      MY_CHAIR/
        manifest.json
        MY_CHAIR.png
      MY_DESK/
        manifest.json
        MY_DESK_FRONT.png
        MY_DESK_SIDE.png
```

Each furniture item gets its own subfolder containing a `manifest.json` and one or more PNG sprite files. The folder name doesn't matter — the `id` field in the manifest is what identifies the item.

## Manifest Format

### Simple asset (single sprite, no rotation)

```json
{
  "id": "MY_ITEM",
  "name": "My Item",
  "category": "decor",
  "type": "asset",
  "file": "MY_ITEM.png",
  "width": 16,
  "height": 16,
  "footprintW": 1,
  "footprintH": 1,
  "canPlaceOnWalls": false,
  "canPlaceOnSurfaces": false,
  "backgroundTiles": 0
}
```

### Rotation group (2-way)

```json
{
  "id": "MY_DESK",
  "name": "My Desk",
  "category": "desks",
  "type": "group",
  "groupType": "rotation",
  "rotationScheme": "2-way",
  "canPlaceOnWalls": false,
  "canPlaceOnSurfaces": false,
  "backgroundTiles": 1,
  "members": [
    {
      "type": "asset",
      "id": "MY_DESK_FRONT",
      "file": "MY_DESK_FRONT.png",
      "width": 32,
      "height": 32,
      "footprintW": 2,
      "footprintH": 2,
      "orientation": "front"
    },
    {
      "type": "asset",
      "id": "MY_DESK_SIDE",
      "file": "MY_DESK_SIDE.png",
      "width": 16,
      "height": 32,
      "footprintW": 1,
      "footprintH": 2,
      "orientation": "side"
    }
  ]
}
```

### Rotation group (3-way with mirrored side)

Use `"rotationScheme": "3-way-mirror"` and add `"mirrorSide": true` to the side member — the engine auto-generates the mirrored left variant so you only need one side sprite.

```json
{
  "id": "MY_CHAIR",
  "name": "My Chair",
  "category": "chairs",
  "type": "group",
  "groupType": "rotation",
  "rotationScheme": "3-way-mirror",
  "canPlaceOnWalls": false,
  "canPlaceOnSurfaces": false,
  "backgroundTiles": 0,
  "members": [
    {
      "type": "asset",
      "id": "MY_CHAIR_FRONT",
      "file": "MY_CHAIR_FRONT.png",
      "width": 16,
      "height": 16,
      "footprintW": 1,
      "footprintH": 1,
      "orientation": "front"
    },
    {
      "type": "asset",
      "id": "MY_CHAIR_BACK",
      "file": "MY_CHAIR_BACK.png",
      "width": 16,
      "height": 16,
      "footprintW": 1,
      "footprintH": 1,
      "orientation": "back"
    },
    {
      "type": "asset",
      "id": "MY_CHAIR_SIDE",
      "file": "MY_CHAIR_SIDE.png",
      "width": 16,
      "height": 16,
      "footprintW": 1,
      "footprintH": 1,
      "orientation": "side",
      "mirrorSide": true
    }
  ]
}
```

## Field Reference

### Root fields (all manifests)

| Field                | Type                   | Description                                                                            |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `id`                 | string                 | Unique identifier. Must be unique across all loaded assets                             |
| `name`               | string                 | Display name shown in the palette                                                      |
| `category`           | string                 | Palette category: `desks`, `chairs`, `electronics`, `storage`, `decor`, `misc`, `wall` |
| `type`               | `"asset"` \| `"group"` | Single sprite or grouped (rotation/state/animation)                                    |
| `canPlaceOnWalls`    | boolean                | Whether the item can be placed on wall tiles                                           |
| `canPlaceOnSurfaces` | boolean                | Whether the item can be placed on top of desk surfaces                                 |
| `backgroundTiles`    | number                 | Number of floor tiles the sprite extends below its footprint (for tall sprites)        |

### Asset-only fields

| Field        | Type   | Description                              |
| ------------ | ------ | ---------------------------------------- |
| `file`       | string | PNG filename relative to the item folder |
| `width`      | number | Sprite width in pixels                   |
| `height`     | number | Sprite height in pixels                  |
| `footprintW` | number | Footprint width in tiles (1 tile = 16px) |
| `footprintH` | number | Footprint height in tiles                |

### Group fields

| Field            | Type                                       | Description                      |
| ---------------- | ------------------------------------------ | -------------------------------- |
| `groupType`      | `"rotation"` \| `"state"` \| `"animation"` | How members relate to each other |
| `rotationScheme` | `"2-way"` \| `"3-way-mirror"` \| `"4-way"` | Rotation variants available      |
| `members`        | array                                      | Child assets or nested groups    |

### Member orientation values

`"front"`, `"back"`, `"side"`, `"left"`, `"right"`

## Using Third-Party Asset Packs

If you have a pixel art asset pack (such as **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by [Donarg](https://donarg.itch.io/) — highly recommended), you'll need to slice the tileset into individual PNGs and create a `manifest.json` for each item.

The manifest format is simple enough that an AI assistant like Claude Code can generate them for you — just describe your sprites or share the PNGs and ask it to write the manifests.

The `scripts/asset-manager.html` in this repo also provides a visual editor for creating and editing manifests.
