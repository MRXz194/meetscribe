import "server-only";
import type { TranscriptToken } from "../types";

const BASE = "https://api.soniox.com/v1";

export const REALTIME_MODEL = process.env.SONIOX_RT_MODEL || "stt-rt-v5";
export const ASYNC_MODEL = process.env.SONIOX_ASYNC_MODEL || "stt-async-v5";

function apiKey() {
  const key = process.env.SONIOX_API_KEY;
  if (!key) throw new Error("Thiếu SONIOX_API_KEY trong .env.local");
  return key;
}

async function soniox<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey()}`, ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Soniox ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Key ngắn hạn cho trình duyệt mở WebSocket; key thật chỉ nằm trên server. */
export async function createTemporaryKey() {
  const data = await soniox<{ api_key: string; expires_at: string }>("/auth/temporary-api-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usage_type: "transcribe_websocket",
      expires_in_seconds: 300,
      max_session_duration_seconds: 4 * 3600,
    }),
  });
  return data.api_key;
}

type AsyncToken = {
  text: string;
  start_ms?: number;
  end_ms?: number;
  speaker?: string;
  language?: string;
};

/** Upload file → tạo transcription → chờ xong → trả token đã chuẩn hoá. */
export async function transcribeFile(file: File): Promise<TranscriptToken[]> {
  const form = new FormData();
  form.append("file", file, file.name);
  const uploaded = await soniox<{ id: string }>("/files", { method: "POST", body: form });

  try {
    const job = await soniox<{ id: string }>("/transcriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ASYNC_MODEL,
        file_id: uploaded.id,
        language_hints: ["vi", "en"],
        enable_speaker_diarization: true,
        enable_language_identification: true,
      }),
    });

    try {
      for (;;) {
        const status = await soniox<{ status: string; error_message?: string }>(
          `/transcriptions/${job.id}`,
        );
        if (status.status === "completed") break;
        if (status.status === "error") throw new Error(status.error_message ?? "Soniox lỗi");
        await new Promise((r) => setTimeout(r, 1500));
      }
      const transcript = await soniox<{ tokens: AsyncToken[] }>(`/transcriptions/${job.id}/transcript`);
      return transcript.tokens.map((t) => ({
        text: t.text,
        startMs: t.start_ms,
        endMs: t.end_ms,
        speaker: t.speaker,
        language: t.language,
        isFinal: true,
      }));
    } finally {
      await soniox(`/transcriptions/${job.id}`, { method: "DELETE" }).catch(() => {});
    }
  } finally {
    // Không giữ file ghi âm trên server bên thứ ba lâu hơn cần thiết
    await soniox(`/files/${uploaded.id}`, { method: "DELETE" }).catch(() => {});
  }
}
