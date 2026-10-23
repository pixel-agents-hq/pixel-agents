/**
 * The notice board (docs/office/DESIGN.md, phase F): up to five tiny lines on
 * every NOTICE_BOARD wall sprite's cork, one per open PR or issue the server
 * found with `gh`. Clicking or tapping the board opens the full list with links.
 * A DOM overlay over the canvas (like the labels), following pan and zoom.
 */

import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import {
  NOTICE_BOARD_CORK,
  NOTICE_BOARD_INK,
  NOTICE_BOARD_LINES,
  NOTICE_BOARD_PAPER,
  NOTICE_BOARD_TYPE,
  SIGNAL_POPUP_Z_INDEX,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { safePrUrl } from '../progress/progressFormat.js';
import { noticeBoardRects, noticeLines } from './signalFormat.js';
import { useSignals } from './useSignals.js';

interface NoticeBoardOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** Hidden while the layout editor is open (the board is furniture to edit then). */
  hidden: boolean;
}

export function NoticeBoardOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
  hidden,
}: NoticeBoardOverlayProps) {
  const { notices } = useSignals();
  const [open, setOpen] = useState(false);
  // Follow pan and zoom: re-render every frame while a board is on the layout.
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (officeState.getLayout().furniture.some((f) => f.type === NOTICE_BOARD_TYPE)) {
        setFrame((n) => (n + 1) % 1_000_000);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [officeState]);

  const el = containerRef.current;
  if (hidden || !el) return null;
  const boards = noticeBoardRects(officeState.getLayout().furniture, NOTICE_BOARD_TYPE);
  if (boards.length === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );
  const px = zoom / dpr; // CSS px per sprite px
  const lines = noticeLines(notices, NOTICE_BOARD_LINES);
  const lineH = (NOTICE_BOARD_CORK.h / NOTICE_BOARD_LINES) * px;

  return (
    <>
      {boards.map((b) => (
        <button
          key={b.uid}
          type="button"
          className="absolute p-0 m-0 border-0 bg-transparent cursor-pointer overflow-hidden"
          style={{
            left: project.toScreenX(b.x),
            top: project.toScreenY(b.y),
            width: b.w * px,
            height: b.h * px,
          }}
          title={notices.length > 0 ? `${notices.length} open on GitHub` : 'Notice board'}
          aria-label="Notice board: open PRs and issues"
          data-testid="notice-board"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {lines.map((line, i) => (
            <span
              key={i}
              className="absolute block whitespace-nowrap overflow-hidden text-ellipsis text-left leading-none"
              style={{
                left: NOTICE_BOARD_CORK.x * px,
                top: NOTICE_BOARD_CORK.y * px + i * lineH,
                width: NOTICE_BOARD_CORK.w * px,
                height: lineH * 0.85,
                fontSize: lineH * 0.8,
                color: NOTICE_BOARD_INK,
                background: NOTICE_BOARD_PAPER,
              }}
            >
              {line}
            </span>
          ))}
        </button>
      ))}
      {open && (
        <div
          className="absolute left-1/2 top-16 -translate-x-1/2 pixel-panel flex flex-col gap-6 py-8 px-12 text-sm max-h-[70%] overflow-y-auto"
          style={{ width: 'min(440px, calc(100% - 32px))', zIndex: SIGNAL_POPUP_Z_INDEX }}
          data-testid="notice-board-list"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-8">
            <span className="font-bold flex-1">📌 Notice board</span>
            <Button variant="ghost" size="icon" onClick={() => setOpen(false)} title="Close">
              ×
            </Button>
          </div>
          {notices.length === 0 ? (
            <span className="text-xs text-text-muted">
              No open PRs or issues for today&apos;s repos (or `gh` isn&apos;t signed in).
            </span>
          ) : (
            notices.map((item) => {
              const url = safePrUrl(item.url);
              const text = `${item.kind === 'pr' ? '🔀' : '🐞'} ${item.title}`;
              return (
                <div key={item.url} className="flex flex-col">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-text no-underline hover:text-accent-bright"
                    >
                      {text}
                    </a>
                  ) : (
                    <span>{text}</span>
                  )}
                  <span className="text-xs text-text-muted">{item.repo}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </>
  );
}
