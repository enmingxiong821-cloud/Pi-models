#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cmdAdd, cmdAlias, cmdDoctor, cmdInstallExtension, cmdKey, cmdLs, cmdPick, cmdQuick, cmdRm, cmdRun, cmdScope, cmdSync, cmdTest,
  cmdUse, makeContext, printHelp,
} from "../src/commands.mjs";
import { fail } from "../src/util.mjs";

/** 宽松参数解析：--k v / --k=v / --no-k / 重复出现自动变数组 / `--` 之后原样透传。 */
function parse(argv) {
  const flags = {};
  const positional = [];
  let rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      let value;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      const camel = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (key.startsWith("no-")) {
        flags[key.slice(3).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = false;
        continue;
      }
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
      if (camel in flags) flags[camel] = [].concat(flags[camel], value);
      else flags[camel] = value;
    } else if (arg.startsWith("-") && arg.length > 1 && positional.length === 0) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional, rest };
}

const { flags, positional, rest } = parse(process.argv.slice(2));
const command = positional.shift() ?? (flags.help || flags.h ? "help" : "help");

const NETWORK_COMMANDS = new Set(["add", "sync", "test"]);

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
    case "sync": {
      const ctx = makeContext(flags);
      await cmdSync(ctx, positional[0], flags);
      break;
    }
    case "key": {
      const ctx = makeContext(flags);
      cmdKey(ctx, positional[0], positional[1]);
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
    case "use":
    case "switch": {
      await cmdUse(makeContext(flags), positional[0], flags);
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
      if (!positional[0]) await cmdPick(makeContext(flags), { run: true });
      else cmdRun(makeContext(flags), positional[0], rest, flags);
      break;
    }
    case "install-extension":
    case "install-ext": {
      cmdInstallExtension(makeContext(flags), flags);
      break;
    }
    case "pick": {
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
