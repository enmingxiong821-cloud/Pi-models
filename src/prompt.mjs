// 交互式提问：普通文本用 readline，密钥用掩码输入（只回显 *）。
// 非 TTY 环境（脚本/CI）不会卡住，调用方需自行处理返回值。
import readline from "node:readline";
import { isTTY, warn } from "./util.mjs";

export function isInteractive() {
  // 脚本/CI/测试里可以强制关掉提问，避免在真终端里跑自测时被卡住
  if (process.env.PMH_NONINTERACTIVE === "1" || process.env.PMH_NONINTERACTIVE === "true") return false;
  return Boolean(isTTY && process.stdin.isTTY && process.stdout.isTTY);
}

/** 普通文本提问；defaultValue 在用户直接回车时生效。 */
export async function askText(label, { defaultValue = "" } = {}) {
  if (!process.stdin.isTTY) return defaultValue;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await new Promise((resolve) => rl.question(`${label}${hint}: `, resolve));
  rl.close();
  const text = answer.trim();
  return text || defaultValue;
}

/** 是否继续（回车默认 yes）。 */
export async function askConfirm(label, { defaultValue = true } = {}) {
  if (!isInteractive()) return defaultValue;
  const answer = await askText(`${label} (${defaultValue ? "Y/n" : "y/N"})`);
  if (!answer) return defaultValue;
  return /^y(es)?$/i.test(answer);
}

/** 掩码输入密钥：输入时只显示 *，避免密钥留在终端回滚缓冲里。 */
export async function askSecret(label) {
  if (!process.stdin.isTTY) return "";
  // 个别终端（老式 Windows 控制台、部分 SSH 客户端）不支持 raw mode，退化成明文输入
  try {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  } catch {
    warn("这个终端不支持掩码输入，密钥会明文显示");
    return askText(label);
  }
  process.stdout.write(`${label}: `);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    const done = (result) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKey);
      process.stdout.write("\n");
      resolve(result);
    };
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key.name === "return" || key.name === "enter") return done(value.trim());
      if (key.name === "backspace") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (str && !key.ctrl && !key.meta && str >= " ") {
        value += str;
        process.stdout.write("*");
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

export function noteNonInteractive() {
  warn("当前不是交互式终端，改用参数形式：pmh add <名称> --base <url> --key <key>");
}
