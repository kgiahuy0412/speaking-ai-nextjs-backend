import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { logEvent } from "@/lib/observability";
import { transcribeAudioToVietnamese } from "./cloudflareWorkersAi";
import { sampleVietnameseByContext } from "./prompts";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import { repairVietnameseChildTranscript } from "./transcriptRepair";
import { getVietnameseTranscriptQualityIssue } from "./transcriptQuality";

function assertVietnameseTranscript(text: string, segments: unknown[] = []) {
  const qualityIssue = getVietnameseTranscriptQualityIssue(text, segments);
  if (!containsUnexpectedEastAsianScript(text) && !qualityIssue) return;

  throw new AppError(
    "ASR_LOW_CONFIDENCE",
    "Nhận diện giọng nói chưa đủ chắc chắn. Vui lòng nói lại gần micro hơn.",
  );
}

async function transcribeAudio(input: ConversationRequest) {
  const audioFile = input.audioFile!;
  const startedAt = performance.now();
  const result = await transcribeAudioToVietnamese(audioFile);
  assertVietnameseTranscript(result.vietnameseText, result.segments);
  logEvent("info", "asr_provider_latency", {
    requestId: input.requestId,
    provider: "cloudflare",
    model: result.model,
    latencyMs: Math.round(performance.now() - startedAt),
    fallbackUsed: false,
  });
  return result.vietnameseText;
}

export async function transcribeVietnamese(input: ConversationRequest) {
  if (input.sourceText?.trim()) {
    const sourceText = input.sourceText.trim();
    const confidence = input.benchmark?.asrConfidence;
    if (
      input.asrMode === "android_streaming" &&
      typeof confidence === "number" &&
      confidence >= 0 &&
      confidence < 0.2
    ) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Ứng dụng chưa nghe rõ câu nói. Vui lòng nói lại gần micro hơn.",
      );
    }
    assertVietnameseTranscript(sourceText);
    return input.asrMode === "android_streaming" ||
      input.asrMode === "openai_realtime"
      ? repairVietnameseChildTranscript(sourceText)
      : sourceText;
  }

  if (input.audioFile) {
    const vietnameseText = (await transcribeAudio(input)).trim();

    if (!vietnameseText) {
      throw new AppError(
        "ASR_LOW_CONFIDENCE",
        "Không nghe thấy giọng nói. Hãy bật micro của máy ảo và nói lại.",
      );
    }

    assertVietnameseTranscript(vietnameseText);

    return repairVietnameseChildTranscript(vietnameseText);
  }

  await delay(320);

  return sampleVietnameseByContext[input.context][0];
}
