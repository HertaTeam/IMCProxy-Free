import http from 'node:http';
import mcp from 'minecraft-protocol';

const { createSerializer, createDeserializer, states } = mcp;
const { ImcOverlay } = await import('../build/reverse_proxy/ImcOverlay.js');
const { profileFor } = await import('../build/reverse_proxy/ProtocolProfile.js');

const options = {
  enabled: true,
  mode: 'auto',
  apiBase: 'http://127.0.0.1:9099',
  refreshSeconds: 300,
  topRows: 5,
  decorateTab: true,
  timeoutMs: 3000,
};

const hits = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent((req.url || '').split('/').pop() || '');
  hits.push(name);
  const cheat = name === 'Cheater';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    summary: {
      name,
      matches: cheat ? 3 : 15,
      wins: cheat ? 3 : 7,
      winRate: cheat ? 1 : 0.47,
      metrics: {
        fkdr: cheat ? 42 : 2.14,
        kd: cheat ? 33 : 2.43,
        avgBeds: cheat ? 9 : 0.47,
        finalKills: cheat ? 20 : 15,
        bedsBroken: cheat ? 12 : 7,
        kills: cheat ? 40 : 34,
      },
    },
  }));
});
await new Promise((r) => server.listen(9099, '127.0.0.1', r));

const profile = profileFor('1.8.9');
const overlay = new ImcOverlay(() => options, profile);
const ser = createSerializer({ state: states.PLAY, isServer: true, version: '1.8.9', customPackets: null });
const de = createDeserializer({ state: states.PLAY, isServer: false, version: '1.8.9', customPackets: null, noErrorLogging: true });
const headerPacket = () => ser.createPacketBuffer({ name: 'playerlist_header', params: { header: '{"text":"x"}', footer: '{"text":"y"}' } });
const headerText = () => {
  const out = overlay.rewriteTabPacket(headerPacket());
  return out ? JSON.parse(de.parsePacketBuffer(out).data.params.header).text : '';
};
const footerText = () => {
  const out = overlay.rewriteTabPacket(headerPacket());
  return out ? JSON.parse(de.parsePacketBuffer(out).data.params.footer).text : '';
};

let pass = true;
const check = (label, ok, extra = '') => {
  if (!ok) pass = false;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};


overlay.noteServerChat('| 正在连接 bw #4');
overlay.setSelf('Muer');
check('识别 bw 房间号', overlay.isActive() && overlay.roomLabel() === 'bw #4', String(overlay.roomLabel()));


overlay.noteRoster(['Muer']);
await new Promise((r) => setTimeout(r, 400));
overlay.noteRoster(['Zeaqax']);
await new Promise((r) => setTimeout(r, 400));
overlay.noteRoster(['Cheater']);
await new Promise((r) => setTimeout(r, 600));
check('每个新玩家查一次', hits.length === 3 && new Set(hits).size === 3, JSON.stringify(hits));
overlay.noteRoster(['Zeaqax']);
await new Promise((r) => setTimeout(r, 400));
check('重复进入不重复查询', hits.length === 3, JSON.stringify(hits));


const text = headerText();
check('不含编造列且全英文', !text.includes('HP') && !text.includes('S.Tags') && !text.includes('★') && !/[\u4e00-\u9fa5]/.test(text), '');
const cheatLine = text.split('\n').find((l) => l.includes('Cheater')) || '';
const muerLine = text.split('\n').find((l) => l.includes('Muer')) || '';
check('异常数据标红', cheatLine.includes('§c') && cheatLine.includes('Cheater!'), JSON.stringify(cheatLine.slice(0, 50)));
check('正常数据不标红', muerLine.includes('Muer') && !muerLine.includes('!'), JSON.stringify(muerLine.slice(0, 50)));


const foot = footerText();
check('底部只显示自己（英文）', foot.indexOf('You') >= 0 && foot.indexOf('Muer') >= 0 && foot.indexOf('Kills:') < 0, JSON.stringify(foot));


overlay.noteWorldChange();
check('切换世界关闭 overlay', !overlay.isActive() && overlay.rewriteTabPacket(headerPacket()) === null);
overlay.noteServerChat('| 正在连接 bw #8');
check('再次进入重新识别', overlay.isActive() && overlay.roomLabel() === 'bw #8', String(overlay.roomLabel()));
overlay.noteRoster(['Muer']);
await new Promise((r) => setTimeout(r, 500));
check('再次进入会重新查询', hits.filter((h) => h === 'Muer').length >= 2, JSON.stringify(hits));

server.close();
console.log(`===== 总体: ${pass ? 'PASS' : 'FAIL'} =====`);
process.exit(pass ? 0 : 1);
