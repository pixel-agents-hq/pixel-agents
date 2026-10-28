/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | AgentDeselected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterProfilesLoaded
  | RecentCharactersLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | OfficeAccess
  | SettingsLoaded
  | BypassPermissionsUpdated
  | HooksStatus
  | HooksConsentRequest
  | UsageBridgeStatus
  | UsageLimits
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | CardOrderLoaded
  | DirectoriesLoaded
  | DirectorySaved
  | DirectoryRejected
  | DirectorySuggestions
  | ConversationsLoaded
  | TerminalAvailability
  | TerminalSessionOpened
  | TerminalSessionClosed
  | AgentDiagnostics;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SaveCharacterProfiles
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetUsageBridgeEnabled
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | ExportFile
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SaveCardOrder
  | SetShowAreas
  | SetBypassPermissions
  | SetShowHostDirectories
  | SaveDirectory
  | RemoveDirectory
  | RequestDirectorySuggestions
  | RequestConversations
  | ResumeConversation
  | RequestDiagnostics;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  directoryName?: string;
  isExternal?: boolean;
  isHeadless?: boolean;
  palette?: number;
  repeat?: number;
  seatId?: string;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface AgentDeselected {
  type: 'agentDeselected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  directoryNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
  headlessAgents?: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  repeat?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
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

export interface CharacterProfilesLoaded {
  type: 'characterProfilesLoaded';
  profiles: CharacterProfile[];
  agentLooks?: AgentLook[];
  saveId?: string;
  items?: WardrobeItem[];
}

export interface CharacterProfile {
  id?: string;
  name?: string;
  body: string;
  eyeShape?: string;
  eyeRows?: string;
  utop?: string;
  under?: string;
  hair?: string;
  beard?: string;
  top?: string;
  jacket?: string;
  pants?: string;
  shoes?: string;
  full?: string;
  hat?: string;
  necklace?: string;
  lanyard?: string;
  earrings?: string;
  shades?: string;
  hairshades?: string;
  watch?: string;
  colors?: Record<string, CharacterColor>;
  edits?: Record<string, CharacterPixelEdits>;
  v?: number;
}

export interface CharacterColor {
  h: number;
  s: number;
  b: number;
  c: number;
  colorize?: boolean;
  palette?: string;
}

export interface CharacterPixelEdits {
  cells: Record<string, Record<string, string | null>>;
}

export interface AgentLook {
  id: number;
  palette: number;
  repeat: number;
}

export interface WardrobeItem {
  id: string;
  piece: string;
  label: string;
  base: string;
  png: string;
}

export interface RecentCharactersLoaded {
  type: 'recentCharactersLoaded';
  recent: number[];
}

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface OfficeAccess {
  type: 'officeAccess';
  readOnly: boolean;
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
  bypassPermissions: boolean;
  showHostDirectories: boolean;
}

export interface BypassPermissionsUpdated {
  type: 'bypassPermissionsUpdated';
  enabled: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface UsageBridgeStatus {
  type: 'usageBridgeStatus';
  providerId: string;
  installed: boolean;
  disclosure: string;
  error?: string;
}

export interface UsageLimits {
  type: 'usageLimits';
  providerId: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  updatedAt?: number;
}

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface CardOrderLoaded {
  type: 'cardOrderLoaded';
  order: number[];
}

export interface DirectoriesLoaded {
  type: 'directoriesLoaded';
  directories: Directory[];
}

export interface Directory {
  name: string;
  path: string;
  source: DirectorySource;
  characters?: number[];
  characterOrder?: DirectoryCharacterOrder;
}

export type DirectorySource = 'user' | 'host';

export type DirectoryCharacterOrder = 'priority' | 'random';

export interface DirectorySaved {
  type: 'directorySaved';
  directory: Directory;
}

export interface DirectoryRejected {
  type: 'directoryRejected';
  path: string;
  reason: string;
}

export interface DirectorySuggestions {
  type: 'directorySuggestions';
  paths: string[];
}

export interface ConversationsLoaded {
  type: 'conversationsLoaded';
  directories: DirectoryConversations[];
}

export interface DirectoryConversations {
  name: string;
  path: string;
  conversations: Conversation[];
}

export interface Conversation {
  sessionId: string;
  title: string;
  updatedAt: number;
  palette?: number;
  repeat?: number;
  agentId?: number;
}

export interface TerminalAvailability {
  type: 'terminalAvailability';
  available: boolean;
  reason?: string;
}

export interface TerminalSessionOpened {
  type: 'terminalSessionOpened';
  agentId: number;
}

export interface TerminalSessionClosed {
  type: 'terminalSessionClosed';
  agentId: number;
  exitCode?: number;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  directoryPath?: string;
  palette?: number;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  repeat: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SaveCharacterProfiles {
  type: 'saveCharacterProfiles';
  profiles: CharacterProfile[];
  saveId: string;
  items?: WardrobeItem[];
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetUsageBridgeEnabled {
  type: 'setUsageBridgeEnabled';
  providerId: string;
  enabled: boolean;
}

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface ExportFile {
  type: 'exportFile';
  filename: string;
  dataBase64: string;
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SaveCardOrder {
  type: 'saveCardOrder';
  order: number[];
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface SetBypassPermissions {
  type: 'setBypassPermissions';
  enabled: boolean;
}

export interface SetShowHostDirectories {
  type: 'setShowHostDirectories';
  enabled: boolean;
}

export interface SaveDirectory {
  type: 'saveDirectory';
  name: string;
  path: string;
  previousPath?: string;
  characters?: number[];
  characterOrder?: DirectoryCharacterOrder;
}

export interface RemoveDirectory {
  type: 'removeDirectory';
  path: string;
}

export interface RequestDirectorySuggestions {
  type: 'requestDirectorySuggestions';
}

export interface RequestConversations {
  type: 'requestConversations';
}

export interface ResumeConversation {
  type: 'resumeConversation';
  sessionId: string;
  directoryPath: string;
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}
