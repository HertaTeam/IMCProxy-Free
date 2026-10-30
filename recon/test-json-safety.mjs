// 客户端 JSON 崩溃回归：任何被改写的聊天组件都必须仍是合法 JSON，且不被截断
import mcp from 'minecraft-protocol';
const { createSerializer, createDeserializer, states } = mcp;

const { NameProtector } = await import('../build/reverse_proxy/NameProtect.js');
const { ServerNameSpoofer, DEFAULT_SERVER_NAME_SPOOF } = await import('../build/reverse_proxy/ServerNameSpoof.js');

const ser = createSerializer({ state: states.PLAY, isServer: true, version: '1.8.9', customPackets: null });
const de = createDeserializer({ state: states.PLAY, isServer: false, version: '1.8.9', customPackets: null, noErrorLogging: true });

// 故意用「超长 + 带引号 + 带反斜杠」的名字，最容易把 JSON 拼接写坏
const NASTY = '我是gay"\\我是gay我是gay我是gay';
const np = new NameProtector(
  () => ({ enabled: true, name: NASTY, playlist: true, chat: true, scoreboard: true }),
  () => NASTY,
  ['Herta1337']
);
const spoofer = new ServerNameSpoofer(() => DEFAULT_SERVER_NAME_SPOOF);
const uuid = '11111111-2222-3333-4444-555555555555';

const cases = [];
const push = (label, packet, pick) => cases.push({ label, packet, pick });

// 1) player_info：name 是纯字符串（截到 16），displayName 是 JSON 组件（不能被截断）
push(
  'player_info name + displayName',
  ser.createPacketBuffer({
    name: 'player_info',
    params: {
      action: 0,
      data: [
        {
          UUID: uuid,
          name: 'Herta1337',
          properties: [],
          gamemode: 0,
          ping: 0,
          displayName: JSON.stringify({ text: 'Herta1337' }),
        },
      ],
    },
  }),
  (p) => JSON.stringify({ name: p.data.params.data[0].name, displayName: p.data.params.data[0].displayName })
);

// 2) chat：JSON 组件，必须合法且含完整名字
push(
  'chat JSON',
  ser.createPacketBuffer({
    name: 'chat',
    params: { message: JSON.stringify({ text: 'Herta1337 joined imc.re' }), position: 0 },
  }),
  (p) => p.data.params.message
);

// 3) 计分板目标显示文本（上限 32，JSON 不能截断）
push(
  'scoreboard_objective displayText',
  ser.createPacketBuffer({
    name: 'scoreboard_objective',
    params: { name: 'obj', action: 0, displayText: JSON.stringify({ text: 'Herta1337 的分数 imc' }), type: 'integer' },
  }),
  (p) => p.data.params.displayText
);

// 4) 队伍前后缀（上限 16，JSON 不能截断）
push(
  'scoreboard_team prefix',
  ser.createPacketBuffer({
    name: 'scoreboard_team',
    params: {
      team: 'team1',
      mode: 0,
      name: JSON.stringify({ text: 'Herta1337' }),
      prefix: JSON.stringify({ text: 'Herta1337 ' }),
      suffix: JSON.stringify({ text: ' imc' }),
      friendlyFire: 0,
      nameTagVisibility: 'always',
      color: 0,
      players: ['Herta1337'],
    },
  }),
  (p) => JSON.stringify({ name: p.data.params.name, prefix: p.data.params.prefix, suffix: p.data.params.suffix, players: p.data.params.players })
);

let pass = true;
for (const c of cases) {
  const buffer = np.rewrite(spoofer.rewrite(c.packet));
  let out;
  let ok = true;
  let note = '';
  try {
    out = c.pick(de.parsePacketBuffer(buffer));
  } catch (err) {
    ok = false;
    note = '包解析失败: ' + err.message;
  }

  if (ok) {
    const strings = typeof out === 'string' ? [out] : Object.values(out).flat().filter((v) => typeof v === 'string');
    for (const s of strings) {
      const t = s.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          JSON.parse(t);
        } catch (err) {
          ok = false;
          note = 'JSON 非法: ' + err.message + ' -> ' + t.slice(0, 60);
        }
      }
    }
    if (ok && c.label === 'player_info 名字' && out.length > 16) {
      ok = false;
      note = '名字超过 16: ' + out.length;
    }
  }

  if (!ok) pass = false;
  console.log(`--- ${c.label}: ${ok ? 'PASS' : 'FAIL'}`);
  console.log('    ' + (typeof out === 'string' ? out : JSON.stringify(out)).slice(0, 150));
  if (note) console.log('    ' + note);
}

console.log(`===== 总体: ${pass ? 'PASS' : 'FAIL'} =====`);
process.exit(pass ? 0 : 1);
