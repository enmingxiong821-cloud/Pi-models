import readline from "node:readline";
import { c } from "./util.mjs";

const ESC = "\u001b[";
const MAX_ROWS = 12;

/**
 * 方向键选择器：↑↓ 移动、输入即过滤、Enter 确认、Esc/Ctrl+C 取消。
 * 不是 TTY 时自动退化成"输序号"，保证脚本里也能用。
 */
export async function pickOne(items, { title, label = (x) => String(x), marker = (x) => "", initialQuery = "" } = {}) {
  if (!items.length) return null;
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return numberedFallback(items, { title, label, initialQuery });
  }

  let query = initialQuery;
  let cursor = 0;
  let drawnLines = 0;

  const filtered = () => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const exact = items.filter((x) => label(x).toLowerCase().includes(q));
    return exact.length ? exact : items;
  };

  const render = (list) => {
    if (drawnLines) process.stdout.write(`${ESC}${drawnLines}A`);
    const lines = [];
    lines.push(`${ESC}2K${c.bold(title)}${query ? ` ${c.blue(query)}` : ""}   ${c.dim(`(${list.length} 项，↑↓ 选择，Enter 确认，Esc 取消)`)}`);
    const window = list.slice(0, MAX_ROWS);
    if (cursor >= window.length) cursor = Math.max(0, window.length - 1);
    window.forEach((item, i) => {
      const pointer = i === cursor ? c.blue("▸") : " ";
      lines.push(`${ESC}2K${pointer} ${label(item)}${marker(item)}`);
    });
    if (list.length > window.length) lines.push(`${ESC}2K${c.dim(`  … 还有 ${list.length - window.length} 项，继续输入可过滤`)}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    drawnLines = lines.length;
  };

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve) => {
    const list = () => {
      const l = filtered();
      if (cursor >= l.length) cursor = Math.max(0, l.length - 1);
      return l;
    };

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("keypress", onKey);
      if (drawnLines) process.stdout.write(`${ESC}${drawnLines}A${ESC}0J`);
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        return resolve(null);
      }
      switch (key.name) {
        case "escape":
          cleanup();
          return resolve(null);
        case "return":
        case "enter": {
          const chosen = list()[cursor] ?? null;
          cleanup();
          return resolve(chosen);
        }
        case "up":
        case "k":
          cursor = Math.max(0, cursor - 1);
          break;
        case "down":
        case "j":
          cursor = Math.min(list().length - 1, cursor + 1);
          break;
        case "backspace":
          query = query.slice(0, -1);
          cursor = 0;
          break;
        default:
          if (str && !key.ctrl && !key.meta && str >= " ") {
            query += str;
            cursor = 0;
          }
      }
      render(list());
    };

    render(list());
    stdin.on("keypress", onKey);
  });
}

/** 非 TTY 回退：打印列表让用户输序号（也支持关键词）。 */
async function numberedFallback(items, { title, label, initialQuery }) {
  const list = items.slice(0, 60);
  console.log(`\n${title}`);
  list.forEach((item, i) => console.log(`  ${String(i + 1).padStart(3)}. ${label(item)}`));
  if (items.length > list.length) console.log(`  … 共 ${items.length} 项，只显示前 ${list.length} 项`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`\n输入序号或关键词${initialQuery ? `（${initialQuery}）` : ""}: `, resolve));
  rl.close();
  const text = answer.trim() || initialQuery;
  if (!text) return null;
  if (/^\d+$/.test(text)) return list[Number(text) - 1] ?? null;
  const lower = text.toLowerCase();
  const hits = items.filter((x) => label(x).toLowerCase().includes(lower));
  return hits[0] ?? null;
}
