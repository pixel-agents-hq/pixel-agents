import { useEffect } from 'react';

import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { KB_TEXT } from '../../constants';
import {
  EMPTY_KB_VIEW,
  kbDirectoryChanged,
  kbFileSelected,
  kbListRequested,
  kbTargetKey,
} from '../../features/kb/kbSlice';
import type { KbTarget } from '../../protocol';
import { KbBrowser } from './KbBrowser';

/** 容器：target 變了或重新連線就重新列出檔案，點選檔案才讀內容。target 為 null 表示無從瀏覽。 */
export function KbPanel({
  target,
  blockedNote,
}: {
  target: KbTarget | null;
  blockedNote?: string | null;
}) {
  const dispatch = useAppDispatch();
  const connected = useAppSelector((state) => state.connection.status === 'connected');
  const key = target ? kbTargetKey(target) : null;
  const view = useAppSelector((state) => (key ? state.kb.byKey[key] : undefined)) ?? EMPTY_KB_VIEW;

  useEffect(() => {
    if (target && connected) dispatch(kbListRequested(target));
    // target 以 key 比較，避免每次 render 的新物件觸發重列
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, key, connected]);

  const note = blockedNote ?? (connected ? null : KB_TEXT.notConnected);
  return (
    <KbBrowser
      view={view}
      blockedNote={note}
      onSelect={(relPath) => target && dispatch(kbFileSelected({ target, relPath }))}
      onChangeDirectory={(dir) => target && dispatch(kbDirectoryChanged({ target, dir }))}
    />
  );
}
