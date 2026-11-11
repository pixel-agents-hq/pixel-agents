import { createAction } from '@reduxjs/toolkit';
import { delay, put, race, select, take, takeEvery } from 'redux-saga/effects';

import type { RootState } from '../../app/store';
import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { DEFAULT_WORKSPACE_ID } from '../../protocol';
import type { Agent } from '../agents/agentsSlice';
import { clientMessageRequested, serverMessageReceived } from '../connection/actions';
import { isServerMessageOfType } from '../connection/serverMessagePredicates';
import { curatorChangeSettled, curatorChangeStarted } from './workspacesSlice';

export type CuratorAction = 'set' | 'unset' | 'swap';

export const curatorChangeRequested = createAction<{
  /** 沒有歸屬的 agent 以 Default 送出；undefined 會被伺服器視為 invalid */
  workspaceId: string | undefined;
  agentId: number;
}>('workspaces/curatorChangeRequested');

/** 已停止、外部接入、或不是由本主機啟動的 Agent 不能擔任 KB Writer。 */
export function canBeCurator(agent: Agent): boolean {
  return (
    !agent.stopped && !agent.isExternal && !agent.guard?.reasons.includes('not_standalone_agent')
  );
}

export function curatorActionFor(curatorId: number | undefined, agentId: number): CuratorAction {
  if (curatorId === undefined) return 'set';
  return curatorId === agentId ? 'unset' : 'swap';
}

type ReceivedAction = ReturnType<typeof serverMessageReceived>;

function isCuratorChanged(workspaceId: string, agentId: 'any' | null) {
  return (action: { type: string }) => {
    if (!serverMessageReceived.match(action)) return false;
    const message = action.payload;
    return (
      message.type === 'workspaceCuratorChanged' &&
      message.workspaceId === workspaceId &&
      (agentId === 'any' || message.agentId === null)
    );
  };
}

/** 等伺服器的回覆；成功才回 true，被拒絕或逾時都是 false，不假設成功。 */
function* awaitChange(workspaceId: string, agentId: 'any' | null) {
  const { changed }: { changed?: ReceivedAction } = yield race({
    changed: take(isCuratorChanged(workspaceId, agentId)),
    rejected: take(isServerMessageOfType('curatorRejected')),
    timeout: delay(LAUNCH_TIMEOUT_MS),
  });
  return changed !== undefined;
}

function* handleChange({ payload }: ReturnType<typeof curatorChangeRequested>) {
  const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const curatorId: number | undefined = yield select(
    (state: RootState) => state.workspaces.curators[workspaceId],
  );
  const action = curatorActionFor(curatorId, payload.agentId);

  yield put(curatorChangeStarted(workspaceId));
  try {
    if (action !== 'set') {
      yield put(clientMessageRequested({ type: 'unsetWorkspaceCurator', workspaceId }));
      const released: boolean = yield* awaitChange(workspaceId, null);
      if (!released || action === 'unset') return;
    }
    yield put(
      clientMessageRequested({
        type: 'setWorkspaceCurator',
        workspaceId,
        agentId: payload.agentId,
      }),
    );
    yield* awaitChange(workspaceId, 'any');
  } finally {
    yield put(curatorChangeSettled(workspaceId));
  }
}

export const curatorBindingRevokeRequested = createAction<string>(
  'workspaces/curatorBindingRevokeRequested',
);

function isCuratorSettledFor(workspaceId: string) {
  return (action: { type: string }) => {
    if (!serverMessageReceived.match(action)) return false;
    const message = action.payload;
    return (
      (message.type === 'workspaceCuratorChanged' || message.type === 'curatorBindingChanged') &&
      message.workspaceId === workspaceId
    );
  };
}

/** 職缺時的撤銷綁定：送出 unset，直到該工作空間的廣播、拒絕或逾時才釋放 pending。 */
function* handleRevoke({ payload: workspaceId }: ReturnType<typeof curatorBindingRevokeRequested>) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return;

  yield put(curatorChangeStarted(workspaceId));
  try {
    yield put(clientMessageRequested({ type: 'unsetWorkspaceCurator', workspaceId }));
    yield race({
      settled: take(isCuratorSettledFor(workspaceId)),
      curatorRejected: take(isServerMessageOfType('curatorRejected')),
      workspaceRejected: take(isServerMessageOfType('workspaceRejected')),
      timeout: delay(LAUNCH_TIMEOUT_MS),
    });
  } finally {
    yield put(curatorChangeSettled(workspaceId));
  }
}

export function* curatorSaga() {
  yield takeEvery(curatorChangeRequested.type, handleChange);
  yield takeEvery(curatorBindingRevokeRequested.type, handleRevoke);
}
