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

  it("refreshes custom-named subscriptions too once the cooldown passes", () => {
    // 回归：曾经 hasTraffic && !autoNamed 直接返回 false，导致手动改过名的订阅
    // 剩余流量/到期时间永远不再刷新。改名由调用方的 autoNamed 单独把关，
    // 信息刷新不应受它影响。
    const entry = {
      url: "https://example.com/sub",
      name: "My subscription",
      userinfo: { total: 1024 },
      metadataCheckedAt: now - subscriptionInfo.METADATA_REFRESH_COOLDOWN_MS,
    };
    expect(subscriptionInfo.shouldRefreshSubscriptionInfo(entry, false, now)).toBe(true);
  });

  it("still respects the cooldown for custom-named subscriptions", () => {
    const entry = {
      url: "https://example.com/sub",
      name: "My subscription",
      userinfo: { total: 1024 },
      metadataCheckedAt: now - 1000,
    };
    expect(subscriptionInfo.shouldRefreshSubscriptionInfo(entry, false, now)).toBe(false);
  });
});
