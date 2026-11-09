/**
 * Bash 解析（P3，F10）的共用型別。解析是純函式：不碰檔案系統、不讀環境變數，
 * hook 端與伺服器端共用同一份程式；路徑正規化交給 PathNormalizer（bashPaths.ts）。
 */

/** 一個 shell word（引號已去除；變數、glob 等展開不做，保留字面）。 */
export interface BashWord {
  /** 去除引號與跳脫後的值；`$x`、`*` 等展開照字面保留。 */
  text: string;
  /** 任一部分在引號內或被反斜線跳脫。 */
  quoted: boolean;
  /** 含未解析的展開（變數、命令替換、glob、`~user`）：值在執行期才知道。 */
  expansion: boolean;
  /** 以未加引號的 `~` 開頭，且其後是 `/` 或 word 結尾（目前使用者的 HOME）。 */
  tilde: boolean;
  /** `NAME=value` 形式（只在指令開頭時才是變數指定）。 */
  assignment: boolean;
  /** `~+`（目前目錄）、`~-`／`~N`（目錄堆疊）、`~user`（其他使用者的 HOME）。 */
  tildeKind?: 'plus' | 'minus' | 'user';
  /** 值無法確定（`$'...'` 解碼失敗等）：作為寫入目標或字面路徑時視為無法判斷。 */
  unresolved?: boolean;
  /** `$( )`、反引號、`<( )`、`>( )` 內的指令（已斷詞，由 parser 遞迴解析）。 */
  substitutions: BashToken[][];
}

export type BashOperator = ';' | '&&' | '||' | '|' | '&' | '(' | ')';

/**
 * 重導向種類。write、readWrite、read、dupOrWrite、dupOrRead 的目標是下一個 word；
 * heredoc 的分隔字由 lexer 自己讀掉（不會出現在 token 流），本文中的命令替換放在
 * heredocSubstitutions；herestring 的 word 只是資料。
 */
export type RedirectKind =
  'write' | 'readWrite' | 'read' | 'dupOrWrite' | 'dupOrRead' | 'heredoc' | 'herestring';

export type BashToken =
  | { kind: 'word'; word: BashWord }
  | { kind: 'op'; op: BashOperator }
  | {
      kind: 'redirect';
      redirect: RedirectKind;
      heredocSubstitutions?: BashToken[][];
      /** heredoc 本文（資料；承接的指令不是讀取類時掃描其中的字面路徑）。 */
      heredocBody?: string;
    };

export interface LexResult {
  tokens: BashToken[];
  /** 停止的位置（paren 模式下是對應 `)` 的位置）。 */
  end: number;
  /** 巢狀層數超過上限，或結構無法配對（case 沒有 esac）：無法解析。 */
  nestingExceeded: boolean;
}

/** 一個簡單指令：argv（不含前置變數指定）、重導向、可能的工作目錄。 */
export interface SimpleCommand {
  words: BashWord[];
  /** 指令前的變數指定（`A=1 cmd`）；GIT_WORK_TREE 等會影響路徑起點。 */
  assignments: BashWord[];
  /** target：重導向目標或 herestring 的資料 word；body：heredoc 本文。 */
  redirects: { kind: RedirectKind; target?: BashWord; body?: string }[];
  /** 執行時可能的工作目錄：每條是同一指令字串內先前 `cd` 的參數序列（相對於起始目錄）。 */
  dirs: BashWord[][];
  /** 到這個指令為止出現過的所有工作目錄候選（`~-` 用；含起始目錄）。 */
  allDirs: BashWord[][];
}

export interface ParsedScript {
  commands: SimpleCommand[];
  /** 巢狀（命令替換、子殼層、所有遞迴結構）超過上限，或結構無法配對：無法解析。 */
  nestingExceeded: boolean;
  /** 可能工作目錄的組合數超過上限（部分組合被丟掉）。 */
  dirsTruncated: boolean;
}

/** 操作類別（P3 補充決定 1）。 */
export type GuardOperation = 'read' | 'edit' | 'delete';

/** 一段路徑：依序接起來（絕對路徑重設起點；tilde 為目前使用者的 HOME）。 */
export interface PathSegment {
  text: string;
  tilde: boolean;
  /** 來自 `~+`、`~-`、`~user` 開頭的 word（bashAnalysis.underDirs 依此展開或標記無法判斷）。 */
  kind?: 'plus' | 'minus' | 'user';
  /** 來自值無法確定的 word。 */
  unresolved?: boolean;
}

/**
 * 寫入目標。direct：路徑本身被寫入（落在受保護區內就算命中）。
 * recursive：遞迴刪除、移走或覆寫整棵樹（路徑落在受保護區內，或受保護區落在路徑之下，都算命中）。
 */
export interface BashTarget {
  segments: PathSegment[];
  mode: 'direct' | 'recursive';
}

export interface BashAnalysis {
  /** 這個指令字串需要的操作類別（聯集，依 read、edit、delete 排序）。 */
  ops: GuardOperation[];
  /** 每個操作類別第一次出現時的指令名稱（拒絕訊息用，只含該 Agent 自己的指令片段）。 */
  opSources: Partial<Record<GuardOperation, string>>;
  /** 寫入類與刪除類指令的路徑參數、重導向目標。 */
  targets: BashTarget[];
  /** 直譯器與無法分類指令中，字面出現的路徑片段（P3 補充決定 4；一律 direct）。 */
  mentions: BashTarget[];
  /** 非讀取類指令的解碼後文字（參數、重導向目標、heredoc 本文、herestring），供「子字串
   *  包含受保護區根目錄」的掃描（bashLiteralScan.ts，第二次驗證 P2-4）。 */
  literalTexts: string[];
  /** 目標、片段或工作目錄組合超過上限，或巢狀超過上限：路徑無法完整判斷。 */
  truncated: boolean;
  /** 巢狀超過上限：其後的指令沒有被分類（操作類別另外加上 edit 與 delete）。 */
  nestingExceeded: boolean;
}
