import fs from 'node:fs';

const p = 'D:/项目文件夹/代理工具/veyra-latest/src/src-tauri/tauri.conf.json';
const raw = fs.readFileSync(p, 'utf8');
const next = raw.replace(/,\s*"dataDirectory":\s*"WebView2Data"/, '');
fs.writeFileSync(p, next, 'utf8');
JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('dataDirectory present:', /dataDirectory/.test(next));
console.log('JSON OK');
