import fs from "node:fs";

const FROM = "1.1.10-beta.3";
const TO = "1.1.10-beta.4";
const files = [
  "package.json",
  "package-lock.json",
  "public/mock-ipc.js",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/data/changelog.json",
];

for (const f of files) {
  const before = fs.readFileSync(f, "utf8");
  const hits = before.split(FROM).length - 1;
  if (!hits) {
    console.log("SKIP", f, "(no match)");
    continue;
  }
  const after = before.split(FROM).join(TO);
  fs.writeFileSync(f, after, "utf8");
  console.log("BUMP", f, `x${hits}`);
}

// 复核
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  console.log("now ", f.padEnd(30), TO, "| old left:", s.includes(FROM));
}
const c = JSON.parse(fs.readFileSync("src-tauri/data/changelog.json", "utf8"));
console.log("changelog head:", c[0].version, c[0].date, c[0].channel, "| entries:", c.length, "| dup:", c.length - new Set(c.map((x) => x.version)).size);
