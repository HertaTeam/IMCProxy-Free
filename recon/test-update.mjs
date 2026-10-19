// 更新提示（只比对编辑日期，不自动更新）
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('version.json');
const original = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;

const { loadVersionState, bumpDailyCount, checkForUpdates, formatNotice } = await import(
  '../build/reverse_proxy/UpdateCheck.js'
);

const cfg = { enabled: true, repo: 'HertaTeam/IMCProxy-Free', timeoutMs: 3000, notifyInGame: false };
const reset = (state) => fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
const today = new Date().toISOString().slice(0, 10);

// ---- A. 当日次数 +1 ----
reset({ editDate: '2026-10-19', count: 2, countDate: today });
const a1 = bumpDailyCount();
const a2 = bumpDailyCount();

// ---- B. 跨天清零 ----
reset({ editDate: '2026-10-19', count: 7, countDate: '2000-01-01' });
const b = bumpDailyCount();

// ---- C. 远端日期不同 → 提示更新 ----
reset({ editDate: '2026-10-19', count: 0, countDate: today });
globalThis.fetch = async () => ({
  ok: true,
  text: async () => JSON.stringify({ editDate: '2026-11-01', count: 0, countDate: '2026-11-01' }),
});
const c = await checkForUpdates(cfg);

// ---- D. 日期相同 → 已是最新 ----
globalThis.fetch = async () => ({
  ok: true,
  text: async () => JSON.stringify({ editDate: '2026-10-19', count: 0, countDate: '2026-10-19' }),
});
const d = await checkForUpdates(cfg);

// ---- E. 网络失败 → unknown ----
globalThis.fetch = async () => {
  throw new Error('network down');
};
const e = await checkForUpdates(cfg);

// ---- F. 关闭检查 ----
const f = await checkForUpdates({ ...cfg, enabled: false });

// ---- G. version.json 不应该再包含 version 字段 ----
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

if (original !== null) fs.writeFileSync(FILE, original, 'utf8');

console.log('===== A. 当日次数 =====');
console.log(`  连跑两次: ${a1.count} -> ${a2.count}`);
console.log('===== B. 跨天清零 =====');
console.log(`  countDate=2000-01-01, count=7 -> count=${b.count}, countDate=${b.countDate}`);
console.log('===== C/D/E/F 日期比对 =====');
console.log(`  C 日期不同: ${c.status}  local=${c.localDate} remote=${c.remoteDate}`);
console.log(`  D 日期相同: ${d.status}`);
console.log(`  E 断网:     ${e.status}`);
console.log(`  F 已关闭:   ${f.status}`);
console.log('===== G. 提示文案 =====');
console.log('  ' + formatNotice(c));
console.log('  ' + formatNotice(d));

const passA = a1.count === 3 && a2.count === 4;
const passB = b.count === 1 && b.countDate === today;
const passC = c.status === 'outdated' && c.remoteDate === '2026-11-01';
const passD = d.status === 'up-to-date';
const passE = e.status === 'unknown';
const passF = f.status === 'unknown';
const passG = !('version' in raw);

console.log('===== 结论 =====');
console.log(`  A 次数累加:   ${passA ? 'PASS' : 'FAIL'}`);
console.log(`  B 跨天清零:   ${passB ? 'PASS' : 'FAIL'}`);
console.log(`  C 日期不同提示: ${passC ? 'PASS' : 'FAIL'}`);
console.log(`  D 日期相同不打扰: ${passD ? 'PASS' : 'FAIL'}`);
console.log(`  E 断网静默:   ${passE ? 'PASS' : 'FAIL'}`);
console.log(`  F 可关闭:     ${passF ? 'PASS' : 'FAIL'}`);
console.log(`  G 无 version 字段: ${passG ? 'PASS' : 'FAIL'}`);
const pass = passA && passB && passC && passD && passE && passF && passG;
console.log(`  总体: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
