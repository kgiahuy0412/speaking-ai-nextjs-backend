import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PracticeContext } from "@/types/conversation";
import { normalizeVietnamese } from "@/lib/normalize";
import { isPostgresStorageEnabled } from "@/lib/db";
import {
  deleteRecord,
  getRecord,
  listRecords,
  putRecord,
} from "@/lib/db/records";

export type PromotedRule = {
  context: PracticeContext;
  normalizedVietnameseText: string;
  originalVietnameseText: string;
  englishText: string;
  clientId?: string;
  promotedBy?: "positive_feedback" | "repeated_use" | "manual";
  createdAt: string;
  updatedAt?: string;
};

type PromotedRuleFile = Record<string, PromotedRule>;

const dataDir = path.join(process.cwd(), "data");
const rulesPath = path.join(dataDir, "promoted-rules.json");
const rulesNamespace = "promoted_rules";
type PromotedRulesGlobalState = typeof globalThis & {
  __aiSpeakingPromotedRulesMutationQueue?: Promise<void>;
};

const promotedRulesGlobal = globalThis as PromotedRulesGlobalState;

function getRuleKey(
  context: PracticeContext,
  normalizedText: string,
  clientId?: string,
) {
  return clientId
    ? `client:${clientId}::${context}::${normalizedText}`
    : `${context}::${normalizedText}`;
}

async function readRules() {
  try {
    return JSON.parse(await readFile(rulesPath, "utf8")) as PromotedRuleFile;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    } else {
      throw error;
    }
  }
}

async function writeRules(rules: PromotedRuleFile) {
  const temporaryPath = path.join(
    dataDir,
    `.promoted-rules-${crypto.randomUUID()}.tmp`,
  );
  await mkdir(dataDir, { recursive: true });

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(rules, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, rulesPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueueMutation<T>(operation: () => Promise<T>) {
  const queue =
    promotedRulesGlobal.__aiSpeakingPromotedRulesMutationQueue ??
    Promise.resolve();
  const result = queue.then(operation, operation);
  promotedRulesGlobal.__aiSpeakingPromotedRulesMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function getPromotedRule(
  vietnameseText: string,
  context: PracticeContext,
  clientId?: string,
) {
  const normalizedText = normalizeVietnamese(vietnameseText);

  if (!normalizedText) {
    return null;
  }

  if (isPostgresStorageEnabled()) {
    const clientRule = clientId
      ? await getRecord<PromotedRule>(
          rulesNamespace,
          getRuleKey(context, normalizedText, clientId),
        )
      : null;
    const globalRule = clientRule
      ? null
      : await getRecord<PromotedRule>(
          rulesNamespace,
          getRuleKey(context, normalizedText),
        );
    return clientRule?.value ?? globalRule?.value ?? null;
  }

  await promotedRulesGlobal.__aiSpeakingPromotedRulesMutationQueue;
  const rules = await readRules();
  return (
    rules[getRuleKey(context, normalizedText, clientId)] ??
    rules[getRuleKey(context, normalizedText)] ??
    null
  );
}

export async function promoteEnglishRule(
  vietnameseText: string,
  englishText: string,
  context: PracticeContext,
  options: {
    clientId?: string;
    promotedBy?: PromotedRule["promotedBy"];
  } = {},
) {
  const normalizedVietnameseText = normalizeVietnamese(vietnameseText);

  if (!normalizedVietnameseText || !englishText.trim()) {
    throw new Error("Rule text is empty.");
  }

  if (isPostgresStorageEnabled()) {
    const key = getRuleKey(
      context,
      normalizedVietnameseText,
      options.clientId,
    );
    const existing = await getRecord<PromotedRule>(rulesNamespace, key);
    const now = new Date().toISOString();
    const rule: PromotedRule = {
      context,
      normalizedVietnameseText,
      originalVietnameseText: vietnameseText.trim(),
      englishText: englishText.trim(),
      clientId: options.clientId,
      promotedBy: options.promotedBy ?? "manual",
      createdAt: existing?.value.createdAt ?? now,
      updatedAt: now,
    };

    await putRecord({
      namespace: rulesNamespace,
      key,
      clientId: options.clientId,
      createdAt: rule.createdAt,
      value: rule,
    });
    return rule;
  }

  return enqueueMutation(async () => {
    const rules = { ...(await readRules()) };
    const key = getRuleKey(
      context,
      normalizedVietnameseText,
      options.clientId,
    );
    const now = new Date().toISOString();
    const rule: PromotedRule = {
      context,
      normalizedVietnameseText,
      originalVietnameseText: vietnameseText.trim(),
      englishText: englishText.trim(),
      clientId: options.clientId,
      promotedBy: options.promotedBy ?? "manual",
      createdAt: rules[key]?.createdAt ?? now,
      updatedAt: now,
    };

    rules[key] = rule;
    await writeRules(rules);
    return rule;
  });
}

export async function removePromotedRule(
  vietnameseText: string,
  context: PracticeContext,
  clientId?: string,
) {
  const normalizedVietnameseText = normalizeVietnamese(vietnameseText);

  if (!normalizedVietnameseText) {
    return false;
  }

  if (isPostgresStorageEnabled()) {
    return deleteRecord(
      rulesNamespace,
      getRuleKey(context, normalizedVietnameseText, clientId),
      clientId,
    );
  }

  return enqueueMutation(async () => {
    const rules = { ...(await readRules()) };
    const key = getRuleKey(context, normalizedVietnameseText, clientId);

    if (!(key in rules)) {
      return false;
    }

    delete rules[key];
    await writeRules(rules);
    return true;
  });
}

export async function getPromotedRuleAudioTexts(
  context: PracticeContext,
  clientId?: string,
) {
  if (isPostgresStorageEnabled()) {
    const rules = await listRecords<PromotedRule>(rulesNamespace, {
      limit: 100_000,
    });
    return [
      ...new Set(
        rules
          .filter(
            (rule) =>
              rule.context === context &&
              (!rule.clientId || rule.clientId === clientId),
          )
          .map((rule) => rule.englishText),
      ),
    ];
  }

  await promotedRulesGlobal.__aiSpeakingPromotedRulesMutationQueue;
  const rules = await readRules();

  return [
    ...new Set(
      Object.values(rules)
        .filter(
          (rule) =>
            rule.context === context &&
            (!rule.clientId || rule.clientId === clientId),
        )
        .map((rule) => rule.englishText),
    ),
  ];
}

export async function getPromotedRulesForClient(clientId: string) {
  if (isPostgresStorageEnabled()) {
    return listRecords<PromotedRule>(rulesNamespace, {
      clientId,
      limit: 100_000,
    });
  }

  await promotedRulesGlobal.__aiSpeakingPromotedRulesMutationQueue;
  const rules = await readRules();
  return Object.values(rules).filter((rule) => rule.clientId === clientId);
}
