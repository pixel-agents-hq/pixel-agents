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
  | AgentContextUsage
  | AgentProgress
  | DailyStats
  | AgentSleep
  | AgentTitle
  | AgentKind
  | TasksSnapshot
  | TaskUpdated
  | ReportReady
  | Report
  | AnshBrainState
  | AnshThought
  | AgentTrouble
  | AgentLoop
  | AgentTimeline
  | DailyTokens
  | NoticeBoard
  | AgentLink
  | AgentLimit
  | SubscriptionUsage
  | UsageMeterStatus
  | LayoutLoaded
  | FurnitureAssetsLoaded
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
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | DirectoriesLoaded
  | DirectorySaved
  | DirectoryRejected
  | DirectorySuggestions
  | TerminalAvailability
  | TerminalSessionOpened
  | TerminalSessionClosed
  | AgentDiagnostics
  | PermissionPending
  | PermissionResolved
  | WeekStats
  | Weather
  | TimeReport;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | SetBypassPermissions
  | SetShowHostDirectories
  | SaveDirectory
  | RemoveDirectory
  | RequestDirectorySuggestions
  | RequestDiagnostics
  | RequestTasks
  | RequestReport
  | WriteReportNow
  | SetAnshBrainEnabled
  | AskAnsh
  | RequestTimeline
  | AnswerPermission
  | RequestTimeReport
  | SetUsageMeterEnabled;

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
  hueShift?: number;
  sourceLabel?: string;
  sourceKind?: RemoteSourceKind;
  title?: string;
  background?: boolean;
}

export type RemoteSourceKind = 'computer' | 'cloud';

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
  sourceLabels?: Record<string, string>;
  sourceKinds?: Record<string, RemoteSourceKind>;
  titles?: Record<string, string>;
  backgroundAgents?: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
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

export interface AgentProgress {
  type: 'agentProgress';
  id: number;
  phase?: WorkPhase;
  reached: WorkPhase[];
  waitingSince?: number;
}

export type WorkPhase = 'explore' | 'build' | 'test' | 'ship';

export interface DailyStats {
  type: 'dailyStats';
  date: string;
  prs: DailyPr[];
  pushes: DailyPush[];
  filesEdited: number;
  commandsRun: number;
  activeMs: number;
}

export interface DailyPr {
  title: string;
  repo: string;
  url?: string;
  at: number;
}

export interface DailyPush {
  repo: string;
  count: number;
}

export interface AgentSleep {
  type: 'agentSleep';
  id: number;
  sleeping: boolean;
  idleSince?: number;
}

export interface AgentTitle {
  type: 'agentTitle';
  id: number;
  title: string;
}

export interface AgentKind {
  type: 'agentKind';
  id: number;
  background: boolean;
}

export interface TasksSnapshot {
  type: 'tasksSnapshot';
  date: string;
  tasks: Task[];
}

export interface Task {
  id: string;
  title: string;
  repo: string;
  machine: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  status: TaskStatus;
  prs: DailyPr[];
  pushes: number;
  filesEdited: number;
  commands: number;
  activeMs: number;
}

export type TaskStatus = 'in_progress' | 'waiting' | 'done';

export interface TaskUpdated {
  type: 'taskUpdated';
  task: Task;
}

export interface ReportReady {
  type: 'reportReady';
  date: string;
}

export interface Report {
  type: 'report';
  date: string;
  exists: boolean;
  markdown?: string;
  details?: string;
  generatedAt?: number;
  aiWritten?: boolean;
  notionUrl?: string;
  writing?: boolean;
}

export interface AnshBrainState {
  type: 'anshBrainState';
  enabled: boolean;
  thinking: boolean;
  thoughtsToday: number;
  dailyCap: number;
  thoughts: AnshThoughtEntry[];
}

export interface AnshThoughtEntry {
  at: number;
  action: AnshAction;
  targetId?: number;
  say: string;
  aiWritten: boolean;
}

export type AnshAction = 'visit' | 'chatManager' | 'stretch' | 'stay';

export interface AnshThought {
  type: 'anshThought';
  thought: AnshThoughtEntry;
}

export interface AgentTrouble {
  type: 'agentTrouble';
  id: number;
  level: TroubleLevel;
  failures: number;
}

export type TroubleLevel = 'none' | 'fire' | 'alarm';

export interface AgentLoop {
  type: 'agentLoop';
  id: number;
  looping: boolean;
  reason?: LoopReason;
}

export type LoopReason = 'repeat' | 'stall';

export interface AgentTimeline {
  type: 'agentTimeline';
  id: number;
  entries: TimelineEntry[];
  prs: DailyPr[];
  pushes: number;
  activeMs: number;
}

export interface TimelineEntry {
  at: number;
  kind: TimelineKind;
  text: string;
  failed?: boolean;
}

export type TimelineKind = 'tool' | 'status' | 'ship' | 'pr' | 'push';

export interface DailyTokens {
  type: 'dailyTokens';
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  byModel: Record<string, ModelTokens>;
  estimatedUsd?: number;
  partialEstimate?: boolean;
}

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estimatedUsd?: number;
}

export interface NoticeBoard {
  type: 'noticeBoard';
  items: NoticeItem[];
}

export interface NoticeItem {
  kind: NoticeKind;
  title: string;
  repo: string;
  url: string;
}

export type NoticeKind = 'pr' | 'issue';

export interface AgentLink {
  type: 'agentLink';
  id: number;
  url?: string;
  resumeCommand: string;
}

export interface AgentLimit {
  type: 'agentLimit';
  id: number;
  paused: boolean;
  reason?: LimitReason;
  resetsAt?: number;
}

export type LimitReason = 'session' | 'weekly' | 'usage' | 'rate';

export interface SubscriptionUsage {
  type: 'subscriptionUsage';
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  updatedAt?: number;
}

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface UsageMeterStatus {
  type: 'usageMeterStatus';
  state: UsageMeterState;
}

export type UsageMeterState = 'on' | 'off' | 'foreign' | 'unreadable';

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

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface DirectoriesLoaded {
  type: 'directoriesLoaded';
  directories: Directory[];
}

export interface Directory {
  name: string;
  path: string;
  source: DirectorySource;
}

export type DirectorySource = 'user' | 'host';

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

export interface PermissionPending {
  type: 'permissionPending';
  requestId: string;
  id: number;
  tool: string;
  detail: string;
  since: number;
  questions?: PermissionQuestion[];
}

export interface PermissionQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: PermissionQuestionOption[];
}

export interface PermissionQuestionOption {
  label: string;
  description?: string;
}

export interface PermissionResolved {
  type: 'permissionResolved';
  requestId: string;
  id: number;
  outcome: PermissionOutcome;
}

export type PermissionOutcome = 'allowed' | 'denied' | 'answeredInTerminal' | 'expired';

export interface WeekStats {
  type: 'weekStats';
  days: WeekDay[];
}

export interface WeekDay {
  date: string;
  prs: number;
  pushes: number;
  activeMs: number;
}

export interface Weather {
  type: 'weather';
  condition: WeatherCondition;
  isDay: boolean;
  tempC: number;
  city: string;
}

export type WeatherCondition = 'clear' | 'clouds' | 'rain' | 'snow' | 'fog' | 'storm';

export interface TimeReport {
  type: 'timeReport';
  from: string;
  to: string;
  rows: TimeReportRow[];
  unattributed: TimeReportUnattributed[];
}

export interface TimeReportRow {
  date: string;
  repo: string;
  activeMs: number;
  tasks: number;
  prs: number;
  pushes: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  estimatedUsd?: number;
  partialEstimate?: boolean;
}

export interface TimeReportUnattributed {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  estimatedUsd?: number;
  partialEstimate?: boolean;
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  directoryPath?: string;
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
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
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
}

export interface RemoveDirectory {
  type: 'removeDirectory';
  path: string;
}

export interface RequestDirectorySuggestions {
  type: 'requestDirectorySuggestions';
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface RequestTasks {
  type: 'requestTasks';
  date: string;
}

export interface RequestReport {
  type: 'requestReport';
  date: string;
}

export interface WriteReportNow {
  type: 'writeReportNow';
}

export interface SetAnshBrainEnabled {
  type: 'setAnshBrainEnabled';
  enabled: boolean;
}

export interface AskAnsh {
  type: 'askAnsh';
}

export interface RequestTimeline {
  type: 'requestTimeline';
  id: number;
}

export interface AnswerPermission {
  type: 'answerPermission';
  requestId: string;
  behavior: PermissionBehavior;
  answers?: PermissionAnswer[];
}

export type PermissionBehavior = 'allow' | 'deny';

export interface PermissionAnswer {
  options: number[];
  other?: string;
}

export interface RequestTimeReport {
  type: 'requestTimeReport';
  from: string;
  to: string;
}

export interface SetUsageMeterEnabled {
  type: 'setUsageMeterEnabled';
  enabled: boolean;
}
