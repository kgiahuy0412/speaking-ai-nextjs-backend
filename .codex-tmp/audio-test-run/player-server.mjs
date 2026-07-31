import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  "D:/Code/HuaMei/App_noi/GHI ÂM GIỌNG TRẺ EM/GHI ÂM GIỌNG TRẺ EM/MIỀN BẮC",
);
const port = 8765;

const mimeTypes = {
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resolveAudio(relativePath) {
  const resolved = path.resolve(root, relativePath);
  const rootPrefix = `${root}${path.sep}`;
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error("Path outside the configured audio directory");
  }
  return resolved;
}

async function listAudioFiles(directory = root, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listAudioFiles(fullPath, relativePath)));
      continue;
    }
    if (mimeTypes[path.extname(entry.name).toLowerCase()]) {
      const stat = await fs.stat(fullPath);
      files.push({ relativePath, bytes: stat.size });
    }
  }

  return files;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function serveMedia(request, response, relativePath) {
  const filePath = resolveAudio(relativePath);
  const stat = await fs.stat(filePath);
  const mimeType = mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = request.headers.range;

  if (!range) {
    response.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    "Content-Type": mimeType,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath, { start, end }).pipe(response);
}

function playerHtml(relativePath) {
  const safeName = escapeHtml(relativePath);
  const mediaUrl = `/media?file=${encodeURIComponent(relativePath)}`;
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Audio test player</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #172033; background: #f6f8fb; }
    main { max-width: 760px; padding: 24px; border: 1px solid #d8e0ea; border-radius: 12px; background: white; }
    h1 { margin-top: 0; font-size: 22px; }
    code { display: block; overflow-wrap: anywhere; padding: 12px; border-radius: 8px; background: #eef3f8; }
    audio { width: 100%; margin: 20px 0; }
    button { padding: 12px 22px; border: 0; border-radius: 8px; color: white; background: #174a7e; font-size: 16px; font-weight: 700; cursor: pointer; }
    #status { margin-left: 12px; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Trình phát audio kiểm thử</h1>
    <code id="file">${safeName}</code>
    <audio id="audio" preload="auto" controls src="${mediaUrl}"></audio>
    <div><button id="play" type="button">Phát audio</button><span id="status">Sẵn sàng</span></div>
  </main>
  <script>
    const audio = document.getElementById("audio");
    const status = document.getElementById("status");
    document.getElementById("play").addEventListener("click", async () => {
      audio.currentTime = 0;
      await audio.play();
    });
    audio.addEventListener("play", () => { status.textContent = "Đang phát"; });
    audio.addEventListener("ended", () => { status.textContent = "Đã phát xong"; });
    audio.addEventListener("error", () => { status.textContent = "Lỗi phát audio"; });
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true, root });
      return;
    }
    if (url.pathname === "/manifest") {
      const files = await listAudioFiles();
      files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "vi", { numeric: true }));
      sendJson(response, 200, { count: files.length, files });
      return;
    }
    if (url.pathname === "/media") {
      await serveMedia(request, response, url.searchParams.get("file") ?? "");
      return;
    }
    if (url.pathname === "/player") {
      const relativePath = url.searchParams.get("file") ?? "";
      resolveAudio(relativePath);
      const body = playerHtml(relativePath);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Audio test player listening on http://127.0.0.1:${port}`);
});
