import type { BenchmarkMetadata } from "@/types/conversation";
import { after } from "next/server";
import { AppError, toErrorResponse } from "@/lib/errors";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";
import { commitPreparedWorkerConversation } from "@/lib/ai/conversationPreparation";

export const runtime = "nodejs";

const prepareIdPattern = /^prep_[a-f0-9]{32}$/;
const sessionPattern = /^[A-Za-z0-9._:-]{8,160}$/;
const snapshotHashPattern = /^[a-f0-9]{64}$/;

export async function POST(request: Request) {
  const requestId = getRequestId(request);
  try {
    const body = (await request.json().catch(() => null)) as {
      prepareId?: unknown;
      audioSessionId?: unknown;
      snapshotHash?: unknown;
      benchmark?: BenchmarkMetadata;
    } | null;
    const prepareId =
      typeof body?.prepareId === "string" ? body.prepareId : "";
    const audioSessionId =
      typeof body?.audioSessionId === "string" ? body.audioSessionId : "";
    const snapshotHash =
      typeof body?.snapshotHash === "string"
        ? body.snapshotHash.toLowerCase()
        : "";
    if (
      !prepareIdPattern.test(prepareId) ||
      !sessionPattern.test(audioSessionId) ||
      !snapshotHashPattern.test(snapshotHash)
    ) {
      throw new AppError("BAD_REQUEST", "Dữ liệu commit hội thoại không hợp lệ.");
    }

    const committed = await commitPreparedWorkerConversation({
      prepareId,
      audioSessionId,
      snapshotHash,
      benchmark: body?.benchmark,
    });
    if (!committed) {
      throw new AppError(
        "BAD_REQUEST",
        "Kết quả chuẩn bị đã hết hạn hoặc không khớp snapshot.",
        409,
      );
    }
    logEvent("info", "conversation_prepare_commit_accepted", {
      requestId,
      prepareId,
      audioSessionId,
    });
    after(async () => {
      try {
        const firstCommit = await committed.completion;
        logEvent("info", "conversation_prepare_committed", {
          requestId,
          prepareId,
          audioSessionId,
          firstCommit,
        });
      } catch (error) {
        logEvent("warn", "conversation_prepare_commit_persist_failed", {
          requestId,
          prepareId,
          audioSessionId,
          error,
        });
      }
    });
    return withRequestId(
      Response.json({ ...committed.result, learning: null }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "conversation_prepare_commit_failed", {
      requestId,
      error,
    });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
