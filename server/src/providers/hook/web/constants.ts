/**
 * Web (REST) provider constants. Kept separate from `server/src/constants.ts`
 * per the same convention as the Claude provider's own `constants.ts`.
 */

/** Wire event-name vocabulary accepted by `POST /api/hooks/web`. One name per
 *  in-scope `AgentEvent.kind` (see docs/web-provider-plan.md Phase 2a). */
export const WEB_HOOK_EVENT_NAMES = [
  'sessionStart',
  'sessionEnd',
  'toolStart',
  'toolEnd',
  'turnEnd',
  'permissionRequest',
  'subagentStart',
  'subagentEnd',
] as const;

export type WebHookEventName = (typeof WEB_HOOK_EVENT_NAMES)[number];

export const WEB_PROVIDER_DISPLAY_NAME = 'Web (REST)';
