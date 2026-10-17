import { Chalk } from "chalk";

const color = new Chalk({ level: 2 });

/**
 * 控制台界面。
 *
 * 布局：
 *
 *   I ... 启动日志 ...
 *   ------------------------------------------------------------
 *   > 用户输入                                    ← 输入框固定在最底部
 *
 * 日志插入方式：清掉输入行 → 上移一行清掉分隔线 → 写日志 → 重画分隔线与输入框。
 * 结果就是日志在输入框上方不断向上滚动，输入框永远停在最底部，
 * 终端自带的回滚缓冲（上下翻页看历史）完全不受影响。
 *
 * 非 TTY（管道 / 重定向）时自动退化为逐行输出，不做任何光标控制。
 */

const PROMPT = "> ";

export class ConsoleUi {
  private enabled = false;
  private active = false;
  private buffer = "";
  private original: Map<NodeJS.WriteStream, typeof process.stdout.write> = new Map();

  private separator(): string {
    const width = Math.max(40, Math.min((process.stdout.columns ?? 64) - 1, 78));
    return "-".repeat(width);
  }

  private out(text: string): void {
    if (this.active) this.raw(text);
    else process.stdout.write(text);
  }

  private raw(text: string): void {
    const original = this.original.get(process.stdout);
    if (original) original(text);
    else process.stdout.write(text);
  }

  /**
   * 启用底部输入框。
   * @param inputBox false = 朴素模式（不接管输出，也不画输入框，交给终端回显）
   */
  enable(inputBox = true): void {
    if (this.enabled) return;
    this.enabled = true;

    const tty = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
    this.active = tty && inputBox;

    if (this.active) {
      this.patch(process.stdout);
      this.patch(process.stderr);
    }

    this.out(this.separator() + "\n");
    if (this.active) this.renderInput();
  }

  disable(): void {
    if (!this.enabled) return;
    for (const [stream, original] of this.original) {
      (stream as any).write = original;
    }
    this.original.clear();
    this.active = false;
    this.enabled = false;
  }

  isActive(): boolean {
    return this.active;
  }

  /* --------------------------------------------------------- 输入行 */

  getBuffer(): string {
    return this.buffer;
  }

  appendChar(ch: string): void {
    this.buffer += ch;
    this.renderInput();
  }

  backspace(): void {
    if (!this.buffer) return;
    this.buffer = this.buffer.slice(0, -1);
    this.renderInput();
  }

  clearInput(): void {
    this.buffer = "";
    this.renderInput();
  }

  /** 整段替换输入内容（Tab 补全用） */
  setBuffer(text: string): void {
    this.buffer = text;
    this.renderInput();
  }

  /** 回车：把这一行留在上方历史里，然后清空输入框 */
  commitInput(): void {
    const line = this.buffer;
    this.buffer = "";
    if (this.active) this.printAbove(color.green(PROMPT) + line);
  }

  private renderInput(): void {
    if (!this.active) return;
    this.raw("\x1b[2K\r" + color.green(PROMPT) + this.buffer);
  }

  /* ----------------------------------------------------- 日志插入 */

  /** 在输入框上方插入一行（保持输入框在底部） */
  printAbove(text: string): void {
    if (!this.active) {
      process.stdout.write(text + "\n");
      return;
    }

    this.raw("\x1b[2K\r"); // 清掉输入行
    this.raw("\x1b[1A\x1b[2K\r"); // 上移到分隔线并清掉
    this.raw(text + "\n"); // 日志落在分隔线原来的位置
    this.raw(this.separator() + "\n"); // 重画分隔线
    this.raw(color.green(PROMPT) + this.buffer); // 重画输入框
  }

  /* -------------------------------------------------------- 流接管 */

  private patch(stream: NodeJS.WriteStream): void {
    if (this.original.has(stream)) return;
    const original = stream.write.bind(stream) as typeof process.stdout.write;
    this.original.set(stream, original);

    const ui = this;
    (stream as any).write = function (chunk: any, encoding?: any, callback?: any): boolean {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);

      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        if (isLast && parts[i] === "") break; // 以换行结尾，末尾空串不用输出
        ui.printAbove(parts[i]);
      }

      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return true;
    };
  }
}

export const consoleUi = new ConsoleUi();
