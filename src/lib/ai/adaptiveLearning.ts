import type {
  ConversationHistoryEntry,
  ConversationResponse,
} from "@/types/conversation";
import {
  readConversationHistory,
  updateConversationHistory,
  updateConversationHistoryBatch,
} from "@/lib/history";
import { normalizeVietnamese } from "@/lib/normalize";
import {
  getPromotedRule,
  promoteEnglishRule,
  removePromotedRule,
} from "./promotedRules";
import { removeAiEnglishText } from "./textCache";
import { synthesizeEnglishAudio } from "./tts";

const repeatPromotionThreshold = 3;
const promotableTextSources = new Set(["openai", "text_cache"]);
const ruleTextSources = new Set([
  "phrase_rule",
  "keyword_rule",
  "promoted_rule",
  "semantic_cache",
]);

export type AdaptiveLearningOutcome = {
  status:
    | "already_rule"
    | "observing"
    | "promoted"
    | "rejected"
    | "conflict"
    | "not_eligible";
  promoted: boolean;
  useCount: number;
  threshold: number;
  message: string;
};

function normalizedEnglish(text: string) {
  return text.trim().toLocaleLowerCase("en");
}

function sameLearningScope(
  entry: ConversationHistoryEntry,
  conversation: ConversationResponse,
) {
  return (entry.clientId ?? "") === (conversation.clientId ?? "");
}

function isSameCandidate(
  entry: ConversationHistoryEntry,
  conversation: ConversationResponse,
) {
  return (
    sameLearningScope(entry, conversation) &&
    entry.context === conversation.context &&
    normalizeVietnamese(entry.vietnameseText) ===
      normalizeVietnamese(conversation.vietnameseText) &&
    normalizedEnglish(entry.englishText) ===
      normalizedEnglish(conversation.englishText) &&
    promotableTextSources.has(entry.textSource) &&
    entry.qualityApproved !== false
  );
}

async function promoteCandidate(
  conversation: ConversationResponse,
  reason: "positive_feedback" | "repeated_use" | "manual",
  awaitAudio: boolean,
): Promise<AdaptiveLearningOutcome> {
  if (ruleTextSources.has(conversation.textSource)) {
    return {
      status: "already_rule",
      promoted: conversation.textSource === "promoted_rule",
      useCount: 0,
      threshold: repeatPromotionThreshold,
      message: "Câu này đã có rule nên không cần học lại.",
    };
  }

  if (!promotableTextSources.has(conversation.textSource)) {
    return {
      status: "not_eligible",
      promoted: false,
      useCount: 0,
      threshold: repeatPromotionThreshold,
      message: "Câu này không đủ điều kiện để học thành rule.",
    };
  }

  const existingRule = await getPromotedRule(
    conversation.vietnameseText,
    conversation.context,
    conversation.clientId,
  );

  if (existingRule) {
    if (
      normalizedEnglish(existingRule.englishText) ===
      normalizedEnglish(conversation.englishText)
    ) {
      return {
        status: "already_rule",
        promoted: true,
        useCount: repeatPromotionThreshold,
        threshold: repeatPromotionThreshold,
        message: "Câu này đã được ứng dụng học trước đó.",
      };
    }

    return {
      status: "conflict",
      promoted: false,
      useCount: 0,
      threshold: repeatPromotionThreshold,
      message:
        "Câu này trùng ý định nhưng khác bản dịch nên chưa tự ghi đè rule.",
    };
  }

  await promoteEnglishRule(
    conversation.vietnameseText,
    conversation.englishText,
    conversation.context,
    {
      clientId: conversation.clientId,
      promotedBy: reason,
    },
  );

  const audioTask = synthesizeEnglishAudio(conversation.englishText);
  if (awaitAudio) {
    try {
      await audioTask;
    } catch (error) {
      console.error("adaptive_learning_audio_cache_failed", {
        conversationId: conversation.conversationId,
        error,
      });
    }
  } else {
    void audioTask.catch((error) => {
      console.error("adaptive_learning_audio_cache_failed", {
        conversationId: conversation.conversationId,
        error,
      });
    });
  }

  return {
    status: "promoted",
    promoted: true,
    useCount: repeatPromotionThreshold,
    threshold: repeatPromotionThreshold,
    message: "Ứng dụng đã học câu này để phản hồi nhanh hơn lần sau.",
  };
}

export async function learnFromPositiveFeedback(
  conversation: ConversationHistoryEntry,
) {
  return promoteCandidate(conversation, "positive_feedback", true);
}

export async function unlearnFromNegativeFeedback(
  conversation: ConversationHistoryEntry,
): Promise<AdaptiveLearningOutcome> {
  if (
    ruleTextSources.has(conversation.textSource) &&
    conversation.textSource !== "promoted_rule"
  ) {
    return {
      status: "conflict",
      promoted: false,
      useCount: 0,
      threshold: repeatPromotionThreshold,
      message:
        "Đã ghi nhận Sai ý. Đây là rule có sẵn nên cần quản trị viên kiểm tra lại.",
    };
  }

  const existingRule = await getPromotedRule(
    conversation.vietnameseText,
    conversation.context,
    conversation.clientId,
  );
  const canRemoveRule =
    existingRule &&
    existingRule.clientId === conversation.clientId &&
    existingRule.promotedBy !== "manual";

  const removedRule = canRemoveRule
    ? await removePromotedRule(
        conversation.vietnameseText,
        conversation.context,
        conversation.clientId,
      )
    : false;

  const removedCachedTexts = await removeAiEnglishText(
    conversation.vietnameseText,
    conversation.context,
    conversation.clientId,
  );

  return {
    status: "rejected",
    promoted: false,
    useCount: 0,
    threshold: repeatPromotionThreshold,
    message:
      removedRule || removedCachedTexts > 0
        ? "Đã ghi nhận Sai ý và bỏ câu này khỏi phần học tự động."
        : "Đã ghi nhận Sai ý; câu này sẽ không được tự học.",
  };
}

export async function maybeLearnFromRepeatedUse(
  conversation: ConversationResponse,
) {
  if (!promotableTextSources.has(conversation.textSource)) {
    return null;
  }

  const history = await readConversationHistory(500);
  const useCount = history.filter((entry) =>
    isSameCandidate(entry, conversation),
  ).length;

  if (useCount < repeatPromotionThreshold) {
    await updateConversationHistory({
      conversationId: conversation.conversationId,
      learningStatus:
        conversation.textSource === "openai" ? "cached" : "observing",
      learningUseCount: useCount,
    });

    return {
      status: "observing",
      promoted: false,
      useCount,
      threshold: repeatPromotionThreshold,
      message: `Ứng dụng đang ghi nhớ câu này (${useCount}/${repeatPromotionThreshold}).`,
    } satisfies AdaptiveLearningOutcome;
  }

  await updateConversationHistory({
    conversationId: conversation.conversationId,
    promotedToRule: false,
    learningStatus: "observing",
    learningReason: "repeated_use",
    learningUseCount: useCount,
    reviewStatus: "needs_review",
  });

  return {
    status: "observing",
    promoted: false,
    useCount,
    threshold: repeatPromotionThreshold,
    message:
      "Câu này được lặp lại nhiều lần và đang chờ admin xác nhận trước khi học thành rule.",
  } satisfies AdaptiveLearningOutcome;
}

export async function migrateApprovedHistoryLearning(clientId: string) {
  const history = await readConversationHistory(500);
  const groups = new Map<string, ConversationHistoryEntry[]>();

  history
    .filter(
      (entry) =>
        entry.clientId === clientId &&
        entry.qualityApproved === true &&
        promotableTextSources.has(entry.textSource) &&
        !["promoted", "already_rule"].includes(
          entry.learningStatus ?? "",
        ),
    )
    .forEach((entry) => {
      const key = [
        entry.context,
        normalizeVietnamese(entry.vietnameseText),
      ].join("::");
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    });

  const patches: Parameters<typeof updateConversationHistoryBatch>[0] = [];
  let promoted = 0;
  let conflicts = 0;

  for (const entries of groups.values()) {
    const translations = new Set(
      entries.map((entry) => normalizedEnglish(entry.englishText)),
    );

    if (translations.size > 1) {
      conflicts += entries.length;
      entries.forEach((entry) => {
        patches.push({
          conversationId: entry.conversationId,
          clientId,
          learningStatus: "conflict",
          learningReason: "positive_feedback",
        });
      });
      continue;
    }

    const outcome = await promoteCandidate(
      entries[0],
      "positive_feedback",
      false,
    );
    if (outcome.promoted) {
      promoted += entries.length;
    }
    entries.forEach((entry) => {
      patches.push({
        conversationId: entry.conversationId,
        clientId,
        promotedToRule: outcome.promoted,
        learningStatus: outcome.status,
        learningReason: "positive_feedback",
        learningUseCount: outcome.useCount,
      });
    });
  }

  await updateConversationHistoryBatch(patches);

  return {
    reviewed: patches.length,
    promoted,
    conflicts,
  };
}

export function getAdaptiveLearningThreshold() {
  return repeatPromotionThreshold;
}
