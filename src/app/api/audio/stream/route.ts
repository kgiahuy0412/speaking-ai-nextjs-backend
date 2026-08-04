import { after } from "next/server";
import { AppError, toErrorResponse } from "@/lib/errors";
import { requestEnglishSpeech } from "@/lib/ai/aiProvider";
import {
  claimEnglishAudioCacheFill,
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
export const maxDuration = 60;

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
  const cacheFillClaim = claimEnglishAudioCacheFill(text);

  if (!cacheFillClaim.owner) {
    try {
      const result = await cacheFillClaim.completion;
      logEvent("info", "tts_cache_fill_joined", {
        requestId,
        audioUrl: result.audioUrl,
        latencyMs: Math.round(performance.now() - startedAt),
      });
      return withRequestId(new Response(null, {
        status: 307,
        headers: {
          Location: result.audioUrl,
          "Cache-Control": "no-store",
          "X-Audio-Source": "cache",
        },
      }), requestId);
    } catch (error) {
      logEvent("error", "tts_cache_fill_join_failed", { requestId, error });
      const responseError =
        error instanceof AppError
          ? error
          : new AppError("TTS_FAILED", "Không thể tạo âm thanh.", 502);
      return withRequestId(toErrorResponse(responseError, requestId), requestId);
    }
  }

  let upstream: Response;
  let audioSource: "cloudflare_tts";
  let speechProfile = profile;
  const upstreamStartedAt = performance.now();

  try {
    const speech = await requestEnglishSpeech(text, profile);
    upstream = speech.response;
    audioSource = speech.source;
    speechProfile = speech.profile;
  } catch (error) {
    cacheFillClaim.fail(error);
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

  const cacheFillStartedAt = performance.now();
  const cacheFill = cacheFillClaim.cacheResponse(
    {
      response: upstream,
      source: audioSource,
      profile: speechProfile,
    },
    true,
  );
  logEvent("info", "tts_cache_fill_started", {
    requestId,
    provider: speechProfile.provider,
    model: speechProfile.model,
    independentFromClient: true,
  });
  after(async () => {
    try {
      const result = await cacheFill;
      logEvent("info", "tts_cache_fill_completed", {
        requestId,
        provider: speechProfile.provider,
        model: speechProfile.model,
        audioUrl: result.audioUrl,
        byteLength: result.byteLength,
        independentFromClient: true,
        latencyMs: Math.round(performance.now() - cacheFillStartedAt),
      });
    } catch (error) {
      logEvent("error", "tts_cache_fill_failed", {
        requestId,
        provider: speechProfile.provider,
        model: speechProfile.model,
        independentFromClient: true,
        error,
      });
    }
  });

  const reader = upstream.body!.getReader();
  const upstreamHeadersMs = Math.round(performance.now() - upstreamStartedAt);
  let firstChunkLogged = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
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
      "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Audio-Source": audioSource,
      "Server-Timing": `cache;dur=${cacheLookupMs}, tts-headers;dur=${upstreamHeadersMs}`,
    },
  }), requestId);
}
