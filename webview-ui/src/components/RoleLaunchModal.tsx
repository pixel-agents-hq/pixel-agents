import type { RolePreview } from '../../../core/src/messages.js';
import { ROLE_PREVIEW_MAX_HEIGHT_PX } from '../constants.js';
import type { RoleLaunchState } from '../roleLaunch.js';
import { previewLineCount, roleNameOf } from '../roleLaunch.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface RoleLaunchModalProps {
  state: RoleLaunchState;
  /** bypassPermissions is on: a trusted Role still needs an explicit confirm. */
  bypassPermissions: boolean;
  onPickRole: (roleId: string) => void;
  onPickNoRole: () => void;
  onConfirm: () => void;
  onBack: () => void;
  onCancel: () => void;
}

/**
 * Step two of a launch: pick a Role (optional), review it, confirm, launch.
 * Pure rendering of the roleLaunch state machine -- every decision is the
 * reducer's.
 */
export function RoleLaunchModal({
  state,
  bypassPermissions,
  onPickRole,
  onPickNoRole,
  onConfirm,
  onBack,
  onCancel,
}: RoleLaunchModalProps) {
  return (
    <Modal isOpen={state.step !== 'idle'} onClose={onCancel} title="Launch agent">
      <div data-testid="role-launch-modal" className="flex flex-col gap-6 p-4 min-w-128">
        {state.step === 'choose' && (
          <>
            <div className="text-text-muted">Role (optional)</div>
            {state.error && <ErrorLine text={state.error} />}
            <Button onClick={onPickNoRole} data-testid="role-none">
              No role
            </Button>
            {state.roles === null && <div className="text-text-muted">Loading roles...</div>}
            {state.roles?.map((role) => (
              <Button key={role.roleId} onClick={() => onPickRole(role.roleId)}>
                {role.name}
              </Button>
            ))}
          </>
        )}
        {state.step === 'preview' && (
          <>
            <div className="text-text-muted">Role: {roleNameOf(state.roleId)}</div>
            {state.error && <ErrorLine text={state.error} />}
            {state.preview === null ? (
              <div className="text-text-muted">Loading preview...</div>
            ) : (
              <RolePreviewText preview={state.preview} />
            )}
            {state.preview !== null && (
              <div className="flex gap-6">
                <Button
                  variant="accent"
                  disabled={state.confirming}
                  onClick={onConfirm}
                  data-testid="role-confirm"
                >
                  {state.confirming ? 'Confirming...' : 'Confirm and launch'}
                </Button>
                <Button onClick={onBack}>Back</Button>
              </div>
            )}
            {state.preview !== null && state.preview.trusted && bypassPermissions && (
              <div className="text-text-muted text-sm">
                Already trusted, but permissions are bypassed: review and confirm again.
              </div>
            )}
          </>
        )}
        {state.step === 'launching' && (
          <div className="text-text-muted">Launching {roleNameOf(state.roleId)}...</div>
        )}
      </div>
    </Modal>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div role="alert" className="text-status-error">
      {text}
    </div>
  );
}

/**
 * The Role file as plain text. The content is a React text node and nothing
 * else: no markdown, no HTML, no links -- this page holds the server token, and
 * a Role file is untrusted input. The host already replaced invisible
 * characters with `<U+XXXX>` markers; they are shown as they come.
 */
export function RolePreviewText({ preview }: { preview: RolePreview }) {
  const lines = previewLineCount(preview.content);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-text-muted text-sm" data-testid="role-preview-meta">
        {lines} {lines === 1 ? 'line' : 'lines'} - {preview.size} bytes - sha256{' '}
        {preview.sha256.slice(0, 12)}
        {preview.trusted ? ' - trusted' : ' - not yet trusted'}
      </div>
      <pre
        data-testid="role-preview-content"
        className="m-0 p-4 border-2 border-border bg-btn-bg whitespace-pre-wrap [overflow-wrap:anywhere] overflow-y-auto"
        style={{ maxHeight: ROLE_PREVIEW_MAX_HEIGHT_PX }}
      >
        {preview.content}
      </pre>
    </div>
  );
}
