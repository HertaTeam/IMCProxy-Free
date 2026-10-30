// imc 新登录方式（聊天栏直接发密码）的回归测试
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? '.';
const isFree = /IMCProxy-Free/i.test(root);

const tmpDir = path.join(root, 'recon', 'tmp-login-test');
fs.mkdirSync(tmpDir, { recursive: true });

const sent = [];
const hooks = {
  identity: () => ({ realName: 'Player', serverName: 'Muer', uuid: '00000000-0000-0000-0000-000000000000' }),
  sendToServer: (msg) => sent.push(msg),
  sendToClient: () => {},
};

async function buildAutomation() {
  if (isFree) {
    const { GameAutomation } = await import('../build/reverse_proxy/GameAutomation.js');
    const { saveGameAccount } = await import('../build/reverse_proxy/AutoFiles.js');
    const accountFile = path.join(tmpDir, 'game-account.txt');
    saveGameAccount(accountFile, { username: 'Muer', password: 'gamepass123', savedAt: new Date().toISOString() });
    const automation = new GameAutomation({
      enabled: true,
      gameAccountFile: accountFile,
      defaultGamePassword: 'defpass',
      inGameReplies: false,
      autoLoginOnJoin: true,
      autoRegisterOnJoin: true,
    });
    return automation;
  }

  const { GameAutomation } = await import('../build/reverse_proxy/GameAutomation.js');
  const { ImcClient } = await import('../build/reverse_proxy/ImcClient.js');
  const { loadImcAccounts, saveImcAccounts, upsertImcAccount } = await import('../build/reverse_proxy/ImcAccounts.js');
  const { saveGameAccount } = await import('../build/reverse_proxy/AutoFiles.js');

  const imcFile = path.join(tmpDir, 'imc-account.txt');
  saveImcAccounts(imcFile, upsertImcAccount([], { account: 'webacct', password: 'webpass456' }));

  const accountFile = path.join(tmpDir, 'game-account.txt');
  saveGameAccount(accountFile, { username: 'Muer', password: 'gamepass123', savedAt: new Date().toISOString() });

  const imc = new ImcClient({
    baseUrl: 'https://api.imc.re',
    apiToken: '',
    sessionFile: path.join(tmpDir, '.session.json'),
    capTokenFile: path.join(tmpDir, '.captoken.json'),
    autoLogin: false,
    browserLogin: false,
    keepBrowserSession: false,
    browserProfile: path.join(tmpDir, '.profile'),
    browserPath: '',
    browserTimeoutMs: 5000,
  });

  return new GameAutomation(imc, {
    enabled: true,
    gameAccountFile: accountFile,
    imcAccountFile: imcFile,
    bindCodeFile: path.join(tmpDir, 'bind-code.txt'),
    defaultGamePassword: 'defpass',
    inGameReplies: false,
    autoLoginOnJoin: true,
    autoRegisterOnJoin: true,
    autoBindOnJoin: true,
    autoImcOnJoin: true,
  });
}

const automation = await buildAutomation();
const logLine = '| 直接在聊天框发送网页账号的密码即可登录';

// 1) 新登录方式
automation.handleServerMessage('Player', logLine, hooks);
const first = sent.slice();

// 2) 第二种排版（同一句被打散）
sent.length = 0;
automation.handleServerMessage('Player', '也可打开网页，在弹出的提示里点选 西瓜 即可一键登录', hooks);
const second = sent.slice();

// 3) 登录成功不应抛错
automation.handleServerMessage('Player', '| 登录成功', hooks);

// 4) 老提示仍应走 /login
sent.length = 0;
automation.handleServerMessage('Player', '请使用/login 登录', hooks);
const third = sent.slice();

const expectedPassword = isFree ? 'gamepass123' : 'webpass456';

console.log(`===== ${isFree ? 'free' : 'main'} =====`);
console.log('  新登录方式发送内容:', JSON.stringify(first));
console.log('  散装排版发送内容:', JSON.stringify(second));
console.log('  老提示发送内容 :', JSON.stringify(third));

const pass1 = first.length === 1 && first[0] === expectedPassword;
const pass2 = second.length === 0; // 这句只是提示语，不应重复发密码
const pass3 = third.length === 1 && third[0] === '/login gamepass123';

console.log(`  新方式发送密码: ${pass1 ? 'PASS' : 'FAIL'}`);
console.log(`  "一键登录"提示不重复发送: ${pass2 ? 'PASS' : 'FAIL'}`);
console.log(`  旧 /login 提示仍可用: ${pass3 ? 'PASS' : 'FAIL'}`);

fs.rmSync(tmpDir, { recursive: true, force: true });
const pass = pass1 && pass2 && pass3;
console.log(`  总体: ${pass ? 'PASS' : 'FAIL'}`);
process.exit(pass ? 0 : 1);
