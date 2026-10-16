"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppWindowIcon, FileAudioIcon, Loader2Icon, MonitorIcon, SparklesIcon, UploadIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEngine } from "@/hooks/useEngine";
import { useDeepgramLanguage } from "@/hooks/useDeepgramLanguage";
import { formatClock } from "@/lib/transcript";
import type { MeetingListItem, MeetingSource } from "@/lib/types";

export const SOURCE_LABEL: Record<MeetingSource, { label: string; icon: typeof MonitorIcon }> = {
  tab: { label: "Trình duyệt", icon: AppWindowIcon },
  screen: { label: "App desktop", icon: MonitorIcon },
  upload: { label: "File", icon: FileAudioIcon },
};

export function MeetingList() {
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [engine] = useEngine();
  const [language] = useDeepgramLanguage();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/meetings")
      .then((r) => r.json())
      .then(setMeetings)
      .catch(() => setMeetings([]));
  }, []);

  async function upload(file: File) {
    setUploading(true);
    try {
      // Giải mã ngay trên trình duyệt, ASR server (local hoặc Deepgram) xử lý, rồi lưu như cuộc họp thường
      const { transcribeFileLocally } = await import("@/lib/transcriber/local");
      const result = await transcribeFileLocally(file, engine, language);
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, ""),
          source: "upload",
          fileName: file.name,
          durationSec: result.durationSec,
          segments: result.segments,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Lưu thất bại");
      router.push(`/meetings/${body.id}`);
    } catch (err) {
      toast.error((err as Error).message);
      setUploading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cuộc họp</h1>
          <p className="text-sm text-muted-foreground">
            Transcript tiếng Việt có người nói, tóm tắt và việc cần làm cho mọi cuộc họp trên máy tính.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,video/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          <Button variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
            {uploading ? "Đang nhận dạng…" : "Upload file ghi âm"}
          </Button>
          <Link href="/record" className={buttonVariants()}>
            Ghi cuộc họp mới
          </Link>
        </div>
      </div>

      {meetings === null ? (
        <div className="flex justify-center py-20 text-muted-foreground">
          <Loader2Icon className="animate-spin" />
        </div>
      ) : meetings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <FileAudioIcon className="size-10 text-muted-foreground" />
            <p className="font-medium">Chưa có cuộc họp nào</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Mở Google Meet, Zoom hoặc Teams, rồi bấm “Ghi cuộc họp mới”. Hoặc upload một file ghi âm có sẵn.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {meetings.map((m) => {
            const source = SOURCE_LABEL[m.source];
            return (
              <Link key={m.id} href={`/meetings/${m.id}`}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.title}</span>
                      <Badge variant="outline">
                        <source.icon />
                        {source.label}
                      </Badge>
                      {m.status === "processing" && <Badge variant="secondary">Đang xử lý…</Badge>}
                      {m.status === "error" && <Badge variant="destructive">Lỗi</Badge>}
                      {m.hasSummary && (
                        <Badge variant="secondary">
                          <SparklesIcon />
                          Đã tóm tắt
                        </Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {new Date(m.createdAt).toLocaleString("vi-VN")} · {formatClock(m.durationSec * 1000)}
                      </span>
                    </div>
                    {m.preview && <p className="line-clamp-2 text-sm text-muted-foreground">{m.preview}</p>}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
