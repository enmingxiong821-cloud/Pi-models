// 终端补全：`pmh completion <shell>` 输出脚本，脚本回调 `pmh __complete <命令> <当前词>`。
// 只读本地配置，任何异常都退化成"没有候选"，绝不让 Tab 卡住或报错。
import { readJson } from "./util.mjs";
import { LOCAL_PRESETS } from "./native.mjs";

const COMMANDS = [
  "add", "quick", "local", "model", "auto", "import", "scan", "sync", "key", "ls", "models", "current",
  "group", "relay", "fav", "recent", "meta", "use", "switch", "scope", "test",
  "run", "pick", "install-extension", "alias", "rm", "doctor", "completion", "help", "feedback",
];

const FLAGS = [
  "--help", "--json", "--dry-run", "--verbose", "--yes", "--agent-dir", "--catalog", "--proxy",
  "--group", "--tag", "--api", "--api-rule", "--base", "--key", "--key-env", "--model",
  "--models-file", "--cost-multiplier", "--no-cost", "--ratio", "--no-reasoning-compat",
  "--thinking", "--allow-builtin", "--purge-key", "--run", "--filter", "--limit", "--clear",
  "--from", "--as", "--shell", "--no-sync", "--force", "--keep-missing", "--refresh-meta",
  "--key-in", "--name", "--no-key", "--no-chat", "--key-ref", "--key-cmd", "--prompt-cache",
  "--purge-backups", "--format", "--ctx", "--max-output", "--cost-in", "--cost-out",
  "--cache-read", "--cache-write", "--override", "--override-only", "--port", "--image",
  "--text-only", "--reasoning", "--no-reasoning", "--local", "--copy", "--link", "--package",
  "--print", "--open",
];

const LOCAL_NAMES = Object.values(LOCAL_PRESETS).map((preset) => preset.id);
const MODEL_SUBCOMMANDS = ["ls", "add", "override", "rm"];
const AUTO_SUBCOMMANDS = ["status", "doctor", "on", "off", "set", "unset", "thresholds", "pin", "explain", "install", "sync"];
const AUTO_TIERS = ["cheap", "standard", "strong"];

export const SHELLS = ["powershell", "bash", "zsh", "fish"];

function safeJson(file, fallback) {
  try {
    return readJson(file, fallback);
  } catch {
    return fallback;
  }
}

function providerIds(ctx) {
  const models = safeJson(ctx.paths.models, { providers: {} });
  return Object.keys(models?.providers ?? {}).sort();
}

function groupIds(ctx) {
  const registry = safeJson(ctx.paths.registry, {});
  return Object.keys(registry?.groups ?? {}).sort();
}

function switchEntryIds(ctx) {
  const models = safeJson(ctx.paths.models, { providers: {} });
  const registry = safeJson(ctx.paths.registry, {});
  const favorites = [];
  const recent = [];
  for (const relay of Object.values(registry?.relays ?? {})) {
    if (!models?.providers?.[relay.id]) continue;
    for (const model of relay.favorites ?? []) favorites.push(`${relay.id}#${model}`);
    for (const entry of relay.mru ?? []) recent.push(`${relay.id}#${entry.model}`);
  }
  return [...new Set([...favorites, ...recent])].slice(0, 60);
}

function filterByWord(list, word) {
  const items = [...new Set(list.filter(Boolean))];
  if (!word) return items;
  const lower = word.toLowerCase();
  return items.filter((item) => item.toLowerCase().startsWith(lower));
}

/**
 * 返回补全候选（每行一个）。
 * command 是 `pmh` 后面的第一个词，word 是当前正在输入的词。
 */
export function completionCandidates(ctx, { command = "", word = "" } = {}) {
  const cmd = String(command ?? "");
  const cur = String(word ?? "");
  if (cur.startsWith("-")) return filterByWord(FLAGS, cur);

  const providers = providerIds(ctx);
  const groups = groupIds(ctx).map((g) => `@${g}`);
  const switchables = switchEntryIds(ctx);
  const filterSpecs = [...groups, "@fav", "recent"];

  switch (cmd) {
    case "":
      return filterByWord(COMMANDS, cur);
    case "use":
    case "switch":
    case "run":
      return filterByWord([...switchables, ...filterSpecs, ...providers], cur);
    case "pick":
      return filterByWord([...filterSpecs, ...providers, ...switchables], cur);
    case "add":
    case "quick":
    case "sync":
    case "test":
    case "rm":
    case "remove":
    case "models":
    case "meta":
    case "alias":
      return filterByWord(providers, cur);
    case "relay":
      return filterByWord(["group", ...providers], cur);
    case "key":
      return filterByWord(["ls", "add", "use", "rm", ...providers], cur);
    case "local":
      return filterByWord(LOCAL_NAMES, cur);
    case "model":
      return filterByWord([...MODEL_SUBCOMMANDS, ...providers], cur);
    case "auto":
      return filterByWord([...AUTO_SUBCOMMANDS, ...AUTO_TIERS, ...providers], cur);
    case "group":
      return filterByWord(["ls", "add", "rm", ...groupIds(ctx)], cur);
    case "fav":
    case "favorite":
      return filterByWord(["ls", "add", "rm", "toggle", ...switchables], cur);
    case "completion":
      return filterByWord(SHELLS, cur);
    case "import":
    case "scan":
      return filterByWord(["--from", "--dry-run", "--yes", "--json", "clipboard", "claude", "codex", "ccswitch", "all"], cur);
    default:
      return filterByWord([...COMMANDS, ...FLAGS], cur);
  }
}

/** 根据 $SHELL / 平台猜一个默认 shell。 */
export function detectShell(env = process.env, platform = process.platform) {
  const explicit = String(env.PMH_SHELL ?? "").trim().toLowerCase();
  if (SHELLS.includes(explicit)) return explicit;
  const name = String(env.SHELL ?? "").split(/[\\/]/).pop().toLowerCase();
  if (name === "pwsh" || name === "powershell") return "powershell";
  if (SHELLS.includes(name)) return name;
  return platform === "win32" ? "powershell" : "bash";
}

/** 生成对应 shell 的补全脚本（纯 ASCII，避免 Windows 控制台编码问题）。 */
export function completionScript(shell) {
  const name = String(shell ?? "").toLowerCase();
  if (name === "powershell" || name === "pwsh" || name === "ps") {
    return [
      "Register-ArgumentCompleter -Native -CommandName pmh,pmh.cmd -ScriptBlock {",
      "    param($wordToComplete, $commandAst, $cursorPosition)",
      "    $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })",
      "    $cmd = if ($tokens.Count -ge 2) { $tokens[1] } else { '' }",
      "    pmh __complete $cmd -- $wordToComplete 2>$null | ForEach-Object {",
      "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
      "    }",
      "}",
    ].join("\n");
  }
  if (name === "bash") {
    return [
      "_pmh_completions() {",
      "  local cur cmd line",
      '  cur="${COMP_WORDS[COMP_CWORD]}"',
      '  cmd="${COMP_WORDS[1]}"',
      "  COMPREPLY=()",
      "  while IFS= read -r line; do",
      '    [ -n "$line" ] && COMPREPLY+=("$line")',
      '  done < <(pmh __complete "$cmd" -- "$cur" 2>/dev/null)',
      "}",
      "complete -F _pmh_completions pmh",
    ].join("\n");
  }
  if (name === "zsh") {
    return [
      "#compdef pmh",
      "_pmh_completions() {",
      "  local -a candidates",
      "  local line",
      "  while IFS= read -r line; do",
      '    [[ -n "$line" ]] && candidates+=("$line")',
      '  done < <(pmh __complete "${words[2]}" -- "${words[CURRENT]}" 2>/dev/null)',
      "  compadd -Q -a candidates",
      "}",
      "compdef _pmh_completions pmh 2>/dev/null || true",
    ].join("\n");
  }
  if (name === "fish") {
    return [
      "function __pmh_complete",
      "    set -l tokens (commandline -opc)",
      '    set -l cmd ""',
      "    if test (count $tokens) -ge 2",
      "        set cmd $tokens[2]",
      "    end",
      "    pmh __complete $cmd -- (commandline -ct) 2>/dev/null",
      "end",
      "complete -c pmh -f -a '(__pmh_complete)'",
    ].join("\n");
  }
  throw new Error(`不支持的 shell: "${shell}"（可选 ${SHELLS.join(" / ")}）`);
}
