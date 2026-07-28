import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppVersionPolicyConfigurationError,
  getAndroidAppVersionPolicy,
} from "./appVersionPolicy";

function configuredEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ANDROID_LATEST_VERSION: "1.0.1",
    ANDROID_LATEST_BUILD: "3",
    ANDROID_MIN_SUPPORTED_BUILD: "2",
    ANDROID_UPDATE_URL: "https://download.example.com/android",
    ...overrides,
  };
}

test("returns a validated direct Android update policy", () => {
  const policy = getAndroidAppVersionPolicy(configuredEnvironment());

  assert.equal(policy.platform, "android");
  assert.equal(policy.channel, "direct");
  assert.equal(policy.latestVersion, "1.0.1");
  assert.equal(policy.latestBuild, 3);
  assert.equal(policy.minimumSupportedBuild, 2);
  assert.equal(policy.downloadUrl, "https://download.example.com/android");
  assert.ok(policy.messages.vi.length > 0);
  assert.ok(policy.messages.zh.length > 0);
});

test("rejects a minimum supported build above the latest build", () => {
  assert.throws(
    () =>
      getAndroidAppVersionPolicy(
        configuredEnvironment({ ANDROID_MIN_SUPPORTED_BUILD: "4" }),
      ),
    AppVersionPolicyConfigurationError,
  );
});

test("rejects missing, invalid, and insecure configuration", () => {
  assert.throws(
    () =>
      getAndroidAppVersionPolicy(
        configuredEnvironment({ ANDROID_LATEST_BUILD: "three" }),
      ),
    AppVersionPolicyConfigurationError,
  );
  assert.throws(
    () =>
      getAndroidAppVersionPolicy(
        configuredEnvironment({ ANDROID_UPDATE_URL: "http://example.com" }),
      ),
    AppVersionPolicyConfigurationError,
  );
  assert.throws(
    () =>
      getAndroidAppVersionPolicy(
        configuredEnvironment({ ANDROID_LATEST_VERSION: "" }),
      ),
    AppVersionPolicyConfigurationError,
  );
});
