// 名称保护长度修复 + 服务器名伪装 的回归测试
import mcp from 'minecraft-protocol';
const { createSerializer, createDeserializer, states } = mcp;

const { NameProtector } = await import('../build/reverse_proxy/NameProtect.js');
const { ServerNameSpoofer, DEFAULT_SERVER_NAME_SPOOF } = await import('../build/reverse_proxy/ServerNameSpoof.js');

const ser = createSerializer({ state: states.PLAY, isServer: true, version: '1.8.9', customPackets: null });
const de = createDeserializer({ state: states.PLAY, isServer: false, version: '1.8.9', customPackets: null, noErrorLogging: true });

// ---- A. 名称保护：超长名字必须被截断，不能产生超限字段
const LONG_NAME = '我是gay我是gay我是gay我是gay'; // 24 字符
const np = new NameProtector(
  () => ({ enabled: true, name: LONG_NAME, playlist: true, chat: true, scoreboard: true }),
  () => LONG_NAME,
  ['Herta1337', 'SAVqmPNe']
);

const uuid = '11111111-2222-3333-4444-555555555555';
const playerInfo = ser.createPacketBuffer({
  name: 'player_info',
  params: {
    action: 0,
    data: [{ UUID: uuid, name: 'Herta1337', properties: [] }],
  },
});
const rewritten = np.rewrite(playerInfo);
const parsed = de.parsePacketBuffer(rewritten);
const nameOut = parsed.data.params.data[0].name;

// ---- B. 服务器名伪装：聊天 / Tab 里的 imc 要变成 heypixel
const spoofer = new ServerNameSpoofer(() => DEFAULT_SERVER_NAME_SPOOF);
const chat = ser.createPacketBuffer({
  name: 'chat',
  params: { message: JSON.stringify({ text: '欢迎来到 imc.re 服务器' }), position: 0 },
});
const chatOut = de.parsePacketBuffer(spoofer.rewrite(chat)).data.params.message;

const tab = ser.createPacketBuffer({
  name: 'playerlist_header',
  params: {
    header: JSON.stringify({ text: 'imc.re 服务器' }),
    footer: JSON.stringify({ text: '交流群 1131093494' }),
  },
});
const tabOut = de.parsePacketBuffer(spoofer.rewrite(tab)).data.params;

const title = ser.createPacketBuffer({
  name: 'title',
  params: { action: 0, text: JSON.stringify({ text: 'imc 欢迎你' }) },
});
const titleOut = de.parsePacketBuffer(spoofer.rewrite(title)).data.params.text;

console.log('===== A. 名称保护长度 =====');
console.log('  配置名长度:', LONG_NAME.length);
console.log('  player_info name:', nameOut, '长度:', nameOut.length);
console.log('  聊天替换仍生效:', (() => {
  const c = ser.createPacketBuffer({ name: 'chat', params: { message: JSON.stringify({ text: 'Herta1337 joined' }), position: 0 } });
  return de.parsePacketBuffer(np.rewrite(c)).data.params.message;
})());

console.log('===== B. 服务器名伪装 =====');
console.log('  chat :', chatOut);
console.log('  header:', tabOut.header);
console.log('  footer:', tabOut.footer);
console.log('  title :', titleOut);

const passA = nameOut.length <= 16;
const passB = chatOut.includes('heypixel') && !chatOut.includes('imc');
const passC = tabOut.header.includes('heypixel') && tabOut.footer.includes('1131093494');
const passD = titleOut.includes('heypixel');

console.log('===== 结论 =====');
console.log(`  A 列表名不超 16: ${passA ? 'PASS' : 'FAIL'}`);
console.log(`  B 聊天替换 imc→heypixel: ${passB ? 'PASS' : 'FAIL'}`);
console.log(`  C Tab 头尾替换: ${passC ? 'PASS' : 'FAIL'}`);
console.log(`  D 标题替换: ${passD ? 'PASS' : 'FAIL'}`);
const pass = passA && passB && passC && passD;
console.log(`  总体: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
