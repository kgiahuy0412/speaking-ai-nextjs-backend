import { createHash } from "node:crypto";
import type {
  BenchmarkMetadata,
  ConversationRequest,
  ConversationResponse,
  PracticeContext,
} from "@/types/conversation";
import {
  getRecord,
  insertRecordIfAbsent,
  putRecord,
} from "@/lib/db/records";
import {
  completePreparedConversationPipeline,
  prepareConversationPipeline,
} from "./pipeline";
import { scheduleConversationPostResponseTasks } from "./postResponseTasks";

const preparationNamespace = "conversation_preparations_v1";
const commitNamespace = "conversation_preparation_commits_v1";
const preparationTtlMs = 10 * 60 * 1000;

export type ConversationPreparation = {
  version: 1;
  prepareId: string;
  audioSessionId: string;
  snapshotHash: string;
  createdAt: string;
  expiresAt: string;
  result: ConversationResponse;
};

type PreparationGlobalState = typeof globalThis & {
  __aiSpeakingConversationPreparationFlights?: Map<
    string,
    Promise<ConversationPreparation>
  >;
  __aiSpeakingConversationPreparationMemory?: Map<
    string,
    ConversationPreparation
  >;
};

const state = globalThis as PreparationGlobalState;
const flights = state.__aiSpeakingConversationPreparationFlights ??= new Map();
const memory = state.__aiSpeakingConversationPreparationMemory ??= new Map();

function preparationKey(input: {
  audioSessionId: string;
  snapshotHash: string;
  context: PracticeContext;
  childAge: number;
  clientId?: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        audioSessionId: input.audioSessionId,
        snapshotHash: input.snapshotHash,
        context: input.context,
        childAge: input.childAge,
        clientId: input.clientId ?? null,
      }),
    )
    .digest("hex");
}

function isLive(value: ConversationPreparation | null | undefined) {
  return Boolean(value && Date.parse(value.expiresAt) > Date.now());
}

export async function prepareWorkerConversation(input: {
  requestId?: string;
  clientId?: string;
  audioSessionId: string;
  snapshotHash: string;
  sourceText: string;
  context: PracticeContext;
  childAge: number;
  asrLatencyMs: number;
  benchmark?: BenchmarkMetadata;
}) {
  const key = preparationKey(input);
  const prepareId = `prep_${key.slice(0, 32)}`;
  const memoryValue = memory.get(prepareId);
  if (isLive(memoryValue)) {
    return { preparation: memoryValue!, joined: true };
  }

  const active = flights.get(prepareId);
  if (active) {
    return { preparation: await active, joined: true };
  }

  const operation = (async () => {
    const stored = await getRecord<ConversationPreparation>(
      preparationNamespace,
      prepareId,
    );
    if (isLive(stored?.value)) {
      memory.set(prepareId, stored!.value);
      return stored!.value;
    }

    const request: ConversationRequest = {
      requestId: input.requestId,
      clientId: input.clientId,
      sessionId: input.audioSessionId,
      context: input.context,
      childAge: input.childAge,
      targetLanguage: "en",
      sourceText: input.sourceText,
      asrMode: "browser_streaming",
      benchmark: input.benchmark,
    };
    const pipeline = await prepareConversationPipeline(request, {
      deferTextCacheWrite: true,
      prefetchedTranscript: {
        sourceText: input.sourceText,
        latencyMs: input.asrLatencyMs,
      },
      streamAudioOnCacheMiss: true,
    });
    const now = Date.now();
    const preparation: ConversationPreparation = {
      version: 1,
      prepareId,
      audioSessionId: input.audioSessionId,
      snapshotHash: input.snapshotHash,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + preparationTtlMs).toISOString(),
      result: completePreparedConversationPipeline(request, pipeline),
    };
    await putRecord({
      namespace: preparationNamespace,
      key: prepareId,
      clientId: input.clientId,
      expiresAt: preparation.expiresAt,
      value: preparation,
    });
    memory.set(prepareId, preparation);
    return preparation;
  })();

  flights.set(prepareId, operation);
  try {
    return { preparation: await operation, joined: false };
  } finally {
    if (flights.get(prepareId) === operation) flights.delete(prepareId);
  }
}

export async function commitPreparedWorkerConversation(input: {
  prepareId: string;
  audioSessionId: string;
  snapshotHash: string;
  benchmark?: BenchmarkMetadata;
}) {
  let preparation = memory.get(input.prepareId);
  if (!isLive(preparation)) {
    const stored = await getRecord<ConversationPreparation>(
      preparationNamespace,
      input.prepareId,
    );
    preparation = stored?.value;
  }
  if (
    !isLive(preparation) ||
    preparation!.audioSessionId !== input.audioSessionId ||
    preparation!.snapshotHash !== input.snapshotHash
  ) {
    return null;
  }

  const result: ConversationResponse = {
    ...preparation!.result,
    benchmark: input.benchmark ?? preparation!.result.benchmark,
  };
  const firstCommit = await insertRecordIfAbsent({
    namespace: commitNamespace,
    key: input.prepareId,
    clientId: result.clientId,
    value: {
      committedAt: new Date().toISOString(),
      conversationId: result.conversationId,
    },
  });
  if (firstCommit) {
    scheduleConversationPostResponseTasks(result, "audio");
  }
  return { result, firstCommit };
}
