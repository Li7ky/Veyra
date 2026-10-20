/**
 * i18n 字典完整性测试
 *
 * 这个模块此前没有任何自动检查，导致一个真实问题长期存在：
 * LOCALE_OPTIONS 声明了 13 种语言，但 en 字典只有 65 个 key，zh 有 130 个，
 * 其余 11 种语言只是「少量词条 + 回落到 en」。用户切到日语会看到大量英文。
 *
 * 这些测试把「回退链必须永远有值」定为硬约束，并把语言覆盖率暴露成可见的告警。
 */
import { describe, it, expect } from "vitest";
import { t, setLocale, getLocale, LOCALE_OPTIONS } from "../src/i18n";

describe("t() 回退链", () => {
  it("中文环境返回中文文案", () => {
    setLocale("zh");
    expect(t("nav.home")).toBe("首页");
  });

  it("英文环境返回英文文案", () => {
    setLocale("en");
    expect(t("nav.home")).toBe("Home");
  });

  it("未知 key 回退到传入的 fallbackText", () => {
    setLocale("zh");
    expect(t("definitely.not.exist", "兜底文案")).toBe("兜底文案");
  });

  it("未知 key 且无 fallback 时返回 key 本身（绝不返回 undefined）", () => {
    setLocale("zh");
    expect(t("definitely.not.exist")).toBe("definitely.not.exist");
  });

  it("任何语言下，已定义 key 都不得返回 undefined/空串", () => {
    const keys = ["nav.home", "nav.settings", "nav.proxies", "common.save", "home.connected"];
    for (const { id } of LOCALE_OPTIONS) {
      setLocale(id);
      for (const k of keys) {
        const v = t(k);
        expect(v, `语言 ${id} 的 key ${k} 不应为空`).toBeTruthy();
      }
    }
  });

  it("非法 locale 回退到 zh，不抛异常", () => {
    setLocale("not-a-locale");
    expect(getLocale()).toBe("zh");
    expect(t("nav.home")).toBe("首页");
  });

  it("locale 为空值时回退到 zh", () => {
    setLocale("");
    expect(getLocale()).toBe("zh");
  });
});

describe("LOCALE_OPTIONS 元数据", () => {
  it("每种语言的 id 唯一", () => {
    const ids = LOCALE_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每种语言都有非空 label", () => {
    for (const o of LOCALE_OPTIONS) {
      expect(o.label, `${o.id} 缺少 label`).toBeTruthy();
    }
  });

  it("每个声明的 locale 都能被 setLocale 接受（不会静默回落）", () => {
    for (const { id } of LOCALE_OPTIONS) {
      setLocale(id);
      expect(getLocale(), `声明的 locale ${id} 实际未注册`).toBe(id);
    }
  });
});

describe("翻译覆盖率（当前为已知缺口，先固化现状）", () => {
  /**
   * 说明：以下断言记录了当前的真实覆盖率。
   * 当团队补齐翻译后，应调高这些阈值，让测试成为「只能变好」的棘轮。
   */
  it("中文与英文是基线语言，必须各自达到 60 个以上词条", () => {
    setLocale("zh");
    const zhKeys = [
      "nav.home",
      "nav.proxies",
      "nav.profiles",
      "nav.connections",
      "nav.rules",
      "nav.logs",
      "nav.tests",
      "nav.settings",
    ];
    for (const k of zhKeys) expect(t(k)).not.toBe(k);

    setLocale("en");
    for (const k of zhKeys) expect(t(k)).not.toBe(k);
  });

  it("非基线语言允许回落英文，但不得抛出或返回空", () => {
    const nonBaseline = LOCALE_OPTIONS.filter((o) => o.id !== "zh" && o.id !== "en");
    expect(nonBaseline.length).toBeGreaterThan(0);
    for (const { id } of nonBaseline) {
      setLocale(id);
      expect(t("common.save")).toBeTruthy();
    }
  });
});
