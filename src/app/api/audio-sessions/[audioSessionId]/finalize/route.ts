import { createHash } from "node:crypto";
import { runConversationPipeline } from "@/lib/ai/pipeline";
import { scheduleConversationPostResponseTasks } from "@/lib/ai/postResponseTasks";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  AudioUploadError,
  claimAudioSessionFinalize,
  completeAudioSessionFinalize,
  finalizeAudioUploadSession,
  releaseAudioSessionFinalize,
  type Pcm16WavMetadata,
} from "@/lib/storage/audioSessions";
import type {
  AsrMode,
  BenchmarkMetadata,
  PracticeContext,
} from "@/types/conversation";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ audioSessionId: string }>;
};

type FinalizeRequest = {
  clientId?: string;
  context?: PracticeContext;
  childAge?: number;
  sessionId?: string;
  sourceText?: string;
  asrMode?: AsrMode;
  mimeType?: string;
  pcm16Wav?: Pcm16WavMetadata;
  benchmark?: BenchmarkMetadata;
};

const validContexts = new Set<PracticeContext>([
  "home",
  "school",
  "outside",
]);

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const { audioSessionId } = await context.params;
  let requestHash = "";
  let finalizeClaimed = false;

  try {
    const rawBody = await request.text();
    requestHash = createHash("sha256").update(rawBody).digest("hex");
    const body = JSON.parse(rawBody) as FinalizeRequest;

    const claim = await claimAudioSessionFinalize(audioSessionId, requestHash);

    if (claim.state === "completed") {
      logEvent("info", "audio_session_finalize_replayed", {
        requestId,
        audioSessionId,
      });
      return withRequestId(Response.json(claim.result), requestId);
    }

    if (claim.state === "in_progress") {
      throw new AppError(
        "RATE_LIMITED",
        "Audio session đang được xử lý. Vui lòng thử lại sau.",
        409,
      );
    }

    finalizeClaimed = true;

    if (!body.context || !validContexts.has(body.context)) {
      throw new AppError("BAD_REQUEST", "Vui lòng chọn ngữ cảnh hợp lệ.");
    }

    const requestedAsrMode =
      body.asrMode === "browser_streaming"
        ? "browser_streaming"
        : "batch_chunks";
    const asrMode =
      requestedAsrMode === "browser_streaming" && body.sourceText?.trim()
        ? "browser_streaming"
        : "batch_chunks";
    let audioFile: File | undefined;

    if (!(asrMode === "browser_streaming" && body.sourceText?.trim())) {
      audioFile = await finalizeAudioUploadSession(
        audioSessionId,
        body.mimeType,
        body.pcm16Wav,
      );
    }

    const result = await runConversationPipeline(
      {
        requestId,
        clientId: body.clientId?.trim() || undefined,
        context: body.context,
        childAge: body.childAge ?? 6,
        targetLanguage: "en",
        sessionId: body.sessionId,
        sourceText: body.sourceText?.trim(),
        audioFile,
        asrMode,
        benchmark: body.benchmark,
      },
      { deferTextCacheWrite: true },
    );

    const responsePayload = { ...result, learning: null };
    await completeAudioSessionFinalize(
      audioSessionId,
      requestHash,
      responsePayload,
    );
    scheduleConversationPostResponseTasks(result, "audio");
    return withRequestId(Response.json(responsePayload), requestId);
  } catch (error) {
    if (finalizeClaimed && requestHash) {
      await releaseAudioSessionFinalize(audioSessionId, requestHash).catch(
        (releaseError) => {
          logEvent("error", "audio_session_finalize_release_failed", {
            requestId,
            audioSessionId,
            releaseError,
          });
        },
      );
    }

    logEvent("warn", "audio_session_finalize_failed", {
      requestId,
      audioSessionId,
      error,
    });
    const responseError =
      error instanceof AudioUploadError
        ? new AppError("BAD_REQUEST", error.message, error.status)
        : error;
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}
