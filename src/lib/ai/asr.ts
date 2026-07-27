import type { ConversationRequest } from "@/types/conversation";
import { AppError } from "@/lib/errors";
import { delay } from "@/lib/latency";
import { transcribeVietnameseAudio } from "./aiProvider";
import { sampleVietnameseByContext } from "./prompts";
import { containsUnexpectedEastAsianScript } from "./languageValidation";
import { repairVietnameseChildTranscript } from "./transcriptRepair";

function assertVietnameseTranscript(text: string) {
  if (!containsUnexpectedEastAsianScript(text)) {
    return;
  }

  throw new AppError(
    "ASR_LOW_CONFIDENCE",
    "Nhận diện giọng nói chưa đúng tiếng Việt. Vui lòng nói lại gần micro hơn.",
  );
}

export async function transcribeVietnamese(input: ConversationRequest) {
  if (input.sourceText?.trim()) {
    const sourceText = input.sourceText.trim();
    return input.asrMode === "android_streaming" ||
      input.asrMode === "openai_realtime"
      ? repairVietnameseChildTranscript(sourceText)
      : sourceText;
  }

  if (input.audioFile) {
    const transcription = await transcribeVietnameseAudio(input.audioFile);
    const vietnameseText = transcription.text;

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
