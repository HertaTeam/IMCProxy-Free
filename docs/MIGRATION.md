# 免费版迁移说明

本目录从正式版 C++ 项目 `imcpc` 派生：保留代理与显示层，去掉所有 imc.re 网络能力，换成本地游戏账号管理。

## 保留

- 协议层、Eaglercraft 握手、双向转发
- 名称保护、服务器名改写
- 控制台（颜色自适应、输入框重绘）、配置、HTTP API、备份、更新日志
- 自动化：按服务器提示自动 `/login`、`/reg`，凭据来自 `game-accounts.txt` 或 `game-account.txt`
- 输出格式、启动横幅

## 移除

- `ImcClient`、`BrowserCap`（Edge CDP）、`AccountPool`（imc 账号池）
- `Overlay`（Tab 战绩，会请求 api.imc.re）
- 命令：`/loginimc` `/imccookie` `/imccap` `/imcobtain` `/imcregister` `/imcverify` `/imcprofile` `/imclinks` `/imclogout` `/imcsync` `/imcstatus` `/imcadd` `/imcremove` `/imcbind` `/bind` `/unbind` `/stats`
- 配置段：`imc`、`overlay`

## 新增

- `src/features/GameAccounts.*`：`game-accounts.txt` 读写（账号 密码 [备注]，自动剥离 BOM）
- 命令：`/gamestatus` `/logingame` `/gameadd` `/gamedel`
- 配置：`automation.gameAccountsFile`、`randomId.preferAccounts`

## 兼容

- 旧 `game-account.txt`（`key=value` 或 `账号 密码`）继续可读，用于给自动 `/login` 提供默认密码
- `config.json` 里多余的 `imc`、`overlay` 段会被忽略，不会触发任何网络请求
