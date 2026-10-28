// 被 kick 时的日志格式回归：用日志里真实出现过的 JSON 组件作为输入
import { ReverseProxy } from '../build/reverse_proxy/ReverseProxy.js';
import { MineProtocol } from '../build/proxy/Protocol.js';

const proxy = new ReverseProxy({
  tcpHost: '0.0.0.0',
  tcpPort: 25565,
  eaglerServer: 'wss://example.invalid',
  maxPlayers: 1,
  defaultSkinId: 0,
  debug: false,
});

const kick = (reason) => proxy.parseKickPacket(Buffer.concat([Buffer.from([0x40]), MineProtocol.writeString(reason)]));

const cases = [
  {
    name: '频繁登录',
    input: '{"color":"red","extra":[{"text":"Unable to connect to "},{"text":"imc4"},{"text":": "},{"text":"您的登录过于频繁，请稍后重试。"}],"text":""}',
    expect: 'Unable to connect to imc4: 您的登录过于频繁，请稍后重试。',
  },
  {
    name: '封禁（多行 + 嵌套）',
    input: '{"color":"red","extra":[{"text":"You were kicked from "},{"text":"imc4"},{"text":": "},{"extra":[{"bold":true,"color":"gold","text":"IMC.RE"},{"text":" "},{"bold":true,"text":"禁令"},{"text":"\\n\\n"},{"strikethrough":true,"color":"gold","text":"---*------------------------*---"},{"text":"\\n\\n"},{"bold":true,"color":"red","text":"你的账户已被禁止访问至"},{"text":"\\n"},{"underlined":true,"color":"gray","text":"2026-10-24 14:25 (UTC+8)"},{"text":"\\n\\n"},{"bold":true,"text":"防作弊系统检测到异常行为"},{"text":"\\n\\n"},{"color":"gray","text":"封禁编号 |"},{"text":" "},{"color":"gold","text":"#30811"},{"text":"\\n\\n"},{"color":"gray","text":"对处罚有异议，请在网页「游戏账号」的处罚记录中选择对应处罚申诉"},{"text":"\\n"},{"strikethrough":true,"color":"gold","text":"---*------------------------*---"},{"text":"\\n"},{"color":"gold","text":"PLAY.IMC.RE"}],"text":""}],"text":""}',
    expect: 'You were kicked from imc4: IMC.RE 禁令',
    expectContains: ['IMC.RE 禁令', '你的账户已被禁止访问至', '2026-10-24 14:25 (UTC+8)', '#30811', 'PLAY.IMC.RE'],
  },
  {
    name: '纯文本',
    input: '请使用正确的Eaglercraft客户端连接本服务器！',
    expect: '请使用正确的Eaglercraft客户端连接本服务器！',
  },
  {
    name: '§ 颜色码',
    input: '§cServer closed',
    expect: 'Server closed',
  },
];

let pass = true;
for (const c of cases) {
  const out = kick(JSON.stringify(c.input) === JSON.stringify(c.input) ? c.input : c.input);
  const lines = out.split('\n');
  const firstOk = lines[0] === c.expect;
  const containsOk = (c.expectContains ?? []).every((part) => out.includes(part));
  const noJson = !out.includes('{"') && !out.includes('"text"');
  const noCodes = !out.includes('§');
  const ok = firstOk && containsOk && noJson && noCodes;
  if (!ok) pass = false;
  console.log(`--- ${c.name}: ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`    行数=${lines.length} 无JSON=${noJson} 无§码=${noCodes}`);
  lines.slice(0, 12).forEach((l) => console.log('    | ' + l));
}

console.log(`===== 总体: ${pass ? 'PASS' : 'FAIL'} =====`);
process.exit(pass ? 0 : 1);
