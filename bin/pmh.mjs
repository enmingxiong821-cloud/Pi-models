#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cmdAdd, cmdAlias, cmdAuto, cmdCurrent, cmdDoctor, cmdFav, cmdGroup, cmdImport, cmdInstallExtension, cmdKey, cmdLocal,
  cmdLs, cmdMeta, cmdModel, cmdPick, cmdQuick, cmdRecent, cmdRelay, cmdRm, cmdRun, cmdScope, cmdSync, cmdTest,
  cmdUse, makeContext, printHelp,
} from "../src/commands.mjs";
import { completionCandidates, completionScript, detectShell } from "../src/completion.mjs";
import { configPaths, resolveAgentDir } from "../src/paths.mjs";
import { fail, log, setJsonMode } from "../src/util.mjs";
import { parseArgs } from "../src/args.mjs";

const { flags, positional, rest } = parseArgs(process.argv.slice(2));
setJsonMode(flags.json);
const command = positional.shift() ?? (flags.help || flags.h ? "help" : "help");

/** 只读配置路径的轻量上下文：不加载官方模型目录，适合补全/状态这类高频命令。 */
const lightContext = () => {
  const agentDir = resolveAgentDir(flags.agentDir);
  return { agentDir, paths: configPaths(agentDir), flags };
};

const NETWORK_COMMANDS = new Set(["add", "setup", "init", "quick", "go", "local", "sync", "test", "import", "scan", "meta"]);

/**
 * Node 24 的 fetch 默认不读系统代理，需要 NODE_USE_ENV_PROXY=1，而该变量要在进程启动前生效，
 * 所以这里对联网命令做一次自我重启，把代理环境准备好再干活。
 */
if (
  NETWORK_COMMANDS.has(command) &&
  !process.env.PMH_REEXEC &&
  !process.env.PMH_NO_PROXY &&
  process.env.NODE_USE_ENV_PROXY !== "1" &&
  (flags.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
) {
  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    PMH_REEXEC: "1",
  };
  if (flags.proxy) {
    env.HTTPS_PROXY = flags.proxy;
    env.HTTP_PROXY = flags.proxy;
  }
  const res = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", env });
  process.exit(res.status ?? 1);
}

try {
  switch (command) {
    case "add": {
      const ctx = makeContext(flags);
      await cmdAdd(ctx, positional[0], flags);
      break;
    }
    case "setup":
    case "init": {
      // 向导：等价于不带任何参数的 add
      await cmdAdd(makeContext(flags), positional[0], flags);
      break;
    }
    case "quick":
    case "go": {
      await cmdQuick(makeContext(flags), positional[0], positional[1], flags);
      break;
    }
    case "local": {
      await cmdLocal(makeContext(flags), positional[0], flags);
      break;
    }
    case "model": {
      cmdModel(makeContext(flags), positional, flags);
      break;
    }
    case "auto": {
      cmdAuto(makeContext(flags), positional, flags);
      break;
    }
    case "import": {
      await cmdImport(makeContext(flags), positional, flags);
      break;
    }
    case "scan": {
      await cmdImport(makeContext(flags), positional, { ...flags, scan: true });
      break;
    }
    case "group": {
      cmdGroup(makeContext(flags), positional, flags);
      break;
    }
    case "relay": {
      cmdRelay(makeContext(flags), positional);
      break;
    }
    case "fav":
    case "favorite": {
      cmdFav(makeContext(flags), positional, flags);
      break;
    }
    case "recent": {
      cmdRecent(makeContext(flags), flags);
      break;
    }
    case "meta": {
      await cmdMeta(makeContext(flags), positional[0], flags);
      break;
    }
    case "sync": {
      const ctx = makeContext(flags);
      await cmdSync(ctx, positional[0], flags);
      break;
    }
    case "key": {
      cmdKey(makeContext(flags), positional, flags);
      break;
    }
    case "ls":
    case "list": {
      cmdLs(makeContext(flags), flags);
      break;
    }
    case "models": {
      flags.models = true;
      cmdLs(makeContext(flags), flags);
      break;
    }
    case "current":
    case "status": {
      cmdCurrent(lightContext(), flags);
      break;
    }
    case "completion": {
      log(completionScript(positional[0] ?? detectShell()));
      break;
    }
    case "__complete": {
      try {
        // 补全词可能以 "-" 开头（如 "--js"），shell 脚本用 `--` 透传，避免被参数解析吃掉。
        const args = positional;
        const cmdWord = args[0] ?? "";
        const cur = rest.length ? rest[0] ?? "" : args[1] ?? "";
        // 补全只读 models/registry，跳过官方目录加载，减少每次 Tab 的启动开销。
        const agentDir = resolveAgentDir(flags.agentDir);
        const ctx = { agentDir, paths: configPaths(agentDir), flags };
        for (const line of completionCandidates(ctx, { command: cmdWord, word: cur })) {
          console.log(line);
        }
      } catch {
        /* 补全失败必须静默，不能打断用户输入 */
      }
      break;
    }
    case "use":
    case "switch": {
      await cmdUse(makeContext(flags), positional.join(" "), flags);
      break;
    }
    case "scope": {
      cmdScope(makeContext(flags), positional, flags);
      break;
    }
    case "test": {
      await cmdTest(makeContext(flags), positional[0], flags);
      break;
    }
    case "run": {
      const runTarget = positional.join(" ");
      if (!runTarget) await cmdPick(makeContext(flags), { run: true });
      else await cmdRun(makeContext(flags), runTarget, rest, flags);
      break;
    }
    case "install-extension":
    case "install-ext": {
      cmdInstallExtension(makeContext(flags), flags);
      break;
    }
    case "pick": {
      if (positional[0]) flags.filter = positional[0];
      await cmdPick(makeContext(flags), flags);
      break;
    }
    case "alias": {
      cmdAlias(makeContext(flags), flags);
      break;
    }
    case "rm":
    case "remove": {
      cmdRm(makeContext(flags), positional[0], flags);
      break;
    }
    case "doctor": {
      await cmdDoctor(makeContext(flags));
      break;
    }
    case "help":
    case "--help":
      printHelp();
      break;
    default:
      fail(`未知命令 "${command}"`);
      printHelp();
      process.exitCode = 1;
  }
} catch (err) {
  fail(err.message);
  process.exitCode = 1;
}
