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
import { logEvent } from "@/lib/observability";

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
  __aiSpeakingConversationPreparationPersistence?: Map<string, Promise<void>>;
  __aiSpeakingConversationPreparationCommits?: Map<string, Promise<boolean>>;
};

const state = globalThis as PreparationGlobalState;
const flights = state.__aiSpeakingConversationPreparationFlights ??= new Map();
const memory = state.__aiSpeakingConversationPreparationMemory ??= new Map();
const persistenceFlights =
  state.__aiSpeakingConversationPreparationPersistence ??= new Map();
const commitFlights =
  state.__aiSpeakingConversationPreparationCommits ??= new Map();

function persistPreparation(
  preparation: ConversationPreparation,
  clientId?: string,
) {
  const active = persistenceFlights.get(preparation.prepareId);
  if (active) return active;

  const operation = putRecord({
    namespace: preparationNamespace,
    key: preparation.prepareId,
    clientId,
    expiresAt: preparation.expiresAt,
    value: preparation,
  }).catch((error) => {
    logEvent("warn", "conversation_prepare_persist_failed", {
      prepareId: preparation.prepareId,
      audioSessionId: preparation.audioSessionId,
      error,
    });
  });
  persistenceFlights.set(preparation.prepareId, operation);
  void operation.finally(() => {
    if (persistenceFlights.get(preparation.prepareId) === operation) {
      persistenceFlights.delete(preparation.prepareId);
    }
  });
  return operation;
}

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
    return {
      preparation: memoryValue!,
      joined: true,
      persistence: persistenceFlights.get(prepareId),
    };
  }

  const active = flights.get(prepareId);
  if (active) {
    return {
      preparation: await active,
      joined: true,
      persistence: persistenceFlights.get(prepareId),
    };
  }

  const operation = (async () => {
    // audioSessionId + snapshotHash makes a fresh preparation unique. Avoid a
    // Neon lookup before every new AI sentence; duplicate requests in this
    // process are already joined by `flights`, while durable storage remains
    // available to the later commit if the process changes.
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
    memory.set(prepareId, preparation);
    persistPreparation(preparation, input.clientId);
    return preparation;
  })();

  flights.set(prepareId, operation);
  try {
    const preparation = await operation;
    return {
      preparation,
      joined: false,
      persistence: persistenceFlights.get(prepareId),
    };
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
  let completion = commitFlights.get(input.prepareId);
  if (!completion) {
    completion = insertRecordIfAbsent({
      namespace: commitNamespace,
      key: input.prepareId,
      clientId: result.clientId,
      value: {
        committedAt: new Date().toISOString(),
        conversationId: result.conversationId,
      },
    }).then((firstCommit) => {
      if (firstCommit) {
        scheduleConversationPostResponseTasks(result, "audio");
      }
      return firstCommit;
    });
    commitFlights.set(input.prepareId, completion);
    void completion.then(
      () => {
        if (commitFlights.get(input.prepareId) === completion) {
          commitFlights.delete(input.prepareId);
        }
      },
      () => {
        if (commitFlights.get(input.prepareId) === completion) {
          commitFlights.delete(input.prepareId);
        }
      },
    );
  }
  return { result, completion };
}
