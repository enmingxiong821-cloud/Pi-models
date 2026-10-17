#!/usr/bin/env node
// 轻量检索/抓取工具：沙箱里 curl 的 TLS 不可用，但 Node 的 fetch 可用。
// 用法：
//   node tools/ws.mjs search "<query>" [count]
//   node tools/ws.mjs get <url>
//   node tools/ws.mjs dump <url> <outFile>
import { writeFileSync } from "node:fs";

// 需要代理时自己设 HTTPS_PROXY（例如本地 Clash/V2Ray 的 http://127.0.0.1:7890）。
process.env.NODE_USE_ENV_PROXY ??= "1";

const UA = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const strip = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(25000) });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchTextOld(url) {
  const res = await fetch(url, { headers: UA, redirect: "follow" });
  const body = await res.text();
  return { status: res.status, body };
}

function parseDdg(body, count) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m;
  while ((m = re.exec(body)) && out.length < count) {
    let href = m[1];
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) href = decodeURIComponent(uddg[1]);
    out.push({ title: strip(m[2]), url: href, snippet: m[3] ? strip(m[3]).slice(0, 300) : "" });
  }
  return out;
}

function parseBing(body, count) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(body)) && out.length < count) {
    out.push({ title: strip(m[2]), url: m[1], snippet: strip(m[3]).slice(0, 300) });
  }
  return out;
}

async function search(query, count = 8) {
  const errors = [];
  for (const [name, url, parse] of [
    ["ddg", `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parseDdg],
    ["bing", `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, parseBing],
  ]) {
    try {
      const { body } = await fetchText(url);
      const out = parse(body, count);
      if (out.length) return out;
      errors.push(`${name}: 0 results`);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return [{ title: "(搜索失败)", url: "", snippet: errors.join(" | ") }];
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "search") {
  const q = rest.filter((a) => !/^\d+$/.test(a)).join(" ");
  const n = Number(rest.find((a) => /^\d+$/.test(a)) ?? 8);
  for (const r of await search(q, n)) {
    console.log(`- ${r.title}\n  ${r.url}\n  ${r.snippet}\n`);
  }
} else if (cmd === "get") {
  const { status, body } = await fetchText(rest[0]);
  console.log(`HTTP ${status}\n${strip(body).slice(0, Number(rest[1] ?? 6000))}`);
} else if (cmd === "dump") {
  const { status, body } = await fetchText(rest[0]);
  writeFileSync(rest[1], body, "utf8");
  console.log(`HTTP ${status} -> ${rest[1]} (${body.length} bytes)`);
} else {
  console.log("usage: node tools/ws.mjs search <query> [count] | get <url> [chars] | dump <url> <file>");
}
