"use client";

import { Fragment, memo } from "react";
import { cn } from "@/lib/utils";
import { formatClock } from "@/lib/transcript";
import type { Segment } from "@/lib/types";

const COLORS = [
  "text-blue-600 dark:text-blue-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-amber-600 dark:text-amber-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-cyan-600 dark:text-cyan-400",
  "text-rose-600 dark:text-rose-400",
];

export function speakerColor(speaker: string) {
  if (speaker === "me") return "text-violet-600 dark:text-violet-400";
  const n = Number.parseInt(speaker, 10);
  return COLORS[(Number.isNaN(n) ? speaker.length : n - 1) % COLORS.length];
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-500/40">
        {p}
      </mark>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

type Props = {
  segments: Segment[];
  /** Phần đang nghe, chưa chốt (có thể nhiều người cùng lúc: mic và cuộc họp) */
  partials?: { speaker: string; text: string }[];
  nameOf: (speaker: string) => string;
  onSpeakerClick?: (speaker: string) => void;
  query?: string;
};

type RowProps = {
  seg: Segment;
  tail?: string;
  query: string;
  nameOf: (speaker: string) => string;
  onSpeakerClick?: (speaker: string) => void;
};

/**
 * Một đoạn transcript. Memo theo nội dung (không theo identity của seg, vì buildSegments tạo object mới
 * mỗi lần có câu mới): họp 2 tiếng có hàng nghìn đoạn, chỉ đoạn thật sự đổi mới phải render lại.
 * content-visibility: auto để trình duyệt bỏ qua layout/paint các đoạn đang ngoài màn hình.
 */
const Row = memo(
  function Row({ seg, tail, query, nameOf, onSpeakerClick }: RowProps) {
    return (
      <div className="grid grid-cols-[3.5rem_1fr] gap-3 [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]">
        <span className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">{formatClock(seg.startMs)}</span>
        <div>
          <button
            type="button"
            disabled={!onSpeakerClick}
            onClick={() => onSpeakerClick?.(seg.speaker)}
            className={cn("text-sm font-semibold", speakerColor(seg.speaker), onSpeakerClick && "hover:underline")}
            title={onSpeakerClick ? "Bấm để đổi tên" : undefined}
          >
            {nameOf(seg.speaker)}
          </button>
          <p className="leading-relaxed">
            {highlight(seg.text, query)}
            {tail && <span className="text-muted-foreground"> {tail}</span>}
          </p>
        </div>
      </div>
    );
  },
  (a, b) =>
    a.seg.text === b.seg.text &&
    a.seg.speaker === b.seg.speaker &&
    a.seg.startMs === b.seg.startMs &&
    a.tail === b.tail &&
    a.query === b.query &&
    a.nameOf === b.nameOf &&
    a.onSpeakerClick === b.onSpeakerClick,
);

export function TranscriptView({ segments, partials = [], nameOf, onSpeakerClick, query = "" }: Props) {
  const visible = query
    ? segments.filter((s) => s.text.toLowerCase().includes(query.toLowerCase()))
    : segments;
  // Phần đang nghe cùng người nói với đoạn cuối thì nối tiếp ngay trong đoạn đó
  const last = visible.at(-1);
  const pending = partials.filter((p) => p.text.trim());
  const inline = last ? pending.find((p) => p.speaker === last.speaker) : undefined;
  const separate = pending.filter((p) => p !== inline);

  return (
    <div className="space-y-4">
      {visible.map((seg, i) => (
        <Row
          key={`${seg.startMs}-${i}`}
          seg={seg}
          tail={inline && i === visible.length - 1 ? inline.text.trim() : undefined}
          query={query}
          nameOf={nameOf}
          onSpeakerClick={onSpeakerClick}
        />
      ))}
      {separate.map((p) => (
        <div key={p.speaker} className="grid grid-cols-[3.5rem_1fr] gap-3">
          <span className="pt-0.5 font-mono text-xs text-muted-foreground">…</span>
          <div>
            <span className={cn("text-sm font-semibold opacity-70", speakerColor(p.speaker))}>
              {nameOf(p.speaker)}
            </span>
            <p className="leading-relaxed text-muted-foreground">{p.text}</p>
          </div>
        </div>
      ))}
      {query && visible.length === 0 && (
        <p className="text-sm text-muted-foreground">Không có đoạn nào chứa “{query}”.</p>
      )}
    </div>
  );
}
