import { saveReusableAudio } from "@/lib/storage/audio";
import { AppError, toErrorResponse } from "@/lib/errors";
import { requestEnglishSpeech } from "@/lib/ai/aiProvider";
import {
  consumeKnownAudioCacheMiss,
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
  const startedAt = performance.now();
  const url = new URL(request.url);
  const text = url.searchParams.get("text")?.trim() ?? "";
  const knownCacheMiss = consumeKnownAudioCacheMiss(
    url.searchParams.get("missToken"),
    text,
  );

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

  const cacheStartedAt = performance.now();
  const cachedUrl = knownCacheMiss
    ? null
    : await getEnglishAudioCacheUrl(text);
  const cacheLookupMs = Math.round(performance.now() - cacheStartedAt);

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

  const profile = getTtsProfile();
  let upstream: Response;
  let audioSource: "openai_tts" | "cloudflare_tts";
  let speechProfile = profile;
  const upstreamStartedAt = performance.now();

  try {
    const speech = await requestEnglishSpeech(text, profile);
    upstream = speech.response;
    audioSource = speech.source;
    speechProfile = speech.profile;
  } catch (error) {
    logEvent("error", "tts_stream_request_failed", {
      requestId,
      error,
    });
    const responseError =
      error instanceof AppError
        ? error
        : new AppError("TTS_FAILED", "Không thể truyền luồng âm thanh.", 502);
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }

  const reader = upstream.body!.getReader();
  const audioChunks: Uint8Array[] = [];
  const upstreamHeadersMs = Math.round(performance.now() - upstreamStartedAt);
  let firstChunkLogged = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          const audio = Buffer.concat(audioChunks);
          void saveReusableAudio(
            { text, ...speechProfile },
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

        if (!firstChunkLogged) {
          firstChunkLogged = true;
          logEvent("info", "tts_stream_first_chunk", {
            requestId,
            provider: speechProfile.provider,
            model: speechProfile.model,
            cacheLookupMs,
            upstreamHeadersMs,
            firstChunkMs: Math.round(performance.now() - startedAt),
          });
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
      "X-Audio-Source": audioSource,
      "Server-Timing": `cache;dur=${cacheLookupMs}, tts-headers;dur=${upstreamHeadersMs}`,
    },
  }), requestId);
}
