import { z } from "zod";

/** Một token từ engine ASR, đã chuẩn hoá. */
export type TranscriptToken = {
  text: string;
  startMs?: number;
  endMs?: number;
  speaker?: string;
  language?: string;
  isFinal: boolean;
};

/** Một đoạn liền mạch của cùng một người nói. */
export type Segment = {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  language?: string;
};

export type MeetingSource = "tab" | "screen" | "upload";
export type MeetingStatus = "processing" | "ready" | "error";

export const summarySchema = z.object({
  tldr: z.string().describe("Tóm tắt cuộc họp trong 2-4 câu"),
  keyPoints: z.array(z.string()).describe("Các ý chính đã thảo luận"),
  decisions: z.array(z.string()).describe("Các quyết định đã chốt"),
  actionItems: z
    .array(
      z.object({
        task: z.string(),
        owner: z.string().nullable().describe("Người phụ trách, null nếu không rõ"),
        due: z.string().nullable().describe("Hạn chót, null nếu không rõ"),
      }),
    )
    .describe("Việc cần làm sau cuộc họp"),
  openQuestions: z.array(z.string()).describe("Câu hỏi còn bỏ ngỏ"),
});

export type Summary = z.infer<typeof summarySchema>;

export type Meeting = {
  id: string;
  title: string;
  source: MeetingSource;
  status: MeetingStatus;
  error?: string;
  createdAt: string;
  durationSec: number;
  segments: Segment[];
  /** Tên hiển thị theo nhãn speaker của engine, ví dụ {"1": "Anh Nam"} */
  speakers: Record<string, string>;
  summary: Summary | null;
  fileName?: string;
};

export type MeetingListItem = Pick<
  Meeting,
  "id" | "title" | "source" | "status" | "createdAt" | "durationSec"
> & { preview: string; hasSummary: boolean };
