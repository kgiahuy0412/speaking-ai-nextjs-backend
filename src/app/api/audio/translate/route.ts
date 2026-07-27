import { AppError, toErrorResponse } from "@/lib/errors";
import {
  getCloudflareAudioMaxBytes,
  translateAudioToEnglish,
} from "@/lib/ai/cloudflareWorkersAi";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";
export const maxDuration = 35;

const supportedExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "ogg",
  "wav",
  "webm",
]);

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function validateAudio(audio: FormDataEntryValue | null) {
  if (!(audio instanceof File) || audio.size === 0) {
    throw new AppError("AUDIO_TOO_SHORT", "Vui lòng gửi tệp audio hợp lệ.");
  }

  if (audio.size > getCloudflareAudioMaxBytes()) {
    throw new AppError(
      "AUDIO_TOO_LONG",
      "Tệp audio vượt quá dung lượng cho phép.",
      413,
    );
  }

  const isAudioMime = audio.type.toLowerCase().startsWith("audio/");
  const hasSupportedExtension = supportedExtensions.has(
    getExtension(audio.name),
  );

  if (!isAudioMime && !hasSupportedExtension) {
    throw new AppError(
      "BAD_REQUEST",
      "Định dạng audio không được hỗ trợ. Hãy dùng AAC, FLAC, M4A, MP3, MP4, OGG, WAV hoặc WebM.",
      415,
    );
  }

  return audio;
}

function validateSourceLanguage(value: string) {
  const language = value.toLowerCase() || "vi";

  if (!/^[a-z]{2,3}$/.test(language)) {
    throw new AppError(
      "BAD_REQUEST",
      "sourceLanguage phải là mã ngôn ngữ ISO, ví dụ vi hoặc zh.",
    );
  }

  return language;
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  try {
    const contentType = request.headers.get("content-type") ?? "";

    if (!contentType.includes("multipart/form-data")) {
      throw new AppError(
        "BAD_REQUEST",
        "Yêu cầu phải dùng multipart/form-data.",
        415,
      );
    }

    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes = getCloudflareAudioMaxBytes() + 256 * 1024;

    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      throw new AppError(
        "AUDIO_TOO_LONG",
        "Tệp audio vượt quá dung lượng cho phép.",
        413,
      );
    }

    const formData = await request.formData();
    const audio = validateAudio(formData.get("audio"));
    const sourceLanguage = validateSourceLanguage(
      getFormString(formData, "sourceLanguage"),
    );
    const result = await translateAudioToEnglish(audio, sourceLanguage);

    logEvent("info", "cloudflare_audio_translation_completed", {
      requestId,
      sourceLanguage,
      audioBytes: audio.size,
      model: result.model,
    });

    return withRequestId(
      Response.json({
        requestId,
        sourceLanguage,
        targetLanguage: "en",
        ...result,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "cloudflare_audio_translation_failed", {
      requestId,
      error,
    });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
