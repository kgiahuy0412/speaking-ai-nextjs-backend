import path from "node:path";
import { readGeneratedAudioFile } from "@/lib/storage/audio";

export const runtime = "nodejs";

type AudioCacheRouteContext = {
  params: Promise<{ fileName: string }>;
};

function audioContentType(fileName: string) {
  return path.extname(fileName).toLowerCase() === ".mp3"
    ? "audio/mpeg"
    : "application/octet-stream";
}

async function serveCachedAudio(
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

  return new Response(includeBody ? new Uint8Array(audio) : null, {
    headers: {
      "Content-Type": audioContentType(fileName),
      "Content-Length": audio.byteLength.toString(),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  _request: Request,
  context: AudioCacheRouteContext,
) {
  return serveCachedAudio(context, true);
}

export async function HEAD(
  _request: Request,
  context: AudioCacheRouteContext,
) {
  return serveCachedAudio(context, false);
}
