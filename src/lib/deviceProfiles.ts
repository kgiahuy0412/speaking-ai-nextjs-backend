import "server-only";

import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DeviceProfile } from "@/types/admin";
import { isPostgresStorageEnabled } from "@/lib/db";
import { getRecord, listRecords, putRecord } from "@/lib/db/records";

type DeviceProfileFile = Record<string, DeviceProfile>;

const dataDir = path.join(process.cwd(), "data");
const profilePath = path.join(dataDir, "device-profiles.json");
const profileNamespace = "device_profiles";
let memoryProfiles: DeviceProfileFile | null = null;
let mutationQueue: Promise<void> = Promise.resolve();

function isFileNotFound(error: unknown) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function defaultDeviceName(clientId: string) {
  if (clientId === "legacy") {
    return "Dữ liệu cũ chưa gắn thiết bị";
  }

  const shortId = clientId.length > 16 ? `${clientId.slice(0, 16)}…` : clientId;
  return `Thiết bị ${shortId}`;
}

async function readProfileFile() {
  if (memoryProfiles) {
    return memoryProfiles;
  }

  try {
    memoryProfiles = JSON.parse(
      await readFile(profilePath, "utf8"),
    ) as DeviceProfileFile;
  } catch (error) {
    if (isFileNotFound(error)) {
      memoryProfiles = {};
    } else {
      throw error;
    }
  }

  return memoryProfiles;
}

async function writeProfileFile(profiles: DeviceProfileFile) {
  const temporaryPath = path.join(
    dataDir,
    `.device-profiles-${crypto.randomUUID()}.tmp`,
  );
  await mkdir(dataDir, { recursive: true });

  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(profiles, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, profilePath);
    memoryProfiles = profiles;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function enqueueMutation<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function createDefaultDeviceProfile(clientId: string): DeviceProfile {
  const now = new Date().toISOString();

  return {
    clientId,
    deviceName: defaultDeviceName(clientId),
    createdAt: now,
    updatedAt: now,
  };
}

export async function readDeviceProfiles() {
  if (isPostgresStorageEnabled()) {
    const profiles = await listRecords<DeviceProfile>(profileNamespace, {
      limit: 100_000,
    });
    return Object.fromEntries(
      profiles.map((profile) => [profile.clientId, profile]),
    );
  }

  await mutationQueue;
  return { ...(await readProfileFile()) };
}

export async function upsertDeviceProfile(
  clientId: string,
  input: { deviceName?: string; childName?: string },
) {
  if (isPostgresStorageEnabled()) {
    const stored = await getRecord<DeviceProfile>(profileNamespace, clientId);
    const existing = stored?.value ?? createDefaultDeviceProfile(clientId);
    const now = new Date().toISOString();
    const deviceName = input.deviceName?.trim();
    const childName = input.childName?.trim();
    const profile: DeviceProfile = {
      ...existing,
      deviceName: deviceName || existing.deviceName,
      childName: childName || undefined,
      updatedAt: now,
    };

    await putRecord({
      namespace: profileNamespace,
      key: clientId,
      clientId,
      createdAt: profile.createdAt,
      value: profile,
    });
    return profile;
  }

  return enqueueMutation(async () => {
    const profiles = { ...(await readProfileFile()) };
    const existing = profiles[clientId] ?? createDefaultDeviceProfile(clientId);
    const now = new Date().toISOString();
    const deviceName = input.deviceName?.trim();
    const childName = input.childName?.trim();

    const profile: DeviceProfile = {
      ...existing,
      deviceName: deviceName || existing.deviceName,
      childName: childName || undefined,
      updatedAt: now,
    };

    profiles[clientId] = profile;
    await writeProfileFile(profiles);
    return profile;
  });
}
