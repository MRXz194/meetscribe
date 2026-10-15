import type { SonioxClient, Token } from "@soniox/speech-to-text-web";
import { mixToStream } from "../audio/sources";
import type { TranscriptToken } from "../types";
import type { AudioInput, LiveTranscriber, TranscriberHandlers } from "./types";

type KeyResponse = { apiKey: string; model: string };

function normalize(token: Token): TranscriptToken {
  return {
    text: token.text,
    startMs: token.start_ms,
    endMs: token.end_ms,
    speaker: token.speaker,
    language: token.language,
    isFinal: token.is_final,
  };
}

/**
 * Stream audio thẳng từ trình duyệt lên Soniox bằng temporary key do server cấp.
 * Web SDK chỉ nhận 1 stream nên mic và cuộc họp được trộn chung; ai nói do Soniox đoán.
 */
export class SonioxTranscriber implements LiveTranscriber {
  readonly stopTimeoutMs = 8000;
  private client: SonioxClient | null = null;
  private mix: ReturnType<typeof mixToStream> | null = null;

  async start(input: AudioInput, handlers: TranscriberHandlers) {
    // Lấy key trước để biết model; key thật không bao giờ rời server
    const res = await fetch("/api/soniox-key", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Không lấy được key Soniox");
    }
    const { apiKey, model } = (await res.json()) as KeyResponse;

    this.mix = mixToStream(input.mic ? [input.meeting, input.mic] : [input.meeting]);
    // SDK đụng tới `window` khi import, nên chỉ nạp ở trình duyệt
    const { SonioxClient } = await import("@soniox/speech-to-text-web");
    this.client = new SonioxClient({ apiKey, bufferQueueSize: 1000 });
    await this.client.start({
      model,
      stream: this.mix.stream,
      languageHints: ["vi", "en"],
      enableSpeakerDiarization: true,
      enableLanguageIdentification: true,
      enableEndpointDetection: true,
      onPartialResult: (result) => {
        const finals: TranscriptToken[] = [];
        const partials: TranscriptToken[] = [];
        for (const t of result.tokens) (t.is_final ? finals : partials).push(normalize(t));
        handlers.onTokens(finals, partials);
      },
      onError: (status, message) => handlers.onError(`${status}: ${message}`),
      onFinished: () => {
        this.mix?.close();
        handlers.onFinished();
      },
    });
  }

  stop() {
    this.client?.stop();
  }

  cancel() {
    this.client?.cancel();
    this.client = null;
    this.mix?.close();
  }
}
