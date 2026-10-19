/**
 * 文件写入辅助：原子替换。
 *
 * 直接 writeFileSync 会「先截断再写」，写到一半断电/进程被杀/磁盘满，
 * 目标文件就只剩半截。对 settings.json / runtime 配置这类文件来说，
 * 半截内容会被读取方的 catch 静默当成「不存在」→ 回退默认值或启动失败，
 * 用户看到的是「设置全没了」「内核起不来」却没有任何报错线索。
 *
 * 统一走 临时文件 + rename：rename 在同一分区上是原子的，
 * 要么看到旧文件，要么看到完整的新文件，不存在中间态。
 */

const fs = require("fs");
const path = require("path");

/**
 * 原子写文件。
 * @param {string} target 目标路径
 * @param {string|Buffer} data 内容
 * @param {string} [encoding] 传入时按该编码写入（如 "utf8"）
 */
function writeFileAtomic(target, data, encoding) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // 同目录下的临时文件才能保证 rename 不跨分区（跨分区 rename 会抛 EXDEV）
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}`);
  try {
    if (encoding) fs.writeFileSync(tmp, data, encoding);
    else fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (e) {
    // 失败时清掉临时文件，避免在用户目录里越堆越多
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能根本没创建成功 */
    }
    throw e;
  }
}

module.exports = { writeFileAtomic };
