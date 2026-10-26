import { useEffect, useState } from 'react';

interface LaunchRejectionToastProps {
  rejection: { providerId?: string; reason: string; at: number };
}

/**
 * The server refused a +Agent launch (unknown provider, view-only provider,
 * provider CLI missing from PATH...). The refusal arrives with no agent and
 * no terminal, so without this the click is indistinguishable from the old
 * silent-failure bug. Auto-dismisses; a newer rejection re-arms it.
 */
export function LaunchRejectionToast({ rejection }: LaunchRejectionToastProps) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(timer);
  }, [rejection.at]);

  if (!visible) return null;

  return (
    <div
      role="alert"
      onClick={() => setVisible(false)}
      className="absolute bottom-28 left-1/2 z-40 -translate-x-1/2 pixel-panel max-w-96 p-3 text-sm text-accent-bright cursor-pointer"
    >
      {rejection.reason}
    </div>
  );
}
