import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getR2CredentialsConfig } from "@/lib/storage/config";

const r2Global = globalThis as typeof globalThis & {
  __aiSpeakingR2Client?: S3Client;
};

export function getR2Client() {
  if (!r2Global.__aiSpeakingR2Client) {
    const config = getR2CredentialsConfig();
    r2Global.__aiSpeakingR2Client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  return r2Global.__aiSpeakingR2Client;
}

export function isR2NotFound(error: unknown) {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

export function isR2PreconditionFailed(error: unknown) {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  return status === 409 || status === 412;
}

export async function readR2Object(key: string) {
  const config = getR2CredentialsConfig();
  const response = await getR2Client().send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`R2 object không có nội dung: ${key}`);
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

export async function deleteR2Objects(keys: string[]) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return;
  const config = getR2CredentialsConfig();

  for (let offset = 0; offset < uniqueKeys.length; offset += 1_000) {
    await getR2Client().send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Quiet: true,
          Objects: uniqueKeys
            .slice(offset, offset + 1_000)
            .map((Key) => ({ Key })),
        },
      }),
    );
  }
}

export async function pingR2Bucket() {
  const startedAt = Date.now();
  const config = getR2CredentialsConfig();
  await getR2Client().send(new HeadBucketCommand({ Bucket: config.bucket }));
  return { ok: true, latencyMs: Date.now() - startedAt };
}
