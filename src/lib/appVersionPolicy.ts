export type AndroidAppVersionPolicy = {
  platform: "android";
  channel: "direct";
  latestVersion: string;
  latestBuild: number;
  minimumSupportedBuild: number;
  downloadUrl: string;
  messages: {
    vi: string;
    zh: string;
  };
};

export class AppVersionPolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppVersionPolicyConfigurationError";
  }
}

const defaultVietnameseMessage =
  "Đã có phiên bản mới. Vui lòng cập nhật để tiếp tục sử dụng.";
const defaultChineseMessage = "已有新版本，请更新后继续使用。";

function requiredText(
  environment: NodeJS.ProcessEnv,
  key: string,
) {
  const value = environment[key]?.trim() ?? "";
  if (!value) {
    throw new AppVersionPolicyConfigurationError(
      `Missing required environment variable ${key}.`,
    );
  }
  return value;
}

function positiveBuild(
  environment: NodeJS.ProcessEnv,
  key: string,
) {
  const raw = requiredText(environment, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AppVersionPolicyConfigurationError(
      `${key} must be a positive integer.`,
    );
  }
  return value;
}

function secureDownloadUrl(environment: NodeJS.ProcessEnv) {
  const raw = requiredText(environment, "ANDROID_UPDATE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppVersionPolicyConfigurationError(
      "ANDROID_UPDATE_URL must be a valid URL.",
    );
  }
  if (url.protocol !== "https:") {
    throw new AppVersionPolicyConfigurationError(
      "ANDROID_UPDATE_URL must use HTTPS.",
    );
  }
  return url.toString();
}

export function getAndroidAppVersionPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): AndroidAppVersionPolicy {
  const latestBuild = positiveBuild(environment, "ANDROID_LATEST_BUILD");
  const minimumSupportedBuild = positiveBuild(
    environment,
    "ANDROID_MIN_SUPPORTED_BUILD",
  );

  if (minimumSupportedBuild > latestBuild) {
    throw new AppVersionPolicyConfigurationError(
      "ANDROID_MIN_SUPPORTED_BUILD cannot exceed ANDROID_LATEST_BUILD.",
    );
  }

  return {
    platform: "android",
    channel: "direct",
    latestVersion: requiredText(environment, "ANDROID_LATEST_VERSION"),
    latestBuild,
    minimumSupportedBuild,
    downloadUrl: secureDownloadUrl(environment),
    messages: {
      vi:
        environment.ANDROID_UPDATE_MESSAGE_VI?.trim() ||
        defaultVietnameseMessage,
      zh:
        environment.ANDROID_UPDATE_MESSAGE_ZH?.trim() ||
        defaultChineseMessage,
    },
  };
}
