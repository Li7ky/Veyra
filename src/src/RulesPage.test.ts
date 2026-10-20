/**
 * 规则列表归一化测试
 *
 * 回归防线：曾经 Clash API 的 /rules 返回 { type, payload, proxy } 对象，
 * 渲染层用 String(r) 兜底导致界面出现 "[object Object]"，类型列也全错。
 * 该测试确保以后无论上游返回什么形状，都不会再产出坏数据。
 */
import { describe, it, expect } from "vitest";
import { normalizeRule } from "./RulesPage";

describe("normalizeRule - Clash API 标准形状", () => {
  it("解析 { type, payload } 对象（这是 [object Object] Bug 的原始场景）", () => {
    expect(normalizeRule({ type: "DomainSuffix", payload: "google.com" })).toEqual({
      payload: "google.com",
      type: "DomainSuffix",
    });
  });

  it("解析带 proxy/size 的完整 Clash 规则对象", () => {
    const r = normalizeRule({ type: "RuleSet", payload: "reject", proxy: "REJECT", size: 1 });
    expect(r).toEqual({ payload: "reject", type: "RuleSet" });
  });

  it("保持后端已有形状不变", () => {
    expect(normalizeRule({ payload: "1.1.1.1/8", type: "IPCIDR" })).toEqual({
      payload: "1.1.1.1/8",
      type: "IPCIDR",
    });
  });
});

describe("normalizeRule - 兼容形状", () => {
  it("字符串输入原样转成 payload，type 取默认值", () => {
    expect(normalizeRule("DOMAIN-SUFFIX,x.com,PROXY")).toEqual({
      payload: "DOMAIN-SUFFIX,x.com,PROXY",
      type: "Rule",
    });
  });

  it("兼容 rule / raw / value 字段作为 payload", () => {
    expect(normalizeRule({ rule: "A" })?.payload).toBe("A");
    expect(normalizeRule({ raw: "B" })?.payload).toBe("B");
    expect(normalizeRule({ value: "C" })?.payload).toBe("C");
  });

  it("缺少 type 时回落到 'Rule'", () => {
    expect(normalizeRule({ payload: "X" })?.type).toBe("Rule");
    expect(normalizeRule({ payload: "X", type: "   " })?.type).toBe("Rule");
  });

  it("去除首尾空白", () => {
    expect(normalizeRule("  SPACED  ")).toEqual({ payload: "SPACED", type: "Rule" });
    expect(normalizeRule({ payload: "  padded  ", type: " Match " })).toEqual({
      payload: "padded",
      type: "Match",
    });
  });
});

describe("normalizeRule - 拒绝坏数据", () => {
  it("null / undefined 返回 null", () => {
    expect(normalizeRule(null)).toBeNull();
    expect(normalizeRule(undefined)).toBeNull();
  });

  it("空字符串 / 纯空白返回 null", () => {
    expect(normalizeRule("")).toBeNull();
    expect(normalizeRule("   ")).toBeNull();
  });

  it("对象缺少可用 payload 时返回 null（不产生 [object Object]）", () => {
    expect(normalizeRule({})).toBeNull();
    expect(normalizeRule({ type: "X" })).toBeNull();
    expect(normalizeRule({ payload: 123 })).toBeNull();
    expect(normalizeRule({ payload: {} })).toBeNull();
  });

  it("number / boolean 等原始类型返回 null", () => {
    expect(normalizeRule(42)).toBeNull();
    expect(normalizeRule(true)).toBeNull();
  });

  it("任何输入都不会产出含 '[object Object]' 的结果", () => {
    const nasty: unknown[] = [{}, { type: "Rule" }, [1, 2, 3], { payload: { nested: true } }];
    for (const input of nasty) {
      const r = normalizeRule(input);
      expect(r?.payload ?? "").not.toContain("[object Object]");
    }
  });
});
