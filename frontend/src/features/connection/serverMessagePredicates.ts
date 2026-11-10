import type { ServerMessage } from '../../protocol';
import { serverMessageReceived } from './actions';

/** 給 saga 的 take 用：只接住指定類型的伺服器訊息。 */
export function isServerMessageOfType(type: ServerMessage['type']) {
  return (action: { type: string }) =>
    serverMessageReceived.match(action) && action.payload.type === type;
}
