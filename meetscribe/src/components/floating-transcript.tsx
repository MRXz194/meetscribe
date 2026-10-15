"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { TranscriptView } from "@/components/transcript-view";
import { formatClock } from "@/lib/transcript";
import type { Segment } from "@/lib/types";

type Props = {
  pipWindow: Window;
  segments: Segment[];
  partials: { speaker: string; text: string }[];
  nameOf: (speaker: string) => string;
  elapsedMs: number;
  recording: boolean;
};

/** Nội dung cửa sổ nổi: vài đoạn gần nhất + chữ đang nghe, luôn cuộn xuống cuối. */
export function FloatingTranscript({ pipWindow, segments, partials, nameOf, elapsedMs, recording }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const recent = segments.slice(-8);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments, partials]);

  return createPortal(
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        {recording && <span className="size-2 animate-pulse rounded-full bg-red-500" />}
        <span className="font-semibold">MeetScribe</span>
        <span className="ml-auto font-mono tabular-nums text-muted-foreground">{formatClock(elapsedMs)}</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        {recent.length === 0 && partials.length === 0 ? (
          <p className="text-muted-foreground">Đang nghe… chữ sẽ hiện ngay khi có người nói.</p>
        ) : (
          <TranscriptView segments={recent} partials={partials} nameOf={nameOf} />
        )}
      </div>
    </div>,
    pipWindow.document.body,
  );
}
