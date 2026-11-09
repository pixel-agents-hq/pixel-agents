/**
 * `$'...'`（ANSI-C 引號）的解碼（P3，第二次驗證 P2-2）。純函式、線性時間（不切子字串）。
 *
 * 支援 bash／zsh 的跳脫：\a \b \e \E \f \n \r \t \v \\ \' \" \?、八進位 \NNN（1 到 3 位）、
 * \xHH（1 到 2 位）、\uHHHH（1 到 4 位）、\UHHHHHHHH（1 到 8 位）、\cX（控制字元）。
 * 其他 `\X` 照 bash 保留反斜線與字元。無法解碼（\u／\U／\x 後面沒有十六進位數字、
 * 非法的 Unicode 碼位、\c 後沒有字元、引號沒有結束）時標記 unresolved：值無法確定，
 * 呼叫端視為寫入目標無法判斷（寧可保守）。
 */

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: '\u0007',
  b: '\b',
  e: '\u001b',
  E: '\u001b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

const HEX_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

function isHex(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9A-Fa-f]$/.test(ch);
}

/** 讀最多 max 個符合 test 的字元（從 at 開始），回傳數值與長度。 */
function readDigits(
  src: string,
  at: number,
  max: number,
  radix: number,
  test: (c?: string) => boolean,
) {
  let value = 0;
  let length = 0;
  while (length < max && test(src[at + length])) {
    value = value * radix + parseInt(src[at + length], radix);
    length++;
  }
  return { value, length };
}

function isValidCodePoint(value: number): boolean {
  return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff);
}

/** i 指向 `$'` 的 `$`。回傳解碼後的文字、結束位置與是否無法確定。 */
export function decodeAnsiC(
  src: string,
  i: number,
): { text: string; end: number; unresolved: boolean } {
  let j = i + 2;
  let text = '';
  let unresolved = false;
  while (j < src.length && src[j] !== "'") {
    if (src[j] !== '\\') {
      text += src[j++];
      continue;
    }
    const next = src[j + 1];
    if (next === undefined) {
      unresolved = true;
      j++;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, next)) {
      text += SIMPLE_ESCAPES[next];
      j += 2;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(HEX_DIGITS, next)) {
      const { value, length } = readDigits(src, j + 2, HEX_DIGITS[next], 16, isHex);
      if (length === 0 || !isValidCodePoint(value)) unresolved = true;
      else text += String.fromCodePoint(value);
      j += 2 + length;
      continue;
    }
    if (next >= '0' && next <= '7') {
      const { value, length } = readDigits(
        src,
        j + 1,
        3,
        8,
        (c) => c !== undefined && c >= '0' && c <= '7',
      );
      text += String.fromCharCode(value & 0xff);
      j += 1 + length;
      continue;
    }
    if (next === 'c') {
      const control = src[j + 2];
      if (control === undefined || control === "'") {
        unresolved = true;
        j += 2;
        continue;
      }
      text += String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f);
      j += 3;
      continue;
    }
    // bash 保留未知跳脫的反斜線。
    text += `\\${next}`;
    j += 2;
  }
  if (j >= src.length) unresolved = true;
  return { text, end: Math.min(j + 1, src.length), unresolved };
}
