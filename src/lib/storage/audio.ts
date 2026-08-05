import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  head,
  put,
} from "@vercel/blob";
import {
  getAudioStorageBackend,
  getGeneratedAudioBlobToken,
  getR2StorageConfig,
} from "@/lib/storage/config";
import { queryDatabase } from "@/lib/db";
import {
  getR2Client,
  isR2NotFound,
  isR2PreconditionFailed,
} from "@/lib/storage/r2";

const AUDIO_PUBLIC_DIR = "generated-audio";
const immutableCacheSeconds = 31_536_000;
const safeGeneratedAudioFileName = /^[a-z0-9][a-z0-9._-]{0,254}$/i;
const maxGeneratedAudioMemoryEntries = 128;
const audioStorageGlobal = globalThis as typeof globalThis & {
  __aiSpeakingGeneratedAudioMemory?: Map<string, Buffer | true>;
};

function getGeneratedAudioMemory() {
  audioStorageGlobal.__aiSpeakingGeneratedAudioMemory ??= new Map();
  return audioStorageGlobal.__aiSpeakingGeneratedAudioMemory;
}

function readGeneratedAudioMemory(fileName: string) {
  const cache = getGeneratedAudioMemory();
  const entry = cache.get(fileName);
  if (entry === undefined) return undefined;
  cache.delete(fileName);
  cache.set(fileName, entry);
  return entry;
}

function writeGeneratedAudioMemory(fileName: string, entry: Buffer | true) {
  const cache = getGeneratedAudioMemory();
  cache.delete(fileName);
  cache.set(fileName, entry);
  while (cache.size > maxGeneratedAudioMemoryEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export type ReusableAudioDescriptor = {
  text: string;
  model: string;
  voice: string;
  speed: number;
  extension?: string;
};

function normalizeAudioText(text: string) {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function safeAudioSlug(text: string) {
  return normalizeAudioText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "speech";
}

function safeExtension(extension: string) {
  return /^[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : "mp3";
}

export function getReusableAudioFileName(
  descriptor: ReusableAudioDescriptor,
) {
  const extension = safeExtension(descriptor.extension ?? "mp3");
  const normalized = {
    text: normalizeAudioText(descriptor.text),
    model: descriptor.model.trim(),
    voice: descriptor.voice.trim(),
    speed: Number(descriptor.speed.toFixed(3)),
    extension,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 24);

  return `${safeAudioSlug(normalized.text)}-${digest}.${extension}`;
}

async function writeAudioAtomically(outputPath: string, audio: ArrayBuffer) {
  const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, Buffer.from(audio));
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function blobPath(fileName: string) {
  return `${AUDIO_PUBLIC_DIR}/${fileName}`;
}

function r2PublicUrl(fileName: string) {
  const { publicBaseUrl } = getR2StorageConfig();
  return `${publicBaseUrl}/${blobPath(fileName)
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function getR2Url(fileName: string) {
  const config = getR2StorageConfig();

  try {
    await getR2Client().send(
      new HeadObjectCommand({
        Bucket: config.bucket,
        Key: blobPath(fileName),
      }),
    );
    return r2PublicUrl(fileName);
  } catch (error) {
    if (isR2NotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function saveR2Audio(fileName: string, audio: ArrayBuffer) {
  const config = getR2StorageConfig();
  const existingUrl = await getR2Url(fileName);

  if (existingUrl) {
    return existingUrl;
  }

  try {
    await getR2Client().send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: blobPath(fileName),
        Body: Buffer.from(audio),
        ContentType: audioContentType(fileName),
        CacheControl: `public, max-age=${immutableCacheSeconds}, immutable`,
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!isR2PreconditionFailed(error)) {
      throw error;
    }
  }

  return r2PublicUrl(fileName);
}

function localAudioUrl(fileName: string) {
  return `/api/audio/cache/${encodeURIComponent(fileName)}`;
}

function audioContentType(fileName: string) {
  return fileName.toLowerCase().endsWith(".mp3")
    ? "audio/mpeg"
    : "application/octet-stream";
}

async function readPostgresAudio(fileName: string) {
  const memoryEntry = readGeneratedAudioMemory(fileName);
  if (Buffer.isBuffer(memoryEntry)) {
    return memoryEntry;
  }
  const rows = await queryDatabase<{ content_base64: string }>(
    `SELECT content_base64
       FROM generated_audio
      WHERE file_name = $1
      LIMIT 1`,
    [fileName],
  );
  const encoded = rows[0]?.content_base64;
  const audio = encoded ? Buffer.from(encoded, "base64") : null;
  if (audio) writeGeneratedAudioMemory(fileName, audio);
  return audio;
}

async function postgresAudioExists(fileName: string) {
  if (readGeneratedAudioMemory(fileName) !== undefined) {
    return true;
  }
  const rows = await queryDatabase<{ content_base64: string }>(
    `SELECT content_base64
       FROM generated_audio
      WHERE file_name = $1
      LIMIT 1`,
    [fileName],
  );
  const encoded = rows[0]?.content_base64;
  if (!encoded) return false;
  writeGeneratedAudioMemory(fileName, Buffer.from(encoded, "base64"));
  return true;
}

async function savePostgresAudio(fileName: string, audio: ArrayBuffer) {
  const buffer = Buffer.from(audio);
  await queryDatabase(
    `INSERT INTO generated_audio (
       file_name, content_base64, content_type, size_bytes
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (file_name) DO NOTHING`,
    [
      fileName,
      buffer.toString("base64"),
      audioContentType(fileName),
      buffer.byteLength,
    ],
  );
  writeGeneratedAudioMemory(fileName, buffer);
  return localAudioUrl(fileName);
}

async function getBlobUrl(fileName: string) {
  try {
    return (
      await head(blobPath(fileName), { token: getGeneratedAudioBlobToken() })
    ).url;
  } catch (error) {
    if (error instanceof BlobNotFoundError) {
      return null;
    }

    throw error;
  }
}

async function saveBlobAudio(fileName: string, audio: ArrayBuffer) {
  const existingUrl = await getBlobUrl(fileName);

  if (existingUrl) {
    return existingUrl;
  }

  try {
    const result = await put(blobPath(fileName), Buffer.from(audio), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: immutableCacheSeconds,
      contentType: fileName.endsWith(".mp3") ? "audio/mpeg" : undefined,
      token: getGeneratedAudioBlobToken(),
    });
    return result.url;
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      const url = await getBlobUrl(fileName);

      if (url) {
        return url;
      }
    }

    throw error;
  }
}

export async function saveGeneratedAudio(
  conversationId: string,
  audio: ArrayBuffer,
  extension = "mp3",
) {
  const fileName = `${conversationId}.${extension}`;

  if (getAudioStorageBackend() === "vercel-blob") {
    return saveBlobAudio(fileName, audio);
  }
  if (getAudioStorageBackend() === "r2") {
    return saveR2Audio(fileName, audio);
  }
  if (getAudioStorageBackend() === "postgres") {
    return savePostgresAudio(fileName, audio);
  }

  const relativeUrl = localAudioUrl(fileName);
  const outputDir = path.join(process.cwd(), "public", AUDIO_PUBLIC_DIR);
  const outputPath = path.join(outputDir, fileName);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, Buffer.from(audio));

  return relativeUrl;
}

export async function readGeneratedAudioFile(fileName: string) {
  if (
    !safeGeneratedAudioFileName.test(fileName) ||
    path.basename(fileName) !== fileName
  ) {
    return null;
  }

  if (getAudioStorageBackend() === "postgres") {
    return readPostgresAudio(fileName);
  }
  if (getAudioStorageBackend() === "r2") {
    return null;
  }

  const outputPath = path.join(
    process.cwd(),
    "public",
    AUDIO_PUBLIC_DIR,
    fileName,
  );

  try {
    return await readFile(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function getReusableAudioUrl(
  descriptor: ReusableAudioDescriptor,
) {
  const fileName = getReusableAudioFileName(descriptor);

  if (getAudioStorageBackend() === "vercel-blob") {
    return getBlobUrl(fileName);
  }
  if (getAudioStorageBackend() === "r2") {
    return getR2Url(fileName);
  }
  if (getAudioStorageBackend() === "postgres") {
    return (await postgresAudioExists(fileName))
      ? localAudioUrl(fileName)
      : null;
  }

  const outputPath = path.join(process.cwd(), "public", AUDIO_PUBLIC_DIR, fileName);

  try {
    await access(outputPath);
    return localAudioUrl(fileName);
  } catch {
    return null;
  }
}

export async function saveReusableAudio(
  descriptor: ReusableAudioDescriptor,
  audio: ArrayBuffer,
) {
  const fileName = getReusableAudioFileName(descriptor);

  if (getAudioStorageBackend() === "vercel-blob") {
    return saveBlobAudio(fileName, audio);
  }
  if (getAudioStorageBackend() === "r2") {
    return saveR2Audio(fileName, audio);
  }
  if (getAudioStorageBackend() === "postgres") {
    return savePostgresAudio(fileName, audio);
  }

  const relativeUrl = localAudioUrl(fileName);
  const outputDir = path.join(process.cwd(), "public", AUDIO_PUBLIC_DIR);
  const outputPath = path.join(outputDir, fileName);

  await mkdir(outputDir, { recursive: true });
  await writeAudioAtomically(outputPath, audio);

  return relativeUrl;
}
