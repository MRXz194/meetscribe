import type { NextRequest } from "next/server";
import { getMeeting, updateMeeting } from "@/lib/server/store";
import { summarizeMeeting } from "@/lib/server/summarize";

export const maxDuration = 120;

export async function POST(_req: NextRequest, ctx: RouteContext<"/api/meetings/[id]/summarize">) {
  const { id } = await ctx.params;
  const meeting = await getMeeting(id);
  if (!meeting) return Response.json({ error: "Không tìm thấy" }, { status: 404 });
  if (!meeting.segments.length) {
    return Response.json({ error: "Transcript trống, không có gì để tóm tắt" }, { status: 400 });
  }

  try {
    const summary = await summarizeMeeting(meeting);
    const updated = await updateMeeting(id, { summary });
    return Response.json(updated);
  } catch (err) {
    console.error("summarize failed", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
