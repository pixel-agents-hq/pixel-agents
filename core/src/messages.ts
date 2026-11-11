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
  | AgentWorktreeChanged
  | AgentContextUsage
  | AgentVisit
  | AgentMessageShow
  | LayoutLoaded
  | AgentLayoutEditStatus
  | AgentCharacterEditStatus
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
  | OfficeMcpConsentRequest
  | OfficeMcpStatus
  | TutorialStatus
  | TutorialRejected
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
  | ConversationSearchResults
  | WorktreeRejected
  | WorktreeOptions
  | WorktreeDecisionRejected
  | AgentCloseQuestion
  | WorktreesLoaded
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
  | LayoutEditing
  | UndoAgentLayoutEdit
  | SaveCharacterProfiles
  | CharactersEditing
  | UndoAgentCharacterEdit
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetUsageBridgeEnabled
  | OfficeMcpConsentResponse
  | SetOfficeMcpEnabled
  | SetOfficeMcpReadOnly
  | StartTutorial
  | SkipTutorialQuest
  | QuitTutorial
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
  | SetUploadDirectory
  | SaveDirectory
  | RemoveDirectory
  | RequestDirectorySuggestions
  | RequestConversations
  | SearchConversations
  | ResumeConversation
  | RequestWorktrees
  | RequestWorktreeOptions
  | DecideWorktree
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
  palette?: number;
  repeat?: number;
  seatId?: string;
  worktree?: AgentWorktree;
  nickname?: string;
}

export interface AgentWorktree {
  name: string;
  branch: string;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  directoryNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
  worktrees?: Record<string, AgentWorktree>;
  nicknames?: Record<string, string>;
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

export interface AgentWorktreeChanged {
  type: 'agentWorktreeChanged';
  id: number;
  worktree?: AgentWorktree;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface AgentVisit {
  type: 'agentVisit';
  id: number;
  to?: TilePosition;
  facing?: Facing;
  stay?: boolean;
  cleared?: boolean;
}

export interface TilePosition {
  col: number;
  row: number;
}

export type Facing = 'up' | 'down' | 'left' | 'right';

export interface AgentMessageShow {
  type: 'agentMessageShow';
  fromId: number;
  toIds: number[];
  gist: string;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
  buildout?: LayoutBuildout;
  shift?: GridShift;
}

export interface LayoutBuildout {
  agentId: number;
  origin: TilePosition;
}

export interface GridShift {
  col: number;
  row: number;
}

export interface AgentLayoutEditStatus {
  type: 'agentLayoutEditStatus';
  agentId?: number;
  agentName?: string;
  refused?: string;
}

export interface AgentCharacterEditStatus {
  type: 'agentCharacterEditStatus';
  agentId?: number;
  agentName?: string;
  summary?: string;
  landed?: boolean;
  refused?: string;
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
  interactive?: FurnitureInteractive;
}

export interface FurnitureInteractive {
  agentUse?: FurnitureAgentUse;
  label?: FurnitureLabelSpec;
  panel?: FurniturePanel;
  states?: FurnitureStateRule[];
}

export type FurnitureAgentUse = 'workstation';

export interface FurnitureLabelSpec {
  name: string;
  lines?: FurnitureLabelLine[];
}

export interface FurnitureLabelLine {
  when: FurnitureCondition[];
  text: string;
}

export type FurnitureCondition = 'agentWorking' | 'panelInUse' | 'free';

export type FurniturePanel = 'terminal';

export interface FurnitureStateRule {
  state: string;
  when: FurnitureCondition[];
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
  externalAssetDirectories: string[];
  showAreas: boolean;
  bypassPermissions: boolean;
  showHostDirectories: boolean;
  uploadDirectory?: string;
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
  summary: string;
  cliInstalled: boolean;
  disclosure: string;
}

export interface OfficeMcpConsentRequest {
  type: 'officeMcpConsentRequest';
  headline: string;
  summary: string;
  disclosure: string;
}

export interface OfficeMcpStatus {
  type: 'officeMcpStatus';
  consent: OfficeMcpConsentState;
  readOnly: boolean;
  headline: string;
  disclosure: string;
}

export type OfficeMcpConsentState = 'unanswered' | 'granted' | 'declined';

export interface TutorialStatus {
  type: 'tutorialStatus';
  available: boolean;
  unavailableReason?: string;
  headline: string;
  disclosure: string;
  run?: TutorialRun;
}

export interface TutorialRun {
  agentId: number;
  quests: TutorialQuestProgress[];
  finished: boolean;
}

export interface TutorialQuestProgress {
  id: string;
  state: TutorialQuestState;
}

export type TutorialQuestState = 'open' | 'done' | 'skipped';

export interface TutorialRejected {
  type: 'tutorialRejected';
  reason: string;
}

export interface UsageBridgeStatus {
  type: 'usageBridgeStatus';
  providerId: string;
  providerName: string;
  installed: boolean;
  summary: string;
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
  isRepo: boolean;
  hasOrigin?: boolean;
  worktreeBase?: WorktreeBase;
  worktreeBranchPrefix?: string;
  characters?: number[];
  characterOrder?: DirectoryCharacterOrder;
}

export type DirectorySource = 'user' | 'host';

export type WorktreeBase = 'head' | 'fresh';

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
  more?: boolean;
}

export interface Conversation {
  sessionId: string;
  title: string;
  updatedAt: number;
  palette?: number;
  repeat?: number;
  agentId?: number;
  worktree?: AgentWorktree;
}

export interface ConversationSearchResults {
  type: 'conversationSearchResults';
  query: string;
  directoryPath?: string;
  limit: number;
  results: FoundConversation[];
  more: boolean;
}

export interface FoundConversation {
  directoryPath: string;
  directoryName: string;
  conversation: Conversation;
}

export interface WorktreeRejected {
  type: 'worktreeRejected';
  directoryPath: string;
  reason: string;
}

export interface WorktreeOptions {
  type: 'worktreeOptions';
  directoryPath: string;
  name: string;
  prefix: string;
  branches: WorktreeBranch[];
  defaultBase?: WorktreeBranch;
}

export interface WorktreeBranch {
  name: string;
  location: WorktreeBranchLocation;
  current?: boolean;
}

export type WorktreeBranchLocation = 'local' | 'origin';

export interface WorktreeDecisionRejected {
  type: 'worktreeDecisionRejected';
  directoryPath: string;
  name: string;
  reason: string;
}

export interface AgentCloseQuestion {
  type: 'agentCloseQuestion';
  id: number;
  directoryPath: string;
  name: string;
  branch: string;
  uncommittedFiles: number;
}

export interface WorktreesLoaded {
  type: 'worktreesLoaded';
  directoryPath: string;
  worktrees: WorktreeSummary[];
  cliName?: string;
}

export interface WorktreeSummary {
  name: string;
  branch: string;
  owner: WorktreeOwner;
  latestSessionId?: string;
  state: WorktreeState;
  sizeBytes: number;
  uncommittedFiles: number;
  uniqueCommits: number;
  agentId?: number;
  palette?: number;
  repeat?: number;
}

export type WorktreeOwner = 'pixelAgents' | 'cli';

export type WorktreeState = 'active' | 'kept' | 'parked' | 'needsDecision';

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
  worktree?: boolean;
  worktreeName?: string;
  worktreeFrom?: WorktreeBranch;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
  worktreeChoice?: WorktreeLeaveChoice;
  confirmedFiles?: number;
}

export type WorktreeLeaveChoice = 'save' | 'keep' | 'discard';

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

export interface LayoutEditing {
  type: 'layoutEditing';
  dirty: boolean;
}

export interface UndoAgentLayoutEdit {
  type: 'undoAgentLayoutEdit';
}

export interface SaveCharacterProfiles {
  type: 'saveCharacterProfiles';
  profiles: CharacterProfile[];
  saveId: string;
  items?: WardrobeItem[];
}

export interface CharactersEditing {
  type: 'charactersEditing';
  dirty: boolean;
}

export interface UndoAgentCharacterEdit {
  type: 'undoAgentCharacterEdit';
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

export interface OfficeMcpConsentResponse {
  type: 'officeMcpConsentResponse';
  choice: OfficeMcpChoice;
}

export type OfficeMcpChoice = 'allow' | 'notNow' | 'decline';

export interface SetOfficeMcpEnabled {
  type: 'setOfficeMcpEnabled';
  enabled: boolean;
}

export interface SetOfficeMcpReadOnly {
  type: 'setOfficeMcpReadOnly';
  readOnly: boolean;
}

export interface StartTutorial {
  type: 'startTutorial';
  palette?: number;
  seatId?: string;
}

export interface SkipTutorialQuest {
  type: 'skipTutorialQuest';
  questId: string;
}

export interface QuitTutorial {
  type: 'quitTutorial';
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

export interface SetUploadDirectory {
  type: 'setUploadDirectory';
  path: string;
}

export interface SaveDirectory {
  type: 'saveDirectory';
  name: string;
  path: string;
  previousPath?: string;
  characters?: number[];
  characterOrder?: DirectoryCharacterOrder;
  worktreeBase?: WorktreeBase;
  worktreeBranchPrefix?: string;
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
  limits?: ConversationLimit[];
}

export interface ConversationLimit {
  directoryPath: string;
  count: number;
}

export interface SearchConversations {
  type: 'searchConversations';
  query: string;
  directoryPath?: string;
  limit: number;
}

export interface ResumeConversation {
  type: 'resumeConversation';
  sessionId: string;
  directoryPath: string;
}

export interface RequestWorktrees {
  type: 'requestWorktrees';
  directoryPath: string;
}

export interface RequestWorktreeOptions {
  type: 'requestWorktreeOptions';
  directoryPath: string;
}

export interface DecideWorktree {
  type: 'decideWorktree';
  directoryPath: string;
  name: string;
  choice: WorktreeChoice;
  confirmedFiles?: number;
  confirmedCommits?: number;
}

export type WorktreeChoice = 'save' | 'keep' | 'discard' | 'remove' | 'deleteBranch';

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}
