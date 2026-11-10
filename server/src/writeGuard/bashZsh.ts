/**
 * zsh 專屬的執行型展開偵測（P3，第二次驗證：Claude Code 的 Bash 工具可能以使用者的 zsh
 * 執行；尚未直接實測）。偵測到時整個指令視為無法解析（edit、delete，寫入目標無法判斷）。
 *
 * - glob qualifier 執行程式碼：`*(e:'cmd':)`、`*(.e'cmd')`、`*(#qe:...:)`、`*(+func)`；
 * - 參數展開旗標：`${(e)x}`（再展開、可執行命令替換）、`${(P)x}`（間接）、`${(Q)x}` 等。
 * 刻意對原始字串整體比對，引號內的相同文字也算（寧可誤拒絕：要區分 zsh 的引號規則與
 * 程式碼字串中的同樣文字並不可靠）。
 */

/** 樣式中可出現在 `e` 之前的其他 qualifier 字元（zsh 的 qualifier 集合，不含引號與斜線）。 */
const GLOB_QUALIFIER_EXEC = /\((?:#q)?[./@=*%rwxRWXAIEsStfdDlLUGNnMoOamcFTY^,0-9-]*e[:'"]/;
const GLOB_QUALIFIER_FUNC = /\(\+[A-Za-z_]/;
const PARAM_FLAGS = /\$\{\([^)]*[ePQ][^)]*\)/;

export function hasZshExecExpansion(command: string): boolean {
  return (
    GLOB_QUALIFIER_EXEC.test(command) ||
    GLOB_QUALIFIER_FUNC.test(command) ||
    PARAM_FLAGS.test(command)
  );
}
