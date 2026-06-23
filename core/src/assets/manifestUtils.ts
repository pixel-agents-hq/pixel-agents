/**
 * Manifest flattening utilities — shared between the extension host, Vite build
 * scripts, and future standalone backend.
 *
 * Recursively flattens furniture manifest trees into flat asset arrays.
 */

// ── Manifest types ──────────────────────────────────────────

export interface ManifestAsset {
  type: 'asset';
  id: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  orientation?: string;
  state?: string;
  frame?: number;
  mirrorSide?: boolean;
}

export interface ManifestGroup {
  type: 'group';
  groupType: 'rotation' | 'state' | 'animation';
  rotationScheme?: string;
  orientation?: string;
  state?: string;
  members: ManifestNode[];
}

export type ManifestNode = ManifestAsset | ManifestGroup;

export interface FurnitureManifest {
  id: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  // If type is 'asset', these fields are present:
  type: 'asset' | 'group';
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  // If type is 'group':
  groupType?: string;
  rotationScheme?: string;
  members?: ManifestNode[];
}

export interface InheritedProps {
  groupId: string;
  name: string;
  category: string;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces: boolean;
  backgroundTiles: number;
  orientation?: string;
  state?: string;
  rotationScheme?: string;
  animationGroup?: string;
}

export interface FurnitureAsset {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

/**
 * Recursively flatten a manifest node into FurnitureAsset[].
 * Inherited properties flow from root to all leaf assets.
 */
export function flattenManifest(node: ManifestNode, inherited: InheritedProps): FurnitureAsset[] {
  if (node.type === 'asset') {
    const asset = node as ManifestAsset;
    // Merge orientation: node-level takes priority, then inherited
    const orientation = asset.orientation ?? inherited.orientation;
    const state = asset.state ?? inherited.state;
    return [
      {
        id: asset.id,
        name: inherited.name,
        label: inherited.name,
        category: inherited.category,
        file: asset.file,
        width: asset.width,
        height: asset.height,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        isDesk: inherited.category === 'desks',
        canPlaceOnWalls: inherited.canPlaceOnWalls,
        canPlaceOnSurfaces: inherited.canPlaceOnSurfaces,
        backgroundTiles: inherited.backgroundTiles,
        groupId: inherited.groupId,
        ...(orientation ? { orientation } : {}),
        ...(state ? { state } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {}),
        ...(inherited.rotationScheme ? { rotationScheme: inherited.rotationScheme } : {}),
        ...(inherited.animationGroup ? { animationGroup: inherited.animationGroup } : {}),
        ...(asset.frame !== undefined ? { frame: asset.frame } : {}),
      },
    ];
  }

  // Group node
  const group = node as ManifestGroup;
  const results: FurnitureAsset[] = [];

  for (const member of group.members) {
    // Build inherited props for children
    const childProps: InheritedProps = { ...inherited };

    if (group.groupType === 'rotation') {
      // Rotation groups set groupId and pass rotationScheme
      if (group.rotationScheme) {
        childProps.rotationScheme = group.rotationScheme;
      }
    }

    if (group.groupType === 'state') {
      // State groups propagate orientation from the group level
      if (group.orientation) {
        childProps.orientation = group.orientation;
      }
      // Propagate state from group level if set (for animation groups nested in state)
      if (group.state) {
        childProps.state = group.state;
      }
    }

    if (group.groupType === 'animation') {
      // Animation groups: create animation group ID and propagate state
      // Use the parent's orientation to build a unique animation group name
      const orient = group.orientation ?? inherited.orientation ?? '';
      const st = group.state ?? inherited.state ?? '';
      childProps.animationGroup = `${inherited.groupId}_${orient}_${st}`.toUpperCase();
      if (group.state) {
        childProps.state = group.state;
      }
    }

    // Propagate orientation from group to children (for state groups that have orientation)
    if (group.orientation && !childProps.orientation) {
      childProps.orientation = group.orientation;
    }

    results.push(...flattenManifest(member, childProps));
  }

  return results;
}
