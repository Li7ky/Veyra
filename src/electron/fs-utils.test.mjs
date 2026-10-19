import { describe, it, expect } from "vitest";
import { writeFileAtomic } from "./fs-utils.cjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "veyra-atomic-"));
}

describe("writeFileAtomic", () => {
  it("写入内容并创建缺失的父目录", () => {
    const root = tempRoot();
    try {
      const target = path.join(root, "nested", "deep", "settings.json");
      writeFileAtomic(target, JSON.stringify({ a: 1 }), "utf8");
      expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ a: 1 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("覆盖已有文件，且不留下临时文件", () => {
    const root = tempRoot();
    try {
      const target = path.join(root, "x.json");
      writeFileAtomic(target, "old", "utf8");
      writeFileAtomic(target, "new", "utf8");
      expect(fs.readFileSync(target, "utf8")).toBe("new");
      expect(fs.readdirSync(root)).toEqual(["x.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("原文件保持可读直到替换完成（不存在「先截断」窗口）", () => {
    const root = tempRoot();
    try {
      const target = path.join(root, "keep.json");
      writeFileAtomic(target, "original-content", "utf8");
      // 写入过程中目标文件始终是完备的旧内容或新内容，绝不会是空/半截
      let sawIntermediate = false;
      const origRename = fs.renameSync;
      fs.renameSync = (...args) => {
        // rename 发生前任一时刻读取目标，都必须是完整的旧内容
        const seen = fs.readFileSync(target, "utf8");
        if (seen !== "original-content") sawIntermediate = true;
        return origRename(...args);
      };
      try {
        writeFileAtomic(target, "replacement", "utf8");
      } finally {
        fs.renameSync = origRename;
      }
      expect(sawIntermediate).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe("replacement");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rename 失败时清理临时文件并抛出", () => {
    const root = tempRoot();
    try {
      const target = path.join(root, "boom.json");
      const origRename = fs.renameSync;
      fs.renameSync = () => {
        throw new Error("EPERM: 模拟被占用");
      };
      try {
        expect(() => writeFileAtomic(target, "data", "utf8")).toThrow(/EPERM/);
      } finally {
        fs.renameSync = origRename;
      }
      // 失败路径不能把临时文件留在用户目录里
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("支持 Buffer 内容", () => {
    const root = tempRoot();
    try {
      const target = path.join(root, "b.bin");
      writeFileAtomic(target, Buffer.from([1, 2, 3]));
      expect(Array.from(fs.readFileSync(target))).toEqual([1, 2, 3]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
