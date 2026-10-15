import type { NextRequest } from "next/server";
import { z } from "zod";
import { getMeeting, removeMeeting, updateMeeting } from "@/lib/server/store";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/meetings/[id]">) {
  const { id } = await ctx.params;
  const meeting = await getMeeting(id);
  if (!meeting) return Response.json({ error: "Không tìm thấy" }, { status: 404 });
  return Response.json(meeting);
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  speakers: z.record(z.string(), z.string().trim().max(60)).optional(),
});

/** Đổi tiêu đề hoặc tên người nói. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/meetings/[id]">) {
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Dữ liệu không hợp lệ" }, { status: 400 });

  const meeting = await getMeeting(id);
  if (!meeting) return Response.json({ error: "Không tìm thấy" }, { status: 404 });

  const updated = await updateMeeting(id, {
    ...(parsed.data.title && { title: parsed.data.title }),
    ...(parsed.data.speakers && { speakers: { ...meeting.speakers, ...parsed.data.speakers } }),
  });
  return Response.json(updated);
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/meetings/[id]">) {
  const { id } = await ctx.params;
  await removeMeeting(id);
  return new Response(null, { status: 204 });
}
