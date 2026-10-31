![IMCProxy-Free](src/assets/imcplogo.jpg)

<p align="center">
  <img src="src/assets/01-default.png" alt="01-default" width="9%" />
  <img src="src/assets/02-9f3669f6.jpg" alt="02-9f3669f6" width="9%" />
  <img src="src/assets/03-d1661936.webp" alt="03-d1661936" width="9%" />
  <img src="src/assets/04-naven.jpg" alt="04-naven" width="9%" />
  <img src="src/assets/10-213b61c8.png" alt="10-213b61c8" width="9%" />
  <img src="src/assets/11-20861eb1.png" alt="11-20861eb1" width="9%" />
  <img src="src/assets/12-8b4f3459.png" alt="12-8b4f3459" width="9%" />
  <img src="src/assets/13-82d56970.png" alt="13-82d56970" width="9%" />
  <img src="src/assets/18-0efd3296.jpg" alt="18-0efd3296" width="9%" />
  <img src="src/assets/05-qq20260730-092440.png" alt="05-qq20260730-092440" width="9%" />
</p>
<p align="center">
  <img src="src/assets/06-qq20260730-092430.png" alt="06-qq20260730-092430" width="10%" />
  <img src="src/assets/07-0429f799.png" alt="07-0429f799" width="10%" />
  <img src="src/assets/08-minecraft-steve.jpg" alt="08-minecraft-steve" width="10%" />
  <img src="src/assets/09-b8e54ed8.jpg" alt="09-b8e54ed8" width="10%" />
  <img src="src/assets/14-qq20260704-161420.png" alt="14-qq20260704-161420" width="10%" />
  <img src="src/assets/15-dc33c2d9.png" alt="15-dc33c2d9" width="10%" />
  <img src="src/assets/16-qq20260627-223452.png" alt="16-qq20260627-223452" width="10%" />
  <img src="src/assets/17-4149804e.jpg" alt="17-4149804e" width="10%" />
  <img src="src/assets/19-65c0b720.jpg" alt="19-65c0b720" width="10%" />
</p>

# IMCProxy-Free

让原版 Minecraft 1.8.9 客户端连接 Eaglercraft WebSocket 服务器。

![fuckimc](src/assets/fuckimc.png)

在增加反作弊和增加氪金玩家无敌之间选择了删除玩家

傻逼imc修复了个几把 我分分钟给你破了

使用Spam耀武扬威的司马了

> **项目状态：已暂停开发**
>
> 本项目已暂停制作新内容，仅维护现有功能可以正常工作。
>
> 交流群：**1131093494**

## 功能

- 将 Minecraft TCP 协议转换为 Eaglercraft WebSocket 协议
- 支持原版 Minecraft 1.8.9 客户端
- 自动处理握手、皮肤、KeepAlive 等
- 支持人人插


### 环境要求

- Node.js 18+
- npm


### 配置

编辑 `src/reverse_proxy/config.ts`：

```typescript
export const config: ReverseProxyConfig = {
  tcpHost: "0.0.0.0",      // 监听地址
  tcpPort: 25565,          // 监听端口
  eaglerServer: "wss://你的服务器地址",  // Eaglercraft 服务器地址
  maxPlayers: 20,          // 最大玩家数
  defaultSkinId: 0,        // 默认皮肤 ID
  randomIdMode: "startup", // 随便ID模式: "off" | "startup" | "perConnection"
  randomIdLength: 8,       // 随机ID长度 (3-16)
  debug: false,            // 调试模式
};
```

### 运行

Windows:
```bash
build-and-run.bat
```

Linux/macOS:
```bash
npm run build
npm run start
```

### 连接

使用 Minecraft 1.8.9 客户端，服务器地址填写运行代理的机器 IP。



## 控制台指令

代理运行时，直接在运行代理的窗口里输入以下指令（回车生效）：

| 指令 | 说明 |
| --- | --- |
| `/randomname`、`/randomid`、`/rid` | 重新生成一个随机ID，之后的连接使用它 |
| `/setname <id>`、`/setid <id>`、`/sid <id>` | 使用自定义ID（3-16 位，只能包含 `a-z A-Z 0-9 _`） |
| `/log`（或 `/debug`）`[on\|off]` | 开/关数据包调试日志；不带参数就是切换。游玩中随时可用，不需要重启 |
| `/help`（或 `?`） | 显示帮助、当前模式与当前ID |



## 已知问题

- 部分服务器的反作弊插件可能会误判
- 某些 Eaglercraft 特有功能可能不完全支持


## 致谢

- [Eaglercraft](https://github.com/lax1dude/eaglerxserver) - Eaglercraft 服务器实现
- [minecraft-protocol](https://github.com/PrismarineJS/node-minecraft-protocol) - Minecraft 协议库
- 爱来自某人/Eaglercraft-Reverse-Proxy(已关库跑路)

