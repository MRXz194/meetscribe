import type { TranscriptToken } from "../types";

/** Audio đầu vào giữ tách kênh: engine nào hỗ trợ thì dùng kênh mic để biết chắc câu nào là "Tôi". */
export type AudioInput = {
  meeting: MediaStream;
  mic: MediaStream | null;
};

export type TranscriberHandlers = {
  /** finalTokens: chỉ những token mới được chốt; partialTokens: toàn bộ phần đang nghe */
  onTokens: (finalTokens: TranscriptToken[], partialTokens: TranscriptToken[]) => void;
  /** Engine gửi lại toàn bộ câu đã chốt với nhãn người nói chính xác hơn (bước offline khi dừng) */
  onReplaceFinals?: (finalTokens: TranscriptToken[]) => void;
  /** Thông báo tạm (đang nối lại…); null = hết thông báo */
  onNotice?: (message: string | null) => void;
  /** Cảnh báo kéo dài (kênh im lặng…) cho tới khi hết nguyên nhân; null = hết cảnh báo */
  onWarning?: (message: string | null) => void;
  onError: (message: string) => void;
  onFinished: () => void;
};

/**
 * Interface chung cho mọi engine speech-to-text realtime:
 * - LocalTranscriber: ASR server tự host (sherpa-onnx, miễn phí, chạy CPU)
 * - Deepgram: cloud, đi qua asr-server (LocalTranscriber với engine "deepgram")
 * UI chỉ biết interface này nên đổi engine không phải sửa UI.
 */
export interface LiveTranscriber {
  /** Sau khi stop(), chờ tối đa bao lâu cho onFinished trước khi tự kết thúc với kết quả đang có */
  readonly stopTimeoutMs: number;
  start(input: AudioInput, handlers: TranscriberHandlers): Promise<void>;
  /** Dừng và chờ engine trả nốt kết quả cuối (onFinished) */
  stop(): void;
  /** Huỷ ngay, bỏ kết quả */
  cancel(): void;
}

export type EngineId = "local" | "deepgram";

/** Ngôn ngữ cho engine Deepgram (nova-3). Đã đo: "multi" không hỗ trợ tiếng Việt, "vi" là lựa chọn duy nhất cho họp có tiếng Việt. */
export type DeepgramLanguage = "vi" | "en" | "multi";

export const DEEPGRAM_LANGUAGES: Record<DeepgramLanguage, { label: string; desc: string }> = {
  vi: { label: "Việt (xen Anh)", desc: "Tiếng Việt, có thể xen từ tiếng Anh. Câu nói hoàn toàn tiếng Anh sẽ kém chính xác hơn" },
  en: { label: "Anh", desc: "Họp hoàn toàn tiếng Anh" },
  multi: { label: "Đa ngữ", desc: "Anh/Tây Ban Nha/Pháp/Đức/Nhật… pha nhau. KHÔNG hỗ trợ tiếng Việt" },
};

/** Mọi engine đều đi qua asr-server (cùng giao thức 2 kênh). */
export const VIA_ASR_SERVER: EngineId[] = ["local", "deepgram"];

export const ENGINES: Record<EngineId, { label: string; desc: string }> = {
  local: { label: "Local", desc: "Miễn phí, sherpa-onnx chạy trên máy, audio không rời máy" },
  deepgram: {
    label: "Deepgram",
    desc: "Cloud, nova-3 tiếng Việt, tách người nói. Đi qua asr-server nên key không lộ; tính phí theo từng kênh",
  },
};

export async function createTranscriber(engine: EngineId, language: DeepgramLanguage = "vi"): Promise<LiveTranscriber> {
  const { LocalTranscriber } = await import("./local");
  return new LocalTranscriber(engine, language);
}
