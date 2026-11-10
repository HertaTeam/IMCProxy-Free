import { Chalk } from "chalk";

const color = new Chalk({ level: 2 });

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

  setBuffer(text: string): void {
    this.buffer = text;
    this.renderInput();
  }

  commitInput(): void {
    const line = this.buffer;
    this.buffer = "";
    if (this.active) this.printAbove(color.green(PROMPT) + line);
  }

  private renderInput(): void {
    if (!this.active) return;
    this.raw("\x1b[2K\r" + color.green(PROMPT) + this.buffer);
  }

  printAbove(text: string): void {
    if (!this.active) {
      process.stdout.write(text + "\n");
      return;
    }

    this.raw("\x1b[2K\r");
    this.raw("\x1b[1A\x1b[2K\r");
    this.raw(text + "\n");
    this.raw(this.separator() + "\n");
    this.raw(color.green(PROMPT) + this.buffer);
  }

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
        if (isLast && parts[i] === "") break;
        ui.printAbove(parts[i]);
      }

      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return true;
    };
  }
}

export const consoleUi = new ConsoleUi();
