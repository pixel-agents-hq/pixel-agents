import type { ReactNode } from 'react';

import type { DailyPr, DailyStats } from '../../../core/src/messages.js';
import {
  countLabel,
  formatHours,
  newestPrs,
  safePrUrl,
  totalPushes,
} from '../progress/progressFormat.js';
import { tokenMeterText, tokenMeterTitle } from '../signals/signalFormat.js';
import { useSignals } from '../signals/useSignals.js';

interface DailyStripProps {
  /** Latest dailyStats; the strip stays hidden until the first one arrives. */
  stats: DailyStats | null;
  /** Phones: one short line of icons and numbers. */
  compact: boolean;
  /** Desktop with the BottomToolbar showing: sit above it, in the slot the
   *  layout editor's toolbar uses (the strip hides while editing). */
  aboveToolbar: boolean;
  /** Leading control (the "📋 Tasks" button); shown even before the first stats. */
  action?: ReactNode;
  /** Shown first on the strip: the inbox's 📥 button and paused count. */
  leading?: ReactNode;
}

/** One PR trophy: title + repo, a new-tab link when the PR has a usable url. */
function PrTrophy({ pr, compact }: { pr: DailyPr; compact: boolean }) {
  const url = safePrUrl(pr.url);
  const body = (
    <>
      <span>🏆</span>
      <span className={`overflow-hidden text-ellipsis ${compact ? 'min-w-0' : 'max-w-[220px]'}`}>
        {pr.title}
      </span>
      {!compact && (
        <span className="overflow-hidden text-ellipsis max-w-[160px] text-text-muted">
          {pr.repo}
        </span>
      )}
    </>
  );
  const className = `flex items-center gap-4 min-w-0 ${compact ? '' : 'shrink-0'}`;
  const title = `${pr.title} · ${pr.repo}`;
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={`${className} text-text no-underline hover:text-accent-bright`}
    >
      {body}
    </a>
  ) : (
    <span title={title} className={className}>
      {body}
    </span>
  );
}

/**
 * The done-today strip along the bottom of the office: PRs, pushes, files,
 * commands and active hours for the local day, then the newest PR trophies.
 * Desktop gets the full sentence-like line; phones get icons and numbers with
 * only the newest trophy. Overlays the office region (never the terminal), so
 * on phones it slides away with the office page and sits above the card bar.
 */
export function DailyStrip({ stats, compact, aboveToolbar, action, leading }: DailyStripProps) {
  // Today's tokens and estimated spend (useful signals): "🔤 1.2M tok · ~$3.40 est."
  const { tokens } = useSignals();
  if (!stats) {
    if (!action && !leading) return null;
    const place = compact
      ? 'left-8 bottom-8'
      : `left-10 ${aboveToolbar ? 'bottom-76' : 'bottom-10'}`;
    return (
      <div className={`absolute ${place} z-20 flex items-center gap-8 text-sm`}>
        {action}
        {leading}
      </div>
    );
  }
  const tokenMeter = tokens && (
    <span className="shrink-0" title={tokenMeterTitle(tokens)} data-testid="token-meter">
      {tokenMeterText(tokens)}
    </span>
  );
  const lead = leading ? (
    <span className="shrink-0 flex items-center gap-8 pr-8 border-r-2 border-border">
      {leading}
    </span>
  ) : null;

  const prs = newestPrs(stats.prs);
  const pushes = totalPushes(stats.pushes);
  const hours = formatHours(stats.activeMs);
  const summary = [
    countLabel(prs.length, 'PR'),
    countLabel(pushes, 'push', 'pushes'),
    countLabel(stats.filesEdited, 'file'),
    countLabel(stats.commandsRun, 'cmd'),
    hours,
  ];

  if (compact) {
    return (
      <div
        className="absolute left-8 bottom-8 z-20 pixel-panel flex items-center gap-8 py-2 px-6 text-2xs whitespace-nowrap overflow-hidden max-w-[calc(100%-110px)] select-none"
        title={`Today: ${summary.join(', ')}`}
        data-testid="daily-strip"
      >
        {action}
        {lead}
        <span className="shrink-0">🏆{prs.length}</span>
        <span className="shrink-0">📦{pushes}</span>
        <span className="shrink-0">✏️{stats.filesEdited}</span>
        <span className="shrink-0">⌨️{stats.commandsRun}</span>
        <span className="shrink-0">⏱️{hours.replace(' ', '')}</span>
        {tokenMeter}
        {prs[0] && (
          <span className="flex min-w-0 pl-8 border-l-2 border-border">
            <PrTrophy pr={prs[0]} compact />
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className={`absolute left-10 ${aboveToolbar ? 'bottom-76' : 'bottom-10'} z-20 pixel-panel flex items-center gap-12 py-4 px-10 text-sm whitespace-nowrap overflow-hidden max-w-[calc(100%-110px)] select-none`}
      data-testid="daily-strip"
    >
      {action}
      {lead}
      <span className="shrink-0 text-text-muted">TODAY</span>
      <span className="shrink-0">🏆 {summary[0]}</span>
      <span className="shrink-0">📦 {summary[1]}</span>
      <span className="shrink-0">✏️ {summary[2]}</span>
      <span className="shrink-0">⌨️ {summary[3]}</span>
      <span className="shrink-0">⏱️ {hours}</span>
      {tokenMeter}
      {prs.length > 0 && (
        // Newest first; whatever does not fit scrolls sideways under the edge.
        <div className="flex items-center gap-12 min-w-0 pl-12 border-l-2 border-border overflow-x-auto no-scrollbar">
          {prs.map((pr) => (
            <PrTrophy key={pr.url ?? `${pr.repo}:${pr.at}`} pr={pr} compact={false} />
          ))}
        </div>
      )}
    </div>
  );
}
