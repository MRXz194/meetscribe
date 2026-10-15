import "server-only";
import { generateText, Output, type LanguageModel } from "ai";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { speakerName } from "../transcript";
import { summarySchema, type Meeting, type Summary } from "../types";

/** Endpoint chuẩn OpenAI (Ollama chạy local, Groq free tier, LM Studio…). */
function compatible(name: string, baseURL: string, apiKey: string | undefined, model: string) {
  return createOpenAICompatible({ name, baseURL, apiKey, supportsStructuredOutputs: true })(model);
}

/**
 * Chọn LLM theo env; đổi provider không phải sửa code gọi.
 * Miễn phí: google (Gemini free tier), groq (free tier), ollama (chạy local, không cần key).
 */
function pickModel(): LanguageModel {
  const env = process.env;
  const provider =
    env.LLM_PROVIDER ||
    (env.GOOGLE_GENERATIVE_AI_API_KEY
      ? "google"
      : env.GROQ_API_KEY
        ? "groq"
        : env.ANTHROPIC_API_KEY
          ? "anthropic"
          : env.OPENAI_API_KEY
            ? "openai"
            : null);
  const model = env.LLM_MODEL;
  switch (provider) {
    case "google":
      return google(model || "gemini-flash-latest");
    case "groq":
      return compatible("groq", "https://api.groq.com/openai/v1", env.GROQ_API_KEY, model || "llama-3.3-70b-versatile");
    case "ollama":
      return compatible("ollama", env.LLM_BASE_URL || "http://localhost:11434/v1", undefined, model || "qwen2.5:7b");
    case "anthropic":
      return anthropic(model || "claude-haiku-5-5");
    case "openai":
      return openai(model || "gpt-5-mini");
    default:
      throw new Error(
        "Chưa cấu hình LLM tóm tắt. Miễn phí: đặt GOOGLE_GENERATIVE_AI_API_KEY (Google AI Studio) hoặc GROQ_API_KEY, hoặc LLM_PROVIDER=ollama nếu đã cài Ollama.",
      );
  }
}

const SYSTEM = `Bạn là thư ký cuộc họp chuyên nghiệp. Dựa trên transcript (có thể lẫn tiếng Anh, có lỗi nhận dạng giọng nói), hãy viết biên bản bằng tiếng Việt.
- Chỉ dùng thông tin có trong transcript, không bịa.
- Giữ nguyên thuật ngữ tiếng Anh (deploy, deadline, API…).
- Việc cần làm: ghi rõ người phụ trách và hạn nếu được nhắc đến, không thì để null.
- Mảng nào không có nội dung thì để rỗng.`;

export async function summarizeMeeting(meeting: Meeting): Promise<Summary> {
  const transcript = meeting.segments
    .map((s) => `${speakerName(meeting, s.speaker)}: ${s.text}`)
    .join("\n");

  const { output } = await generateText({
    model: pickModel(),
    system: SYSTEM,
    prompt: `Tiêu đề: ${meeting.title}\n\nTranscript:\n${transcript}`,
    output: Output.object({ schema: summarySchema, name: "meeting_summary" }),
  });
  return output;
}
