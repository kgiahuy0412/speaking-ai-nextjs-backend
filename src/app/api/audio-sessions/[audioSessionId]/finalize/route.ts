import { createHash } from "node:crypto";
import { after } from "next/server";
import { transcribeVietnamese } from "@/lib/ai/asr";
import { transcribeAudioSessionOnce } from "@/lib/ai/audioSessionAsr";
import {
  getLatestTerminalAudioSessionPipelineFlight,
  prepareAudioSessionPipelineOnce,
  type PreparedAudioSessionPipeline,
} from "@/lib/ai/audioSessionPipeline";
import {
  type BatchPrefetchCandidate,
  getBatchPrefetchCandidate,
  getLatestBatchPrefetchCandidate,
  removeBatchPrefetchCandidate,
  waitForNextBatchPrefetchCandidate,
} from "@/lib/ai/batchPrefetch";
import { normalizeVietnameseForExactMatch } from "@/lib/ai/exactRules";
import {
  completePreparedConversationPipeline,
  runConversationPipeline,
} from "@/lib/ai/pipeline";
import { scheduleConversationPostResponseTasks } from "@/lib/ai/postResponseTasks";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  type AudioAssemblySource,
  AudioUploadError,
  claimAudioSessionFinalize,
  completeAudioSessionFinalize,
  finalizeAudioUploadSession,
  releaseAudioSessionFinalize,
  validateAudioSessionPrefetchTail,
  type Pcm16WavMetadata,
} from "@/lib/storage/audioSessions";
import {
  authorizeAudioSessionRequest,
  consumeAudioUploadRateLimit,
} from "@/lib/storage/audioSessionSecurity";
import type {
  ApiErrorCode,
  AsrMode,
  BenchmarkMetadata,
  ConversationRequest,
  ConversationResponse,
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
  prefetchId?: string;
  benchmark?: BenchmarkMetadata;
};

const validContexts = new Set<PracticeContext>([
  "home",
  "school",
  "outside",
]);

function publicAudioUploadError(error: AudioUploadError) {
  const code: ApiErrorCode =
    error.code === "MISSING_CHUNKS"
      ? "AUDIO_CHUNKS_MISSING"
      : error.code === "CHUNK_CONFLICT"
        ? "AUDIO_CHUNK_CONFLICT"
        : error.code === "CHUNK_CHECKSUM_MISMATCH"
          ? "AUDIO_CHUNK_CHECKSUM_MISMATCH"
          : error.code === "SESSION_EXPIRED"
            ? "AUDIO_SESSION_EXPIRED"
            : error.code === "CHUNK_TOO_LARGE" ||
                error.code === "SESSION_TOO_LARGE" ||
                error.code === "TOO_MANY_CHUNKS"
              ? "AUDIO_UPLOAD_LIMIT"
              : "AUDIO_SESSION_INVALID";
  return new AppError(code, error.message, error.status, error.details);
}

export async function POST(request: Request, context: RouteContext) {
  const requestId = getRequestId(request);
  const startedAt = performance.now();
  const { audioSessionId } = await context.params;
  let requestHash = "";
  let finalizeClaimed = false;
  let claimMs = 0;
  let assembleMs = 0;
  let pipelineMs = 0;
  let prefetchValidationMs = 0;
  let cancelCandidateWait: (() => void) | undefined;
  let candidateMonitorCancelled = false;
  let activeCandidateMonitorPromise:
    | Promise<BatchPrefetchCandidate | undefined>
    | undefined;

  try {
    const uploadClaims = authorizeAudioSessionRequest(request, audioSessionId);
    const retryAfter = consumeAudioUploadRateLimit(
      request,
      "session",
      audioSessionId,
    );
    if (retryAfter !== null) {
      return withRequestId(
        Response.json(
          {
            error: {
              code: "RATE_LIMITED",
              message:
                "Audio session gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
              requestId,
            },
          },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        ),
        requestId,
      );
    }
    const rawBody = await request.text();
    requestHash = createHash("sha256").update(rawBody).digest("hex");
    const body = JSON.parse(rawBody) as FinalizeRequest;
    if (
      uploadClaims &&
      ((uploadClaims.encoding === "pcm_s16le" && !body.pcm16Wav) ||
        (uploadClaims.encoding === "encoded_audio" && body.pcm16Wav))
    ) {
      throw new AppError(
        "AUDIO_SESSION_INVALID",
        "Kiểu finalize không khớp cấu hình audio session.",
        400,
      );
    }
    if (uploadClaims && body.pcm16Wav) {
      const pcm = body.pcm16Wav;
      const durationMs =
        (pcm.pcmByteLength /
          (pcm.sampleRate * pcm.channelCount * (pcm.bitsPerSample / 8))) *
        1_000;
      if (
        pcm.channelCount !== uploadClaims.channelCount ||
        pcm.bitsPerSample !== uploadClaims.bitsPerSample ||
        !Number.isFinite(durationMs) ||
        durationMs >
          uploadClaims.maxDurationMs + uploadClaims.sourceChunkDurationMs ||
        (pcm.chunkCount !== undefined &&
          (!Number.isInteger(pcm.chunkCount) ||
            pcm.chunkCount <= 0 ||
            pcm.chunkCount > uploadClaims.maxChunks))
      ) {
        throw new AppError(
          "AUDIO_SESSION_INVALID",
          "Metadata PCM không khớp upload token của audio session.",
          400,
        );
      }
    }

    const claimStartedAt = performance.now();
    const claim = await claimAudioSessionFinalize(audioSessionId, requestHash);
    claimMs = Math.round(performance.now() - claimStartedAt);

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

    const practiceContext = body.context;
    const requestedAsrMode =
      body.asrMode === "browser_streaming"
        ? "browser_streaming"
        : "batch_chunks";
    const asrMode =
      requestedAsrMode === "browser_streaming" && body.sourceText?.trim()
        ? "browser_streaming"
        : "batch_chunks";
    let audioFile: File | undefined;
    let assemblySource: AudioAssemblySource | undefined;
    let prefetchedSourceText: string | undefined;
    let batchPrefetchUsed = false;
    let prefetchTail:
      | Awaited<ReturnType<typeof validateAudioSessionPrefetchTail>>
      | undefined;
    let prefetchCandidate = getBatchPrefetchCandidate(
      body.prefetchId?.trim(),
      audioSessionId,
    );
    let prefetchCandidateOrigin:
      | "explicit"
      | "latest"
      | "joined"
      | undefined = prefetchCandidate ? "explicit" : undefined;
    let prefetchJoinMs = 0;
    let prefetchJoinState: "latest" | "joined" | "none" = "none";
    let prefetchRaceWinner:
      | "prefetch"
      | "asr"
      | "late_prefetch"
      | "terminal_pipeline"
      | "pipeline"
      | "browser_streaming" = "browser_streaming";
    let prefetchRaceMs = 0;
    let hedgedAsrLatencyMs: number | undefined;
    let hedgedAsrWaitMs: number | undefined;
    let hedgedAsrSharedFlightJoined: boolean | undefined;
    let hedgedAsrUsed = false;
    let preparedPipelineSharedFlightJoined: boolean | undefined;
    let terminalPipelineAgeMs: number | undefined;
    let terminalPipelineTailEligible: boolean | undefined;
    let terminalPipelineSharedFlightJoined: boolean | undefined;
    let terminalPreparedPipeline: PreparedAudioSessionPipeline | undefined;
    let terminalPipelinePromise:
      | Promise<PreparedAudioSessionPipeline>
      | undefined;
    let supersededPipelinePromise: Promise<unknown> | undefined;
    let preparedPipelinePromise:
      | ReturnType<typeof prepareAudioSessionPipelineOnce>
      | undefined;
    let hedgedAsrPromise:
      | Promise<
          | {
              ok: true;
              sourceText: string;
              latencyMs: number;
              waitLatencyMs: number;
              joined: boolean;
            }
          | {
              ok: false;
              error: unknown;
              latencyMs: number;
              waitLatencyMs: number;
              joined: boolean;
            }
        >
      | undefined;

    if (asrMode === "batch_chunks") {
      const assembleStartedAt = performance.now();
      audioFile = await finalizeAudioUploadSession(
        audioSessionId,
        body.mimeType,
        body.pcm16Wav,
        {
          onAssemblySource: (source) => {
            assemblySource = source;
          },
        },
      );
      assembleMs = Math.round(performance.now() - assembleStartedAt);

      if (!body.pcm16Wav) {
        throw new AppError(
          "AUDIO_SESSION_INVALID",
          "Thiếu metadata PCM khi finalize Batch Chunks.",
          400,
        );
      }
      hedgedAsrPromise = transcribeAudioSessionOnce({
        audioSessionId,
        snapshot: body.pcm16Wav,
        transcribe: () =>
          transcribeVietnamese({
            requestId,
            clientId: body.clientId?.trim() || undefined,
            context: practiceContext,
            childAge: body.childAge ?? 6,
            targetLanguage: "en",
            sessionId: body.sessionId,
            audioFile,
            asrMode: "batch_chunks",
            benchmark: { ...body.benchmark },
          }),
      }).then(
        (shared) => ({
          ok: true as const,
          sourceText: shared.sourceText,
          latencyMs: shared.asrLatencyMs,
          waitLatencyMs: shared.waitLatencyMs,
          joined: shared.joined,
        }),
        (error: unknown) => ({
          ok: false as const,
          error,
          latencyMs: 0,
          waitLatencyMs: 0,
          joined: false,
        }),
      );
      preparedPipelinePromise = prepareAudioSessionPipelineOnce({
        audioSessionId,
        snapshot: body.pcm16Wav,
        request: {
          requestId,
          clientId: body.clientId?.trim() || undefined,
          context: practiceContext,
          childAge: body.childAge ?? 6,
          targetLanguage: "en",
          sessionId: body.sessionId,
          audioFile,
          asrMode: "batch_chunks",
          benchmark: { ...body.benchmark },
        },
      });
      // A validated older prefetch may win first. Keep a rejection observer on
      // the exact-snapshot preparation until it is either used or awaited in
      // the post-response task.
      void preparedPipelinePromise.catch(() => undefined);

      // The terminal preview normally represents the same speech plus only a
      // short silent tail. Registering happens before preview ASR starts, so
      // finalize can join the complete in-flight ASR -> text -> audio promise
      // instead of waiting until the preview route has saved a candidate.
      const terminalFlight = getLatestTerminalAudioSessionPipelineFlight({
        audioSessionId,
        context: practiceContext,
        childAge: body.childAge ?? 6,
      });
      if (
        terminalFlight &&
        terminalFlight.snapshot.chunkCount !== undefined &&
        body.pcm16Wav.chunkCount !== undefined &&
        terminalFlight.snapshot.chunkCount <= body.pcm16Wav.chunkCount &&
        terminalFlight.snapshot.pcmByteLength <=
          body.pcm16Wav.pcmByteLength
      ) {
        terminalPipelineAgeMs = Math.max(
          0,
          Date.now() - terminalFlight.startedAt,
        );
        const validationStartedAt = performance.now();
        const terminalTail = await validateAudioSessionPrefetchTail(
          audioSessionId,
          terminalFlight.snapshot as Pcm16WavMetadata & {
            chunkCount: number;
          },
          body.pcm16Wav as Pcm16WavMetadata & { chunkCount: number },
          body.benchmark?.initialNoiseRms,
        );
        const terminalValidationMs = Math.round(
          performance.now() - validationStartedAt,
        );
        prefetchValidationMs += terminalValidationMs;
        terminalPipelineTailEligible = terminalTail.eligible;
        assemblySource = terminalTail.assemblySource;
        if (terminalTail.eligible) {
          terminalPipelinePromise = terminalFlight.promise;
          void terminalPipelinePromise.catch(() => undefined);
        }
        logEvent("info", "audio_session_terminal_pipeline_validated", {
          requestId,
          audioSessionId,
          eligible: terminalTail.eligible,
          reason: terminalTail.reason,
          terminalPipelineAgeMs,
          terminalValidationMs,
          tailDurationMs: terminalTail.tailDurationMs,
          activeFrameRatio: terminalTail.activeFrameRatio,
          longestSpeechRunMs: terminalTail.longestSpeechRunMs,
          snapshotChunkCount: terminalFlight.snapshot.chunkCount,
          finalChunkCount: body.pcm16Wav.chunkCount,
          assemblySource: terminalTail.assemblySource,
        });
      }
    }

    const requiredPrefetchStability = 1;
    const excludedCandidateIds = new Set<string>();

    const validatePrefetchCandidate = async (
      candidate: BatchPrefetchCandidate,
      origin: "explicit" | "latest" | "joined",
    ) => {
      prefetchCandidate = candidate;
      prefetchCandidateOrigin = origin;
      excludedCandidateIds.add(candidate.id);
      if (
        asrMode !== "batch_chunks" ||
        candidate.stabilityCount < requiredPrefetchStability ||
        candidate.context !== body.context ||
        candidate.childAge !== (body.childAge ?? 6) ||
        body.pcm16Wav?.chunkCount === undefined
      ) {
        return false;
      }
      const validationStartedAt = performance.now();
      prefetchTail = await validateAudioSessionPrefetchTail(
        audioSessionId,
        candidate.snapshot,
        body.pcm16Wav as Pcm16WavMetadata & { chunkCount: number },
        body.benchmark?.initialNoiseRms,
      );
      prefetchValidationMs += Math.round(
        performance.now() - validationStartedAt,
      );
      if (prefetchTail.eligible) {
        prefetchedSourceText = candidate.sourceText;
      }
      assemblySource = prefetchTail.assemblySource;
      logEvent("info", "audio_session_prefetch_validated", {
        requestId,
        audioSessionId,
        candidateOrigin: origin,
        terminalSnapshot: candidate.terminalSnapshot,
        eligible: prefetchTail.eligible,
        reason: prefetchTail.reason,
        stabilityCount: candidate.stabilityCount,
        requiredStability: requiredPrefetchStability,
        prefetchAgeMs: Date.now() - candidate.createdAt,
        prefetchValidationMs,
        tailDurationMs: prefetchTail.tailDurationMs,
        tailRms: prefetchTail.tailRms,
        activeFrameRatio: prefetchTail.activeFrameRatio,
        longestSpeechRunMs: prefetchTail.longestSpeechRunMs,
        noiseFloorRms: prefetchTail.noiseFloorRms,
        speechThresholdRms: prefetchTail.speechThresholdRms,
        assemblySource: prefetchTail.assemblySource,
      });
      return prefetchTail.eligible;
    };

    if (!prefetchCandidate && asrMode === "batch_chunks") {
      prefetchCandidate = getLatestBatchPrefetchCandidate(audioSessionId);
      if (prefetchCandidate) prefetchCandidateOrigin = "latest";
    }
    if (prefetchCandidate && prefetchCandidateOrigin) {
      await validatePrefetchCandidate(
        prefetchCandidate,
        prefetchCandidateOrigin,
      );
    }

    const waitForValidPrefetchCandidate = async () => {
      const joinStartedAt = performance.now();
      while (!prefetchedSourceText && !candidateMonitorCancelled) {
        const waiter = waitForNextBatchPrefetchCandidate(
          audioSessionId,
          excludedCandidateIds,
        );
        cancelCandidateWait = waiter.cancel;
        const update = await waiter.promise;
        cancelCandidateWait = undefined;
        if (!update || candidateMonitorCancelled) return undefined;
        prefetchJoinState = update.state;
        const eligible = await validatePrefetchCandidate(
          update.candidate,
          update.state === "latest" ? "latest" : "joined",
        );
        if (candidateMonitorCancelled) return undefined;
        prefetchJoinMs = Math.round(performance.now() - joinStartedAt);
        logEvent("info", "audio_session_prefetch_joined", {
          requestId,
          audioSessionId,
          state: update.state,
          waitedMs: prefetchJoinMs,
          candidateFound: true,
          candidateEligible: eligible,
          terminalSnapshot: update.candidate.terminalSnapshot,
          candidateOrigin: prefetchCandidateOrigin,
        });
        if (eligible) return update.candidate;
      }
      return prefetchCandidate;
    };

    let candidateMonitorPromise:
      | ReturnType<typeof waitForValidPrefetchCandidate>
      | undefined;
    let hedgedTranscript:
      | {
          sourceText: string;
          latencyMs: number;
        }
      | undefined;

    if (!prefetchedSourceText && asrMode === "batch_chunks") {
      const raceStartedAt = performance.now();
      candidateMonitorPromise = waitForValidPrefetchCandidate();
      activeCandidateMonitorPromise = candidateMonitorPromise;
      type InitialRaceWinner =
        | {
            kind: "asr";
            asr: Awaited<NonNullable<typeof hedgedAsrPromise>>;
          }
        | { kind: "prefetch"; candidate: BatchPrefetchCandidate | undefined }
        | { kind: "terminal_pipeline"; prepared: PreparedAudioSessionPipeline }
        | { kind: "terminal_pipeline_error"; error: unknown };
      const baseInitialContenders: Promise<InitialRaceWinner>[] = [
        hedgedAsrPromise!.then((asr) => ({ kind: "asr" as const, asr })),
        candidateMonitorPromise.then((candidate) => ({
          kind: "prefetch" as const,
          candidate,
        })),
      ];
      const initialContenders = [...baseInitialContenders];
      if (terminalPipelinePromise) {
        initialContenders.push(
          terminalPipelinePromise.then(
            (prepared) => ({
              kind: "terminal_pipeline" as const,
              prepared,
            }),
            (error: unknown) => ({
              kind: "terminal_pipeline_error" as const,
              error,
            }),
          ),
        );
      }
      let firstWinner = await Promise.race(initialContenders);
      if (firstWinner.kind === "terminal_pipeline_error") {
        logEvent("warn", "audio_session_terminal_pipeline_join_failed", {
          requestId,
          audioSessionId,
          error: firstWinner.error,
        });
        terminalPipelinePromise = undefined;
        firstWinner = await Promise.race(baseInitialContenders);
      }
      prefetchRaceMs = Math.round(performance.now() - raceStartedAt);

      if (firstWinner.kind === "terminal_pipeline") {
        prefetchRaceWinner = "terminal_pipeline";
        batchPrefetchUsed = true;
        terminalPipelineSharedFlightJoined =
          firstWinner.prepared.pipelineSharedFlightJoined;
        preparedPipelineSharedFlightJoined =
          firstWinner.prepared.pipelineSharedFlightJoined;
        terminalPreparedPipeline = firstWinner.prepared;
        prefetchedSourceText = firstWinner.prepared.pipeline.asr.value;
        candidateMonitorCancelled = true;
        cancelCandidateWait?.();
      } else if (firstWinner.kind === "prefetch" && firstWinner.candidate) {
        prefetchRaceWinner = "prefetch";
        batchPrefetchUsed = true;
      } else {
        const hedgedAsr =
          firstWinner.kind === "asr"
            ? firstWinner.asr
            : await hedgedAsrPromise!;
        hedgedAsrLatencyMs = hedgedAsr.latencyMs;
        hedgedAsrWaitMs = hedgedAsr.waitLatencyMs;
        hedgedAsrSharedFlightJoined = hedgedAsr.joined;
        if (!hedgedAsr.ok) {
          cancelCandidateWait?.();
          throw hedgedAsr.error;
        }
        prefetchRaceWinner = "asr";
        hedgedAsrUsed = true;
        hedgedTranscript = {
          sourceText: hedgedAsr.sourceText,
          latencyMs: hedgedAsr.latencyMs,
        };
      }
    } else if (prefetchedSourceText) {
      prefetchRaceWinner = "prefetch";
      batchPrefetchUsed = true;
    }

    const pipelineInput = (usingPrefetch: boolean): ConversationRequest => ({
      requestId,
      clientId: body.clientId?.trim() || undefined,
      context: body.context!,
      childAge: body.childAge ?? 6,
      targetLanguage: "en" as const,
      sessionId: body.sessionId,
      sourceText: usingPrefetch
        ? prefetchedSourceText
        : body.sourceText?.trim(),
      audioFile,
      asrMode,
      benchmark: {
        ...body.benchmark,
        batchPrefetchAttempted: Boolean(
          body.prefetchId ||
            prefetchCandidate ||
            terminalPipelineAgeMs !== undefined ||
            body.benchmark?.batchPrefetchAttempted,
        ),
        batchPrefetchUsed: usingPrefetch,
        batchPrefetchStability: prefetchCandidate?.stabilityCount,
        batchPrefetchAgeMs: prefetchCandidate
          ? Date.now() - prefetchCandidate.createdAt
          : undefined,
        batchPrefetchValidationMs: prefetchValidationMs || undefined,
        batchPrefetchTailMs: prefetchTail?.tailDurationMs,
        batchPrefetchPreviewMs: prefetchCandidate?.previewLatencyMs,
        batchPrefetchAsrMs: prefetchCandidate?.asrLatencyMs,
        batchPrefetchJoinMs: prefetchJoinMs || undefined,
        batchPrefetchJoinState: prefetchJoinState,
        batchPrefetchCandidateOrigin: prefetchCandidateOrigin,
        batchPrefetchRaceWinner: prefetchRaceWinner,
        batchPrefetchRaceMs: prefetchRaceMs || undefined,
        batchPipelineSharedFlightJoined:
          preparedPipelineSharedFlightJoined,
        batchTerminalPipelineAgeMs: terminalPipelineAgeMs,
        batchTerminalPipelineTailEligible: terminalPipelineTailEligible,
        batchTerminalPipelineSharedFlightJoined:
          terminalPipelineSharedFlightJoined,
        batchFinalizeHedgedAsrMs: hedgedAsrLatencyMs,
        batchFinalizeHedgedAsrWaitMs: hedgedAsrWaitMs,
        batchFinalizeHedgedAsrSharedFlightJoined:
          hedgedAsrSharedFlightJoined,
        batchFinalizeHedgedAsrUsed: hedgedAsrUsed,
      },
    });

    const runPrefetchedPipeline = () =>
      runConversationPipeline(pipelineInput(true), {
        deferTextCacheWrite: true,
        prefetchedTranscript: prefetchedSourceText
          ? {
              sourceText: prefetchedSourceText,
              latencyMs: prefetchCandidate?.asrLatencyMs ?? 0,
            }
          : undefined,
        prefetchedTranslation: prefetchCandidate?.translation,
        prefetchedAudio: prefetchCandidate
          ? {
              audioUrl: prefetchCandidate.audioUrl,
              source: prefetchCandidate.audioSource,
              cacheReady: prefetchCandidate.audioSource === "cache",
            }
          : undefined,
      });

    const pipelineStartedAt = performance.now();
    let result: ConversationResponse;
    if (terminalPreparedPipeline) {
      supersededPipelinePromise = preparedPipelinePromise;
      result = completePreparedConversationPipeline(
        pipelineInput(true),
        terminalPreparedPipeline.pipeline,
      );
    } else if (prefetchedSourceText && prefetchCandidate) {
      supersededPipelinePromise = preparedPipelinePromise;
      result = await runPrefetchedPipeline();
    } else {
      const authoritativePipelinePromise = preparedPipelinePromise
        ? preparedPipelinePromise.then((prepared) => {
            preparedPipelineSharedFlightJoined =
              prepared.pipelineSharedFlightJoined;
            return completePreparedConversationPipeline(
              pipelineInput(false),
              prepared.pipeline,
            );
          })
        : runConversationPipeline(pipelineInput(false), {
            deferTextCacheWrite: true,
            prefetchedTranscript: hedgedTranscript,
          });
      if (candidateMonitorPromise) {
        type ProcessingRaceWinner =
          | { kind: "pipeline"; result: ConversationResponse }
          | {
              kind: "prefetch";
              candidate: BatchPrefetchCandidate | undefined;
            }
          | {
              kind: "terminal_pipeline";
              prepared: PreparedAudioSessionPipeline;
            }
          | { kind: "terminal_pipeline_error"; error: unknown };
        const baseProcessingContenders: Promise<ProcessingRaceWinner>[] = [
          authoritativePipelinePromise.then((pipelineResult) => ({
            kind: "pipeline" as const,
            result: pipelineResult,
          })),
          candidateMonitorPromise.then((candidate) => ({
            kind: "prefetch" as const,
            candidate,
          })),
        ];
        const processingContenders = [...baseProcessingContenders];
        if (terminalPipelinePromise) {
          processingContenders.push(
            terminalPipelinePromise.then(
              (prepared) => ({
                kind: "terminal_pipeline" as const,
                prepared,
              }),
              (error: unknown) => ({
                kind: "terminal_pipeline_error" as const,
                error,
              }),
            ),
          );
        }
        let processingWinner = await Promise.race(processingContenders);
        if (processingWinner.kind === "terminal_pipeline_error") {
          logEvent("warn", "audio_session_terminal_pipeline_join_failed", {
            requestId,
            audioSessionId,
            error: processingWinner.error,
          });
          terminalPipelinePromise = undefined;
          processingWinner = await Promise.race(baseProcessingContenders);
        }
        if (processingWinner.kind === "terminal_pipeline") {
          prefetchRaceWinner = "terminal_pipeline";
          batchPrefetchUsed = true;
          terminalPipelineSharedFlightJoined =
            processingWinner.prepared.pipelineSharedFlightJoined;
          preparedPipelineSharedFlightJoined =
            processingWinner.prepared.pipelineSharedFlightJoined;
          prefetchedSourceText = processingWinner.prepared.pipeline.asr.value;
          candidateMonitorCancelled = true;
          cancelCandidateWait?.();
          supersededPipelinePromise = authoritativePipelinePromise;
          result = completePreparedConversationPipeline(
            pipelineInput(true),
            processingWinner.prepared.pipeline,
          );
        } else if (
          processingWinner.kind === "prefetch" &&
          processingWinner.candidate
        ) {
          prefetchRaceWinner = "late_prefetch";
          batchPrefetchUsed = true;
          supersededPipelinePromise = authoritativePipelinePromise;
          result = await runPrefetchedPipeline();
        } else {
          prefetchRaceWinner = "pipeline";
          candidateMonitorCancelled = true;
          cancelCandidateWait?.();
          result =
            processingWinner.kind === "pipeline"
              ? processingWinner.result
              : await authoritativePipelinePromise;
        }
      } else {
        prefetchRaceWinner = "pipeline";
        result = await authoritativePipelinePromise;
      }
    }
    pipelineMs = Math.round(performance.now() - pipelineStartedAt);

    const responsePayload = { ...result, learning: null };
    const responseReadyMs = Math.round(performance.now() - startedAt);
    after(async () => {
      const completeStartedAt = performance.now();
      let lastError: unknown;

      let completed = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await completeAudioSessionFinalize(
            audioSessionId,
            requestHash,
            responsePayload,
          );
          logEvent("info", "audio_session_finalize_completed", {
            requestId,
            audioSessionId,
            background: true,
            attempts: attempt,
            timing: {
              completeMs: Math.round(performance.now() - completeStartedAt),
              responseReadyMs,
            },
          });
          removeBatchPrefetchCandidate(
            prefetchCandidate?.id ?? body.prefetchId,
          );
          completed = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, attempt === 1 ? 100 : 300),
            );
          }
        }
      }

      if (!completed) {
        logEvent("error", "audio_session_finalize_completion_failed", {
          requestId,
          audioSessionId,
          background: true,
          attempts: 3,
          completeMs: Math.round(performance.now() - completeStartedAt),
          error: lastError,
        });
        return;
      }

      if (hedgedAsrPromise && batchPrefetchUsed && prefetchedSourceText) {
        const verified = await hedgedAsrPromise;
        if (verified.ok) {
          logEvent("info", "audio_session_prefetch_verified", {
            requestId,
            audioSessionId,
            matched:
              normalizeVietnameseForExactMatch(verified.sourceText) ===
              normalizeVietnameseForExactMatch(prefetchedSourceText),
            verificationMs: verified.latencyMs,
            reusedHedgedAsr: true,
            sharedFlightJoined: verified.joined,
          });
        } else {
          logEvent("warn", "audio_session_prefetch_verification_failed", {
            requestId,
            audioSessionId,
            verificationMs: verified.latencyMs,
            reusedHedgedAsr: true,
            sharedFlightJoined: verified.joined,
            error: verified.error,
          });
        }
      }

      if (activeCandidateMonitorPromise) {
        try {
          await activeCandidateMonitorPromise;
        } catch (error) {
          logEvent("warn", "audio_session_candidate_monitor_failed", {
            requestId,
            audioSessionId,
            error,
          });
        }
      }

      if (supersededPipelinePromise) {
        try {
          await supersededPipelinePromise;
          logEvent("info", "audio_session_pipeline_superseded", {
            requestId,
            audioSessionId,
            winner: "late_prefetch",
          });
        } catch (error) {
          logEvent("warn", "audio_session_superseded_pipeline_failed", {
            requestId,
            audioSessionId,
            error,
          });
        }
      }
    });
    logEvent("info", "audio_session_finalize_response_ready", {
      requestId,
      audioSessionId,
      timing: {
        claimMs,
        assembleMs,
        pipelineMs,
        prefetchValidationMs,
        prefetchJoinMs,
        prefetchJoinState,
        prefetchCandidateOrigin,
        prefetchRaceWinner,
        prefetchRaceMs,
        hedgedAsrLatencyMs,
        hedgedAsrWaitMs,
        hedgedAsrSharedFlightJoined,
        hedgedAsrUsed,
        preparedPipelineSharedFlightJoined,
        terminalPipelineAgeMs,
        terminalPipelineTailEligible,
        terminalPipelineSharedFlightJoined,
        terminalPreviewStartedAfterSilenceMs:
          body.benchmark?.batchTerminalPreviewStartedAfterSilenceMs,
        terminalPreviewLeadBeforeFinalizeMs:
          body.benchmark?.batchTerminalPreviewLeadBeforeFinalizeMs,
        assemblySource,
        batchPrefetchUsed,
        totalMs: responseReadyMs,
      },
    });
    scheduleConversationPostResponseTasks(result, "audio");
    return withRequestId(Response.json(responsePayload), requestId);
  } catch (error) {
    candidateMonitorCancelled = true;
    cancelCandidateWait?.();
    await activeCandidateMonitorPromise?.catch(() => undefined);
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
        ? publicAudioUploadError(error)
        : error;
    return withRequestId(toErrorResponse(responseError, requestId), requestId);
  }
}
