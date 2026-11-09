/**
 * 裁決端點的標頭層檢查（縱深防禦，沿用 S3b /mcp 的作法）。
 *
 * 只有本機的 hook 腳本會呼叫這個端點，它從不帶 Origin、從不經過代理、
 * 一律連 127.0.0.1。因此在認證之前先拒絕（403）：任何 Origin（瀏覽器頁面）、
 * 任何轉送標頭（Forwarded、Via、X-Forwarded-*）、Host 不是恰好一個 loopback、
 * 對端位址不是 loopback。認證（401）只看 Authorization 標頭，且必須恰好一個。
 *
 * 只讀原始標頭清單（rawHeaders）：Node 對重複的 Host、Authorization 只保留第一個，
 * 重複值不能被藏起來。
 */

import {
  WRITE_GUARD_FORWARDING_HEADER_PREFIX,
  WRITE_GUARD_FORWARDING_HEADERS,
  WRITE_GUARD_LOOPBACK_PEERS,
} from '../constants.js';
import { bearerTokenValid, isLoopbackHost } from '../wsAuth.js';

function headerNames(rawHeaders: readonly string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) names.push(rawHeaders[i].toLowerCase());
  return names;
}

function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) values.push(rawHeaders[i + 1]);
  }
  return values;
}

/** 認證之前就拒絕（403）的請求。 */
export function guardRequestForbidden(request: {
  rawHeaders: readonly string[];
  remoteAddress: string | undefined;
}): boolean {
  const names = headerNames(request.rawHeaders);
  if (names.includes('origin')) return true;
  if (
    names.some(
      (name) =>
        WRITE_GUARD_FORWARDING_HEADERS.includes(name) ||
        name.startsWith(WRITE_GUARD_FORWARDING_HEADER_PREFIX),
    )
  ) {
    return true;
  }
  const hosts = headerValues(request.rawHeaders, 'host');
  if (hosts.length !== 1 || !isLoopbackHost(hosts[0])) return true;
  return !WRITE_GUARD_LOOPBACK_PEERS.includes(request.remoteAddress ?? '');
}

/** 恰好一個 Authorization 標頭，且是本伺服器的 Bearer token。 */
export function guardRequestAuthorized(rawHeaders: readonly string[], token: string): boolean {
  const values = headerValues(rawHeaders, 'authorization');
  return values.length === 1 && bearerTokenValid(values[0], token);
}
