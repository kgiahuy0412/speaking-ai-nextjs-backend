import { saveReusableAudio } from "@/lib/storage/audio";
import {
  getEnglishAudioCacheUrl,
  getTtsProfile,
} from "@/lib/ai/tts";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const url = new URL(request.url);
  const text = url.searchParams.get("text")?.trim() ?? "";

  if (!text || text.length > 500) {
    return Response.json(
      {
        error: {
          code: "BAD_REQUEST",
          message: "Nội dung phát âm không hợp lệ.",
          requestId,
        },
      },
      { status: 400 },
    );
  }

  const cachedUrl = await getEnglishAudioCacheUrl(text);

  if (cachedUrl) {
    return withRequestId(new Response(null, {
      status: 307,
      headers: {
        Location: cachedUrl,
        "Cache-Control": "no-store",
        "X-Audio-Source": "cache",
      },
    }), requestId);
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return Response.json(
      {
        error: {
          code: "TTS_FAILED",
          message: "Backend chưa được cấu hình dịch vụ phát âm.",
          requestId,
        },
      },
      { status: 503 },
    );
  }

  const configuredTimeoutMs = Number(process.env.OPENAI_TTS_TIMEOUT_MS ?? 12000);
  const timeoutMs =
    Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : 12000;
  let upstream: Response;
  const profile = getTtsProfile();

  try {
    upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        voice: profile.voice,
        input: text,
        response_format: "mp3",
        speed: profile.speed,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    logEvent("error", "tts_stream_request_failed", {
      requestId,
      timeoutMs,
      error,
    });
    return withRequestId(Response.json(
      {
        error: {
          code: "TTS_FAILED",
          message: "Dịch vụ phát âm phản hồi quá chậm.",
          requestId,
        },
      },
      { status: 504 },
    ), requestId);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    logEvent("error", "tts_stream_failed", {
      requestId,
      status: upstream.status,
      detail: detail.slice(0, 300),
    });

    return withRequestId(Response.json(
      {
        error: {
          code: "TTS_FAILED",
          message: "Không thể truyền luồng âm thanh.",
          requestId,
        },
      },
      { status: 502 },
    ), requestId);
  }

  const reader = upstream.body.getReader();
  const audioChunks: Uint8Array[] = [];
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          const audio = Buffer.concat(audioChunks);
          void saveReusableAudio(
            { text, ...profile },
            audio.buffer.slice(
              audio.byteOffset,
              audio.byteOffset + audio.byteLength,
            ),
          ).catch((error) => {
            logEvent("error", "tts_cache_write_failed", {
              requestId,
              error,
            });
          });
          return;
        }

        audioChunks.push(value);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void reader.cancel();
    },
  });

  return withRequestId(new Response(stream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Audio-Source": "openai_tts",
    },
  }), requestId);
}
