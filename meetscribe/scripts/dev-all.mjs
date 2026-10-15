// Chạy cả ASR server (../asr-server, cổng 8000) và web app (cổng 3000) bằng một lệnh:
//   npm run dev:all
// Ctrl+C dừng cả hai. Nếu ASR server đã chạy sẵn thì chỉ bật web.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asrDir = path.resolve(root, "..", "asr-server");
const isWin = process.platform === "win32";
const python = path.join(asrDir, ".venv", isWin ? "Scripts/python.exe" : "bin/python");
const children = [];

// critical: tiến trình này dừng thì dừng hết. ASR server dừng thì web vẫn chạy và trang Ghi báo "chưa chạy".
function run(name, color, command, args, cwd, critical) {
  const child = spawn(command, args, {
    cwd,
    shell: isWin && command === "npm",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", FORCE_COLOR: "1" },
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}đã dừng (mã ${code ?? "?"})`);
    if (critical) shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // Windows: npm tạo tiến trình con riêng, phải kill cả cây
    if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function asrAlreadyRunning() {
  try {
    const res = await fetch("http://localhost:8000/health", { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (await asrAlreadyRunning()) {
  console.log("[asr] đã chạy sẵn ở cổng 8000, chỉ bật web");
} else if (!existsSync(python)) {
  console.error(
    [
      "Chưa cài ASR server. Chạy 1 lần trong thư mục asr-server:",
      "  python -m venv .venv",
      `  ${isWin ? ".venv\\Scripts\\pip" : ".venv/bin/pip"} install -r requirements.txt`,
      `  ${isWin ? ".venv\\Scripts\\python" : ".venv/bin/python"} scripts/download_models.py`,
      "Sau đó chạy lại: npm run dev:all",
    ].join("\n"),
  );
  process.exit(1);
} else {
  run("asr", 36, python, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000"], asrDir, false);
}
run("web", 35, "npm", ["run", "dev"], root, true);
