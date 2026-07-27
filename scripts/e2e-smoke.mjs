import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const clientId = `codex-e2e-${Date.now()}`;
const conversationIds = [];
let audioSessionId = null;

async function requestJson(urlPath, options = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, options);
  const responseText = await response.text();
  const data = responseText ? JSON.parse(responseText) : {};

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${urlPath}: ${responseText}`);
  }

  return { response, data };
}

function jsonOptions(method, body, headers = {}) {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

const report = { baseUrl, clientId };

try {
  const realtimeResponse = await fetch(
    `${baseUrl}/api/realtime/transcription-session`,
    jsonOptions("POST", { clientId, bluetoothAudioInput: false }),
  );
  report.realtimeStatus = realtimeResponse.status;

  const textResult = (
    await requestJson(
      "/api/conversation",
      jsonOptions("POST", {
        clientId,
        context: "home",
        childAge: 6,
        sourceText: "Con khát nước.",
        asrMode: "android_streaming",
        benchmark: {
          utteranceDurationMs: 950,
          vadSilenceMs: 700,
          requestedAsrMode: "android_streaming",
          audioInputLabel: "Node E2E",
          bluetoothAudioInput: false,
          initialNoiseRms: 0.02,
        },
      }),
    )
  ).data;
  conversationIds.push(textResult.conversationId);
  report.textConversation = {
    conversationId: textResult.conversationId,
    vietnameseText: textResult.vietnameseText,
    englishText: textResult.englishText,
    textSource: textResult.textSource,
    audioSource: textResult.audioSource,
    asrMode: textResult.asrMode,
    audioUrl: textResult.audioUrl,
  };

  const textAudioResponse = await fetch(
    new URL(textResult.audioUrl, baseUrl),
  );
  const textAudioBytes = (await textAudioResponse.arrayBuffer()).byteLength;
  report.textAudio = {
    status: textAudioResponse.status,
    contentType: textAudioResponse.headers.get("content-type"),
    bytes: textAudioBytes,
  };

  await requestJson(
    "/api/history",
    jsonOptions("PATCH", {
      clientId,
      conversationId: textResult.conversationId,
      latency: {
        audioLoadMs: 25,
        audioFromDeviceCache: false,
        browserAudioStartedMs: 80,
        timeToFirstAudioMs: 80,
        audioStartedAfterStopMs: 80,
      },
    }),
  );

  audioSessionId = (
    await requestJson("/api/audio-sessions", { method: "POST" })
  ).data.audioSessionId;
  const audioFixture = await readFile(
    path.join(process.cwd(), "public", "generated-audio", "i-m-thirsty.mp3"),
  );
  const uploadForm = new FormData();
  uploadForm.append("sequence", "0");
  uploadForm.append(
    "audio",
    new Blob([audioFixture], { type: "audio/mpeg" }),
    "speech.mp3",
  );
  const uploadResult = (
    await requestJson(`/api/audio-sessions/${audioSessionId}/chunks`, {
      method: "POST",
      body: uploadForm,
    })
  ).data;
  report.upload = {
    audioSessionId,
    sequence: uploadResult.sequence,
  };

  const batchResult = (
    await requestJson(
      `/api/audio-sessions/${audioSessionId}/finalize`,
      jsonOptions(
        "POST",
        {
          clientId,
          context: "home",
          childAge: 6,
          asrMode: "batch_chunks",
          mimeType: "audio/mpeg",
          benchmark: {
            utteranceDurationMs: 1100,
            vadSilenceMs: 700,
            requestedAsrMode: "batch_chunks",
            audioInputLabel: "Node MP3 fixture",
            bluetoothAudioInput: false,
            initialNoiseRms: 0.01,
          },
        },
        { "idempotency-key": `finalize:${audioSessionId}` },
      ),
    )
  ).data;
  conversationIds.push(batchResult.conversationId);
  report.batchConversation = {
    conversationId: batchResult.conversationId,
    vietnameseText: batchResult.vietnameseText,
    englishText: batchResult.englishText,
    textSource: batchResult.textSource,
    audioSource: batchResult.audioSource,
    asrMode: batchResult.asrMode,
    audioUrl: batchResult.audioUrl,
    asrMs: batchResult.latency.asrMs,
    llmMs: batchResult.latency.llmMs,
  };

  const batchAudioResponse = await fetch(
    new URL(batchResult.audioUrl, baseUrl),
  );
  const batchAudioBytes = (await batchAudioResponse.arrayBuffer()).byteLength;
  report.batchAudio = {
    status: batchAudioResponse.status,
    contentType: batchAudioResponse.headers.get("content-type"),
    bytes: batchAudioBytes,
  };

  const history = (
    await requestJson(
      `/api/history?clientId=${encodeURIComponent(clientId)}&limit=100`,
    )
  ).data.conversations;
  report.history = {
    count: history.length,
    conversationIds: history.map((item) => item.conversationId),
  };

  assert.ok(
    report.realtimeStatus === 200 || report.realtimeStatus === 503,
    `Unexpected realtime status ${report.realtimeStatus}`,
  );
  assert.equal(textResult.vietnameseText, "Con khát nước.");
  assert.ok(textResult.englishText.trim());
  assert.equal(textAudioResponse.status, 200);
  assert.match(textAudioResponse.headers.get("content-type") ?? "", /^audio\//);
  assert.ok(textAudioBytes > 1000);
  assert.ok(batchResult.vietnameseText.trim());
  assert.ok(batchResult.englishText.trim());
  assert.equal(batchResult.asrMode, "batch_chunks");
  assert.equal(batchAudioResponse.status, 200);
  assert.match(batchAudioResponse.headers.get("content-type") ?? "", /^audio\//);
  assert.ok(batchAudioBytes > 1000);
  assert.equal(history.length, 2);
  report.assertions = "PASS";
} catch (error) {
  report.assertions = "FAIL";
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const conversationId of conversationIds) {
    await requestJson(
      "/api/history",
      jsonOptions("PATCH", {
        clientId,
        conversationId,
        qualityApproved: false,
      }),
    ).catch(() => undefined);
    await requestJson(
      `/api/history?clientId=${encodeURIComponent(clientId)}&conversationId=${encodeURIComponent(conversationId)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
  }

  if (audioSessionId) {
    await requestJson(`/api/audio-sessions/${audioSessionId}/chunks`, {
      method: "DELETE",
    }).catch(() => undefined);
  }

  const remaining = await requestJson(
    `/api/history?clientId=${encodeURIComponent(clientId)}&limit=100`,
  ).catch(() => null);
  report.cleanup = {
    historyCount: remaining?.data.conversations.length ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
}
