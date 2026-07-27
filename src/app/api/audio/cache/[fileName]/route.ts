import path from "node:path";
import { readGeneratedAudioFile } from "@/lib/storage/audio";

export const runtime = "nodejs";

type AudioCacheRouteContext = {
  params: Promise<{ fileName: string }>;
};

type AudioByteRange = {
  start: number;
  end: number;
};

function audioContentType(fileName: string) {
  return path.extname(fileName).toLowerCase() === ".mp3"
    ? "audio/mpeg"
    : "application/octet-stream";
}

function parseByteRange(
  rangeHeader: string | null,
  totalBytes: number,
): AudioByteRange | null | "invalid" {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || totalBytes <= 0) {
    return "invalid";
  }

  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) {
    return "invalid";
  }

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "invalid";
    }
    return {
      start: Math.max(0, totalBytes - suffixLength),
      end: totalBytes - 1,
    };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : totalBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= totalBytes
  ) {
    return "invalid";
  }

  return {
    start,
    end: Math.min(requestedEnd, totalBytes - 1),
  };
}

async function serveCachedAudio(
  request: Request,
  context: AudioCacheRouteContext,
  includeBody: boolean,
) {
  const { fileName } = await context.params;
  const audio = await readGeneratedAudioFile(fileName);

  if (!audio) {
    return Response.json(
      {
        error: {
          code: "AUDIO_NOT_FOUND",
          message: "Không tìm thấy tệp âm thanh.",
        },
      },
      { status: 404 },
    );
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": audioContentType(fileName),
    "X-Content-Type-Options": "nosniff",
  });
  const range = parseByteRange(request.headers.get("range"), audio.byteLength);

  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${audio.byteLength}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    const body = audio.subarray(range.start, range.end + 1);
    headers.set(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${audio.byteLength}`,
    );
    headers.set("Content-Length", body.byteLength.toString());
    return new Response(includeBody ? new Uint8Array(body) : null, {
      status: 206,
      headers,
    });
  }

  headers.set("Content-Length", audio.byteLength.toString());
  return new Response(includeBody ? new Uint8Array(audio) : null, { headers });
}

export async function GET(
  request: Request,
  context: AudioCacheRouteContext,
) {
  return serveCachedAudio(request, context, true);
}

export async function HEAD(
  request: Request,
  context: AudioCacheRouteContext,
) {
  return serveCachedAudio(request, context, false);
}
