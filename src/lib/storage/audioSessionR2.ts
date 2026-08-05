import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getR2CredentialsConfig } from "@/lib/storage/config";
import {
  deleteR2Objects,
  getR2Client,
  isR2PreconditionFailed,
  readR2Object,
} from "@/lib/storage/r2";

const audioSessionPrefix = "audio-sessions";

export function getAudioSessionChunkObjectKey(
  sessionId: string,
  sequence: number,
  sha256: string,
) {
  return `${audioSessionPrefix}/${sessionId}/chunks/${sequence
    .toString()
    .padStart(6, "0")}-${sha256}.part`;
}

export async function putAudioSessionChunkObject(
  sessionId: string,
  sequence: number,
  sha256: string,
  buffer: Buffer,
) {
  const config = getR2CredentialsConfig();
  const key = getAudioSessionChunkObjectKey(sessionId, sequence, sha256);

  try {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: buffer,
        ContentType: "application/octet-stream",
        CacheControl: "private, no-store",
        IfNoneMatch: "*",
        Metadata: {
          session: sessionId,
          sequence: String(sequence),
          sha256,
        },
      }),
    );
    return { key, created: true };
  } catch (error) {
    if (isR2PreconditionFailed(error)) {
      return { key, created: false };
    }
    throw error;
  }
}

export function readAudioSessionChunkObject(key: string) {
  return readR2Object(key);
}

export function deleteAudioSessionChunkObjects(keys: string[]) {
  return deleteR2Objects(keys);
}
