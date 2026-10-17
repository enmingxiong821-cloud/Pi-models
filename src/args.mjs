/** 宽松参数解析：--k v / --k=v / --no-k / `--` 之后原样透传。 */

/** 允许重复出现的参数（其余重复时取最后一个，避免下游拿到数组）。 */
const REPEATABLE = new Set(["apiRule", "file", "from", "tag"]);

export function parseArgs(argv) {
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
        const base = key.slice(3).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        // 兼容两种写法：旧代码读 flags.noXxx，新代码可读 flags.xxx === false
        flags[`no${base[0].toUpperCase()}${base.slice(1)}`] = true;
        flags[base] = false;
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
  for (const [key, value] of Object.entries(flags)) {
    if (Array.isArray(value) && !REPEATABLE.has(key)) flags[key] = value.at(-1);
  }
  return { flags, positional, rest };
}
