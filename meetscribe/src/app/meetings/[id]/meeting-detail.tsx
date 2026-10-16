"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  DownloadIcon,
  GavelIcon,
  ListChecksIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TranscriptView, speakerColor } from "@/components/transcript-view";
import { formatClock, speakerName, toMarkdown, toSrt, toTxt } from "@/lib/transcript";
import type { Meeting } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SOURCE_LABEL } from "../../meeting-list";

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "meeting";

export function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [query, setQuery] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const autoSummarized = useRef(false);

  const load = useCallback(
    () =>
      fetch(`/api/meetings/${id}`).then(async (res) => {
        if (res.status === 404) setNotFound(true);
        else setMeeting(await res.json());
      }),
    [id],
  );

  useEffect(() => {
    load().catch(() => toast.error("Không tải được cuộc họp"));
  }, [load]);

  // File upload đang được xử lý nền: poll tới khi xong
  useEffect(() => {
    if (meeting?.status !== "processing") return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [meeting?.status, load]);

  const summarize = useCallback(async () => {
    setSummarizing(true);
    setSummaryError(null);
    try {
      const res = await fetch(`/api/meetings/${id}/summarize`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Tóm tắt thất bại");
      setMeeting(body);
    } catch (err) {
      setSummaryError((err as Error).message);
    } finally {
      setSummarizing(false);
    }
  }, [id]);

  // Lần đầu mở cuộc họp đã có transcript mà chưa có tóm tắt: tự chạy
  useEffect(() => {
    if (meeting?.status === "ready" && !meeting.summary && meeting.segments.length && !autoSummarized.current) {
      autoSummarized.current = true;
      void summarize();
    }
  }, [meeting, summarize]);

  async function patch(body: Partial<Pick<Meeting, "title" | "speakers">>) {
    const res = await fetch(`/api/meetings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return toast.error("Lưu thất bại");
    setMeeting(await res.json());
  }

  async function remove() {
    if (!confirm("Xoá cuộc họp này?")) return;
    await fetch(`/api/meetings/${id}`, { method: "DELETE" });
    router.push("/");
  }

  if (notFound) {
    return (
      <div className="py-20 text-center">
        <p className="mb-4">Không tìm thấy cuộc họp.</p>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          Về danh sách
        </Link>
      </div>
    );
  }
  if (!meeting) {
    return (
      <div className="flex justify-center py-20 text-muted-foreground">
        <Loader2Icon className="animate-spin" />
      </div>
    );
  }

  const source = SOURCE_LABEL[meeting.source];
  const speakers = [...new Set(meeting.segments.map((s) => s.speaker))];
  const nameOf = (s: string) => speakerName(meeting, s);
  const s = meeting.summary;
  const fileBase = slug(meeting.title);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-4" /> Cuộc họp
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          {editingTitle ? (
            <Input
              autoFocus
              defaultValue={meeting.title}
              className="h-9 max-w-xl text-lg font-semibold"
              onBlur={(e) => {
                setEditingTitle(false);
                const title = e.target.value.trim();
                if (title && title !== meeting.title) void patch({ title });
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          ) : (
            <button type="button" onClick={() => setEditingTitle(true)} className="group flex items-center gap-2 text-left">
              <h1 className="text-2xl font-semibold">{meeting.title}</h1>
              <PencilIcon className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100" />
            </button>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => download(`${fileBase}.md`, toMarkdown(meeting), "text/markdown")}>
              <DownloadIcon /> Markdown
            </Button>
            <Button variant="outline" size="sm" onClick={() => download(`${fileBase}.txt`, toTxt(meeting), "text/plain")}>
              <DownloadIcon /> TXT
            </Button>
            <Button variant="outline" size="sm" onClick={() => download(`${fileBase}.srt`, toSrt(meeting), "application/x-subrip")}>
              <DownloadIcon /> SRT
            </Button>
            <Button variant="ghost" size="sm" onClick={remove} aria-label="Xoá">
              <Trash2Icon />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">
            <source.icon />
            {source.label}
          </Badge>
          <span>{new Date(meeting.createdAt).toLocaleString("vi-VN")}</span>
          <span>· {formatClock(meeting.durationSec * 1000)}</span>
          {speakers.length > 0 && <span>· {speakers.length} người nói:</span>}
          {speakers.map((sp) => (
            <button
              key={sp}
              type="button"
              onClick={() => {
                setRenaming(sp);
                setRenameValue(meeting.speakers[sp] ?? "");
              }}
              className={cn("rounded-full border px-2 py-0.5 text-xs font-medium hover:bg-muted", speakerColor(sp))}
              title="Đổi tên"
            >
              {nameOf(sp)}
            </button>
          ))}
        </div>
      </div>

      {meeting.status === "processing" ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <Loader2Icon className="size-8 animate-spin text-primary" />
            <p className="font-medium">Đang chuyển file “{meeting.fileName}” thành transcript…</p>
            <p className="text-sm text-muted-foreground">File dài vài chục phút thường mất khoảng 1–2 phút.</p>
          </CardContent>
        </Card>
      ) : meeting.status === "error" ? (
        <Card className="border-destructive/40">
          <CardContent className="py-10 text-center text-sm">
            <p className="font-medium text-destructive">Xử lý thất bại</p>
            <p className="text-muted-foreground">{meeting.error}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_380px]">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Transcript</CardTitle>
              <CardAction>
                <div className="relative">
                  <SearchIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Tìm trong transcript"
                    className="h-8 w-56 pl-8"
                  />
                </div>
              </CardAction>
            </CardHeader>
            <CardContent className="py-4">
              <TranscriptView
                segments={meeting.segments}
                nameOf={nameOf}
                query={query}
                onSpeakerClick={(sp) => {
                  setRenaming(sp);
                  setRenameValue(meeting.speakers[sp] ?? "");
                }}
              />
            </CardContent>
          </Card>

          <Card className="lg:sticky lg:top-20">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2">
                <SparklesIcon className="size-4 text-primary" /> Biên bản AI
              </CardTitle>
              <CardAction>
                <Button variant="ghost" size="icon-sm" onClick={summarize} disabled={summarizing} aria-label="Tạo lại">
                  <RefreshCwIcon className={cn(summarizing && "animate-spin")} />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-5 py-4 text-sm">
              {summarizing && !s ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" /> Đang tóm tắt cuộc họp…
                </div>
              ) : summaryError && !s ? (
                <div className="space-y-2">
                  <p className="text-destructive">{summaryError}</p>
                  <Button size="sm" variant="outline" onClick={summarize}>
                    Thử lại
                  </Button>
                </div>
              ) : s ? (
                <>
                  <p className="leading-relaxed">{s.tldr}</p>
                  <SummaryList icon={CheckCircle2Icon} title="Ý chính" items={s.keyPoints} />
                  <SummaryList icon={GavelIcon} title="Quyết định" items={s.decisions} />
                  {s.actionItems.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="flex items-center gap-2 font-semibold">
                        <ListChecksIcon className="size-4 text-primary" /> Việc cần làm
                      </h3>
                      <ul className="space-y-2">
                        {s.actionItems.map((a, i) => (
                          <li key={i} className="flex gap-2 rounded-md border p-2">
                            <input type="checkbox" className="mt-1 accent-primary" />
                            <div>
                              <p>{a.task}</p>
                              {(a.owner || a.due) && (
                                <p className="text-xs text-muted-foreground">
                                  {[a.owner, a.due && `hạn ${a.due}`].filter(Boolean).join(" · ")}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  <SummaryList icon={CircleHelpIcon} title="Câu hỏi mở" items={s.openQuestions} />
                </>
              ) : (
                <p className="text-muted-foreground">Chưa có tóm tắt.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Đổi tên người nói</DialogTitle>
            <DialogDescription>Tên mới áp dụng cho mọi đoạn của {renaming && nameOf(renaming)}.</DialogDescription>
          </DialogHeader>
          <form
            id="rename"
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming) void patch({ speakers: { [renaming]: renameValue.trim() } });
              setRenaming(null);
            }}
          >
            <Input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} placeholder="Ví dụ: Anh Nam" />
          </form>
          <DialogFooter>
            <Button type="submit" form="rename">
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryList({ icon: Icon, title, items }: { icon: typeof GavelIcon; title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 font-semibold">
        <Icon className="size-4 text-primary" /> {title}
      </h3>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
