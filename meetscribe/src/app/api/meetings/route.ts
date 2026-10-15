import { z } from "zod";
import { createMeeting, listMeetings } from "@/lib/server/store";

export async function GET() {
  return Response.json(await listMeetings());
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  source: z.enum(["tab", "screen", "upload"]),
  fileName: z.string().max(300).optional(),
  durationSec: z.number().int().nonnegative(),
  segments: z.array(
    z.object({
      speaker: z.string(),
      text: z.string(),
      startMs: z.number(),
      endMs: z.number(),
      language: z.string().optional(),
    }),
  ),
});

/** Lưu cuộc họp vừa ghi live, hoặc file đã được ASR local xử lý xong. */
export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });
  }
  const meeting = await createMeeting({ ...parsed.data, status: "ready" });
  return Response.json(meeting, { status: 201 });
}
