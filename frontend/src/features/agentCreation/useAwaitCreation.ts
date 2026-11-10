import { useEffect, useState } from 'react';

import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { LAUNCH_TIMEOUT_MS } from '../../constants';
import { rejectionDismissed } from '../connection/connectionSlice';

/**
 * 送出建立請求後，等清單裡冒出一個原本沒有的項目，再交給 onCreated。
 * 伺服器拒絕（rejection 出現）或逾時就放棄等待，讓表單可以再送一次。
 */
export function useAwaitCreation<Key extends string | number>(
  currentIds: Key[],
  onCreated: (id: Key) => void,
) {
  const dispatch = useAppDispatch();
  const rejection = useAppSelector((state) => state.connection.rejection);
  const [knownIds, setKnownIds] = useState<Set<Key> | null>(null);
  const [seenRejection, setSeenRejection] = useState(rejection);

  if (rejection !== seenRejection) {
    setSeenRejection(rejection);
    if (rejection) setKnownIds(null);
  }

  useEffect(() => {
    if (!knownIds) return;
    const created = currentIds.find((id) => !knownIds.has(id));
    if (created !== undefined) onCreated(created);
  }, [currentIds, knownIds, onCreated]);

  useEffect(() => {
    if (!knownIds) return;
    const timer = setTimeout(() => setKnownIds(null), LAUNCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [knownIds]);

  return {
    pending: knownIds !== null,
    begin: () => {
      dispatch(rejectionDismissed());
      setKnownIds(new Set(currentIds));
    },
  };
}
