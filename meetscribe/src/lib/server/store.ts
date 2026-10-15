import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Meeting, MeetingListItem } from "../types";

/**
 * Repository lưu meeting dạng file JSON trong ./data/meetings.
 * Đủ cho bản localhost; đổi sang Postgres chỉ cần viết lại file này
 * với cùng các hàm list/get/create/update/remove.
 */
const DIR = path.join(process.cwd(), "data", "meetings");

const fileOf = (id: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid id");
  return path.join(DIR, `${id}.json`);
};

async function write(meeting: Meeting) {
  await mkdir(DIR, { recursive: true });
  const file = fileOf(meeting.id);
  // Ghi ra file tạm rồi rename để không bao giờ để lại JSON hỏng
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(meeting, null, 2), "utf8");
  await rename(tmp, file);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  try {
    return JSON.parse(await readFile(fileOf(id), "utf8")) as Meeting;
  } catch {
    return null;
  }
}

export async function listMeetings(): Promise<MeetingListItem[]> {
  await mkdir(DIR, { recursive: true });
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  const meetings = await Promise.all(files.map((f) => getMeeting(f.slice(0, -5))));
  return meetings
    .filter((m): m is Meeting => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((m) => ({
      id: m.id,
      title: m.title,
      source: m.source,
      status: m.status,
      createdAt: m.createdAt,
      durationSec: m.durationSec,
      hasSummary: m.summary !== null,
      preview: m.summary?.tldr ?? m.segments.slice(0, 3).map((s) => s.text).join(" ").slice(0, 200),
    }));
}

export async function createMeeting(
  data: Omit<Meeting, "id" | "createdAt" | "speakers" | "summary"> &
    Partial<Pick<Meeting, "speakers" | "summary">>,
): Promise<Meeting> {
  const meeting: Meeting = {
    speakers: {},
    summary: null,
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await write(meeting);
  return meeting;
}

export async function updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting | null> {
  const meeting = await getMeeting(id);
  if (!meeting) return null;
  const updated = { ...meeting, ...patch, id };
  await write(updated);
  return updated;
}

export async function removeMeeting(id: string) {
  await rm(fileOf(id), { force: true });
}
