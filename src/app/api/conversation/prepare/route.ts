import type { BenchmarkMetadata, PracticeContext } from "@/types/conversation";
import { after } from "next/server";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";
import { prepareWorkerConversation } from "@/lib/ai/conversationPreparation";

export const runtime = "nodejs";

const contexts = new Set<PracticeContext>(["home", "school", "outside"]);
const sessionPattern = /^[A-Za-z0-9._:-]{8,160}$/;
const snapshotHashPattern = /^[a-f0-9]{64}$/;

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    const body = (await request.json().catch(() => null)) as {
      clientId?: unknown;
      audioSessionId?: unknown;
      snapshotHash?: unknown;
      sourceText?: unknown;
      context?: unknown;
      childAge?: unknown;
      asrLatencyMs?: unknown;
      benchmark?: BenchmarkMetadata;
    } | null;
    const sourceText =
      typeof body?.sourceText === "string" ? body.sourceText.trim() : "";
    const audioSessionId =
      typeof body?.audioSessionId === "string" ? body.audioSessionId : "";
    const snapshotHash =
      typeof body?.snapshotHash === "string"
        ? body.snapshotHash.toLowerCase()
        : "";
    const context = body?.context;
    const childAge = Number(body?.childAge ?? 6);
    if (
      !sourceText ||
      sourceText.length > 500 ||
      !sessionPattern.test(audioSessionId) ||
      !snapshotHashPattern.test(snapshotHash) ||
      typeof context !== "string" ||
      !contexts.has(context as PracticeContext) ||
      !Number.isInteger(childAge) ||
      childAge < 3 ||
      childAge > 18
    ) {
      throw new AppError("BAD_REQUEST", "Dữ liệu chuẩn bị hội thoại không hợp lệ.");
    }

    const prepared = await prepareWorkerConversation({
      requestId,
      clientId:
        typeof body?.clientId === "string" && body.clientId.trim()
          ? body.clientId.trim()
          : undefined,
      audioSessionId,
      snapshotHash,
      sourceText,
      context: context as PracticeContext,
      childAge,
      asrLatencyMs: Math.max(0, Math.round(Number(body?.asrLatencyMs ?? 0))),
      benchmark: body?.benchmark,
    });
    if (prepared.persistence) {
      after(() => prepared.persistence!);
    }
    logEvent("info", "conversation_prepare_completed", {
      requestId,
      prepareId: prepared.preparation.prepareId,
      audioSessionId,
      snapshotHash,
      joined: prepared.joined,
      textSource: prepared.preparation.result.textSource,
      audioSource: prepared.preparation.result.audioSource,
    });
    return withRequestId(
      Response.json({
        prepareId: prepared.preparation.prepareId,
        snapshotHash,
        joined: prepared.joined,
        expiresAt: prepared.preparation.expiresAt,
        result: { ...prepared.preparation.result, learning: null },
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "conversation_prepare_failed", { requestId, error });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
