import { describe, expect, it } from "vitest";
import subscriptionInfo from "./subscription-info.cjs";

describe("subscription metadata refresh", () => {
  const now = 1_800_000_000_000;

  it("checks missing metadata once per cooldown even when the provider omits headers", () => {
    const entry = { url: "https://example.com/sub", metadataCheckedAt: now - 1000 };
    expect(subscriptionInfo.shouldRefreshSubscriptionInfo(entry, true, now)).toBe(false);
    expect(subscriptionInfo.shouldRefreshSubscriptionInfo(
      { ...entry, metadataCheckedAt: now - subscriptionInfo.METADATA_REFRESH_COOLDOWN_MS },
      true,
      now
    )).toBe(true);
  });

  it("does not refresh complete custom-named subscriptions", () => {
    const entry = {
      url: "https://example.com/sub",
      name: "My subscription",
      userinfo: { total: 1024 },
    };
    expect(subscriptionInfo.shouldRefreshSubscriptionInfo(entry, false, now)).toBe(false);
  });
});
