import type { Meeting, Segment, TranscriptToken } from "./types";

// Token điều khiển của engine (ví dụ "<end>" khi phát hiện ngắt câu, "<fin>" khi finalize)
const CONTROL_TOKEN = /^<[a-z]+>$/;

/** Gộp các token liên tiếp cùng người nói thành đoạn. */
export function buildSegments(tokens: TranscriptToken[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let lastEndMs = 0;

  for (const token of tokens) {
    if (token.endMs !== undefined) lastEndMs = token.endMs;
    if (CONTROL_TOKEN.test(token.text.trim())) {
      current = null;
      continue;
    }
    const speaker = token.speaker ?? "1";
    if (!current || current.speaker !== speaker) {
      // Bỏ khoảng trắng đầu câu khi sang đoạn mới
      if (!token.text.trim()) continue;
      current = {
        speaker,
        text: token.text.trimStart(),
        startMs: token.startMs ?? lastEndMs,
        endMs: token.endMs ?? token.startMs ?? lastEndMs,
        language: token.language,
      };
      segments.push(current);
    } else {
      current.text += token.text;
      if (token.endMs !== undefined) current.endMs = token.endMs;
    }
  }

  return segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

/** "me" = câu đến từ kênh micro của chính người ghi (biết chắc, không phải đoán). */
export function defaultSpeakerName(speaker: string) {
  return speaker === "me" ? "Tôi" : `Người nói ${speaker}`;
}

export function speakerName(meeting: Pick<Meeting, "speakers">, speaker: string) {
  return meeting.speakers[speaker] || defaultSpeakerName(speaker);
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function srtTime(ms: number) {
  const date = new Date(Math.max(0, ms));
  return date.toISOString().slice(11, 23).replace(".", ",");
}

export function toTxt(meeting: Meeting) {
  return meeting.segments
    .map((s) => `[${formatClock(s.startMs)}] ${speakerName(meeting, s.speaker)}: ${s.text}`)
    .join("\n");
}

export function toSrt(meeting: Meeting) {
  return meeting.segments
    .map(
      (s, i) =>
        `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(Math.max(s.endMs, s.startMs + 500))}\n${speakerName(meeting, s.speaker)}: ${s.text}\n`,
    )
    .join("\n");
}

export function toMarkdown(meeting: Meeting) {
  const lines = [
    `# ${meeting.title}`,
    "",
    `- Thời gian: ${new Date(meeting.createdAt).toLocaleString("vi-VN")}`,
    `- Thời lượng: ${formatClock(meeting.durationSec * 1000)}`,
    "",
  ];
  const s = meeting.summary;
  if (s) {
    lines.push("## Tóm tắt", "", s.tldr, "");
    const list = (title: string, items: string[]) => {
      if (!items.length) return;
      lines.push(`## ${title}`, "", ...items.map((i) => `- ${i}`), "");
    };
    list("Ý chính", s.keyPoints);
    list("Quyết định", s.decisions);
    list(
      "Việc cần làm",
      s.actionItems.map(
        (a) => `[ ] ${a.task}${a.owner ? ` (${a.owner})` : ""}${a.due ? `, hạn ${a.due}` : ""}`,
      ),
    );
    list("Câu hỏi mở", s.openQuestions);
  }
  lines.push("## Transcript", "");
  for (const seg of meeting.segments) {
    lines.push(`**${speakerName(meeting, seg.speaker)}** [${formatClock(seg.startMs)}]: ${seg.text}`, "");
  }
  return lines.join("\n");
}
