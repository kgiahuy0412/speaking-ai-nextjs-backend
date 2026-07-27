import { after } from "next/server";
import type { ConversationResponse } from "@/types/conversation";
import { appendConversationHistory } from "@/lib/history";
import { logEvent } from "@/lib/observability";
import { maybeLearnFromRepeatedUse } from "./adaptiveLearning";

export function scheduleConversationPostResponseTasks(
  result: ConversationResponse,
  inputMode: "audio" | "text",
) {
  after(async () => {
    const startedAt = Date.now();
    try {
      await appendConversationHistory(result, inputMode);
      await maybeLearnFromRepeatedUse(result);
      logEvent("info", "conversation_post_response_completed", {
        requestId: result.requestId,
        conversationId: result.conversationId,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      logEvent("error", "conversation_post_response_failed", {
        requestId: result.requestId,
        conversationId: result.conversationId,
        latencyMs: Date.now() - startedAt,
        error,
      });
    }
  });
}
