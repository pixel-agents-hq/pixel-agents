/**
 * Org-chart profiles for agents: name, role, and department.
 *
 * - The user's own main session (the primary detected Claude session) is the
 *   "boss": Sakura / 社長（CEO / Claude 4.7） / 役員室.
 * - Spawned teammates / sub-sessions are randomly assigned to one of the six
 *   company departments, each with its own model and duties.
 */

/** Profile fields attached to an agent (all optional on AgentState). */
export interface AgentProfile {
  /** Display name of the persona (e.g. "Sakura"). */
  name?: string;
  /** Role within the org, incl. model (e.g. "社長（CEO / Claude 4.7）", "開発担当 (Sonnet 4.6)"). */
  role?: string;
  /** Department + duties (e.g. "エンジニアリング部（コード設計・実装・デバッグ）"). */
  department?: string;
  /**
   * Base character sprite index (0-5, matching char_0.png..char_5.png). When
   * set, the webview uses this fixed sprite instead of an auto-assigned one.
   */
  palette?: number;
  /** Hue rotation in degrees applied to the sprite (e.g. 320 ≈ pink). */
  hueShift?: number;
}

/**
 * Default profile for the user's own main session (the boss).
 *
 * Appearance: char_3 is the long-haired, light-toned base sprite; a hue shift
 * of 320° tints the hair pink while skin tones are preserved (see adjustSprite
 * `preserveSkin`) — a pink long-haired, fair-skinned "president" look.
 */
export const MAIN_SESSION_PROFILE: Readonly<Required<AgentProfile>> = {
  name: 'Sakura',
  role: '社長（CEO / Claude 4.7）',
  department: '役員室',
  palette: 3,
  hueShift: 320,
};

/** One department in the company org chart. */
export interface DepartmentDef {
  /** Department name (e.g. "エンジニアリング部"). */
  name: string;
  /** Claude model the department's agents run on. */
  model: string;
  /** Short role/title label for members (incl. model). */
  role: string;
  /** Duties / area of responsibility. */
  duties: string;
}

/**
 * The six company departments a teammate / sub-session can be assigned to.
 * Add or edit departments here to update the org chart.
 */
export const ORG_DEPARTMENTS: readonly DepartmentDef[] = [
  {
    name: 'エンジニアリング部',
    model: 'Sonnet 4.6',
    role: '開発担当 (Sonnet 4.6)',
    duties: 'コード設計・実装・デバッグ',
  },
  {
    name: 'マーケティング部',
    model: 'Sonnet 4.6',
    role: 'マーケ担当 (Sonnet 4.6)',
    duties: '戦略・コピーライティング・SNS',
  },
  {
    name: 'デザイン部',
    model: 'Sonnet 4.6',
    role: 'デザイン担当 (Sonnet 4.6)',
    duties: 'UI/UX・ブランディング・ビジュアル',
  },
  {
    name: 'リサーチ部',
    model: 'Sonnet 4.6',
    role: 'リサーチ担当 (Sonnet 4.6)',
    duties: '市場調査・競合分析・トレンド',
  },
  {
    name: '人事部',
    model: 'Haiku 4.5',
    role: '人事担当 (Haiku 4.5)',
    duties: '採用・組織設計・人材育成',
  },
  {
    name: '財務部',
    model: 'Haiku 4.5',
    role: '財務担当 (Haiku 4.5)',
    duties: '予算・コスト分析・財務戦略',
  },
];

/** Pick a department at random for a newly spawned teammate / sub-session. */
export function pickRandomDepartment(): DepartmentDef {
  const index = Math.floor(Math.random() * ORG_DEPARTMENTS.length);
  return ORG_DEPARTMENTS[index];
}

/** Profile applied to the user's main session (the boss). */
export function mainSessionProfile(): Required<AgentProfile> {
  return { ...MAIN_SESSION_PROFILE };
}

/**
 * Profile applied to a spawned teammate / sub-session: a random department with
 * its role (incl. model) and a department-plus-duties label. Optionally carries
 * the teammate's name.
 */
export function teammateProfile(name?: string): AgentProfile {
  const dept = pickRandomDepartment();
  return {
    name,
    role: dept.role,
    department: `${dept.name}（${dept.duties}）`,
  };
}
