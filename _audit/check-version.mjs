import fs from "node:fs";
const files = [
  "src-tauri/data/changelog.json",
  "src-tauri/tauri.conf.json",
  "package.json",
  "package-lock.json",
];
for (const f of files) {
  const raw = fs.readFileSync(f, "utf8");
  try {
    const j = JSON.parse(raw);
    const v = j.version ?? j.packages?.[""]?.version ?? "";
    console.log("OK  ", f.padEnd(32), v);
  } catch (e) {
    console.log("FAIL", f, e.message);
  }
}
const c = JSON.parse(fs.readFileSync("src-tauri/data/changelog.json", "utf8"));
console.log("entries:", c.length, "| head:", c[0].version, c[0].date, "| dup:", c.length - new Set(c.map((x) => x.version)).size);
console.log("cargo:", /^version\s*=\s*"(.+)"/m.exec(fs.readFileSync("src-tauri/Cargo.toml", "utf8"))[1]);
console.log("lock  :", /\[\[package\]\]\r?\nname = "veyra-omini"\r?\nversion = "(.+)"/.exec(fs.readFileSync("src-tauri/Cargo.lock", "utf8"))[1]);
