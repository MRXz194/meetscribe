import { after } from "next/server";
import { buildSegments } from "@/lib/transcript";
import { createMeeting, updateMeeting } from "@/lib/server/store";
import { transcribeFile } from "@/lib/server/soniox";

export const maxDuration = 600;

const MAX_BYTES = 500 * 1024 * 1024;

/** Nhận file ghi âm, trả id ngay, xử lý Soniox async ở nền; trang chi tiết tự poll. */
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Chưa chọn file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File quá lớn (tối đa 500 MB)" }, { status: 400 });
  }

  const meeting = await createMeeting({
    title: file.name.replace(/\.[^.]+$/, ""),
    source: "upload",
    status: "processing",
    durationSec: 0,
    segments: [],
    fileName: file.name,
  });

  after(async () => {
    try {
      const segments = buildSegments(await transcribeFile(file));
      const durationSec = Math.round((segments.at(-1)?.endMs ?? 0) / 1000);
      await updateMeeting(meeting.id, { status: "ready", segments, durationSec });
    } catch (err) {
      console.error("upload transcription failed", err);
      await updateMeeting(meeting.id, { status: "error", error: (err as Error).message });
    }
  });

  return Response.json({ id: meeting.id }, { status: 202 });
}
