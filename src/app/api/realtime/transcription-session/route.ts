import { AppError, toErrorResponse } from "@/lib/errors";
import { getOpenAIClient } from "@/lib/ai/openai";
import {
  getRequestId,
  logEvent,
  withRequestId,
} from "@/lib/observability";

export const runtime = "nodejs";

type SessionRateState = {
  count: number;
  windowStartedAt: number;
};

const rateStates = new Map<string, SessionRateState>();
const rateWindowMs = 5 * 60 * 1000;
const maxSessionsPerWindow = 30;

function consumeSessionAllowance(clientId: string) {
  const now = Date.now();
  const current = rateStates.get(clientId);

  if (!current || now - current.windowStartedAt >= rateWindowMs) {
    rateStates.set(clientId, { count: 1, windowStartedAt: now });
    return;
  }

  if (current.count >= maxSessionsPerWindow) {
    throw new AppError(
      "RATE_LIMITED",
      "Bạn đang mở quá nhiều lượt nhận diện. Vui lòng đợi một chút rồi thử lại.",
      429,
    );
  }

  current.count += 1;
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  try {
    const body = (await request.json().catch(() => null)) as {
      clientId?: string;
      bluetoothAudioInput?: boolean;
    } | null;
    const clientId = body?.clientId?.trim() ?? "";

    if (!clientId || clientId.length > 120) {
      throw new AppError(
        "BAD_REQUEST",
        "Không tìm thấy mã thiết bị hợp lệ.",
      );
    }

    consumeSessionAllowance(clientId);

    const model = process.env.OPENAI_REALTIME_ASR_MODEL ?? "gpt-realtime-whisper";
    const delay =
      process.env.OPENAI_REALTIME_ASR_DELAY === "high"
        ? "high"
        : "low";
    const client = getOpenAIClient();
    const secret = await client.realtime.clientSecrets.create(
      {
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              noise_reduction: { type: "near_field" },
              transcription: {
                model,
                language: "vi",
                delay,
              },
              turn_detection: null,
            },
          },
        },
      },
      { timeout: 10_000 },
    );

    logEvent("info", "realtime_transcription_session_created", {
      requestId,
      clientId,
      model,
      delay,
      bluetoothAudioInput: body?.bluetoothAudioInput === true,
    });

    return withRequestId(
      Response.json({
        clientSecret: secret.value,
        expiresAt: secret.expires_at,
        websocketUrl:
          "wss://api.openai.com/v1/realtime?intent=transcription",
        sampleRate: 24000,
        model,
        delay,
      }),
      requestId,
    );
  } catch (error) {
    logEvent("warn", "realtime_transcription_session_failed", {
      requestId,
      error,
    });
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
