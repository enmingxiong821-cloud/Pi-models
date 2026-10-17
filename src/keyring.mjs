// Key 别名：活动 Key 仍写在 auth.json 的 <relay> 位置（pi 只认这里），
// 其余别名写在 <relay>@<alias>。pi 不会引用带 @ 的键，因此不会误当成 provider。
import { maskKey } from "./clipboard.mjs";

export const DEFAULT_ALIAS = "default";
export const ALIAS_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function aliasKey(relayId, alias) {
  return `${relayId}@${alias}`;
}

export function validateRelayId(relayId) {
  const id = String(relayId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(`provider 名称不合法: "${relayId}"（只能用字母/数字/._-，且以字母数字开头）`);
  }
  return id;
}

export function validateAlias(alias) {
  const a = String(alias ?? "").trim();
  if (!ALIAS_RE.test(a)) throw new Error(`Key 别名只能用字母/数字/_-，长度 1–32，收到: "${alias}"`);
  if (a.toLowerCase() === DEFAULT_ALIAS) {
    throw new Error(`"default" 是活动 Key 的保留名；用 pmh key use ${"<relay>"} ${a} 切换活动 Key 即可`);
  }
  return a;
}

/** 该 relay 是否存在可用的活动 Key（auth.json 的 <relay> 位置）。 */
export function hasActiveKey(auth, relayId) {
  return Boolean(auth?.[relayId]?.key);
}

/**
 * 取某个别名对应的 key；default 即最初配置的那把 Key。
 * 首次切走后原 Key 会存档到 <relay>@default，之后 default 始终指向存档值，
 * 而不是活动槽里的副本，这样来回切换不会因为覆盖而丢失。
 */
export function keyOf(auth, relayId, alias = DEFAULT_ALIAS) {
  if (alias === DEFAULT_ALIAS) {
    const saved = auth?.[aliasKey(relayId, DEFAULT_ALIAS)];
    return typeof saved?.key === "string" ? saved.key : auth?.[relayId]?.key ?? null;
  }
  const entry = auth?.[aliasKey(relayId, alias)];
  return typeof entry?.key === "string" ? entry.key : null;
}

/** 列出该 relay 的全部 Key（含 default），不区分活动状态。 */
export function keyAliasesOf(auth, relayId) {
  const out = [];
  const savedDefault = auth?.[aliasKey(relayId, DEFAULT_ALIAS)];
  if (typeof savedDefault?.key === "string") {
    out.push({ alias: DEFAULT_ALIAS, key: savedDefault.key });
  } else if (typeof auth?.[relayId]?.key === "string") {
    out.push({ alias: DEFAULT_ALIAS, key: auth[relayId].key });
  }
  const prefix = `${relayId}@`;
  for (const [name, entry] of Object.entries(auth ?? {})) {
    if (!name.startsWith(prefix)) continue;
    const alias = name.slice(prefix.length);
    if (!alias || !ALIAS_RE.test(alias) || alias === DEFAULT_ALIAS) continue;
    if (typeof entry?.key !== "string") continue;
    out.push({ alias, key: entry.key });
  }
  return out;
}

/** 给 doctor / key ls 用：打码后的列表，标出当前生效的那个别名。 */
export function keyStatus(auth, relayId, activeAlias = DEFAULT_ALIAS) {
  return keyAliasesOf(auth, relayId).map((entry) => ({
    ...entry,
    masked: maskKey(entry.key),
    active: entry.alias === activeAlias,
  }));
}

/**
 * 新增一个 Key 别名。不会自动启用；要启用请调用 activateAlias。
 * 如果当前还没有活动 Key，新别名会直接成为活动 Key（避免"加了却用不上"）。
 */
export function addKeyAlias(auth, relayId, alias, key, { registry = null } = {}) {
  const id = validateRelayId(relayId);
  const a = validateAlias(alias);
  const value = String(key ?? "").trim();
  if (!value) throw new Error("Key 不能为空");
  const hadActive = hasActiveKey(auth, id);
  auth[aliasKey(id, a)] = { type: "api_key", key: value };
  if (!hadActive) activateAlias(auth, registry, id, a);
  else syncRelayAliases(registry, id, auth);
  return { alias: a, active: !hadActive };
}

/** 把某个别名复制到活动位置（auth.json 的 <relay>），并更新注册表的 activeKey。 */
export function activateAlias(auth, registry, relayId, alias = DEFAULT_ALIAS) {
  const id = validateRelayId(relayId);
  const key = keyOf(auth, id, alias);
  if (!key) throw new Error(`"${id}" 没有名为 "${alias}" 的 Key（pmh key ls ${id} 查看）`);

  // 切换前把尚未命名的旧 Key 存成 "default"，避免被覆盖后找不回来。
  // default 位置本身即将被覆盖，所以只把它之外已有的别名算作"已保存"。
  const current = auth[id]?.key;
  if (typeof current === "string" && current !== key) {
    const saved = new Set(
      keyAliasesOf(auth, id)
        .filter((e) => e.alias !== DEFAULT_ALIAS)
        .map((e) => e.key),
    );
    if (!saved.has(current)) {
      const defaultSlot = aliasKey(id, DEFAULT_ALIAS);
      if (!auth[defaultSlot]) {
        auth[defaultSlot] = { type: "api_key", key: current };
      } else if (auth[defaultSlot].key !== current) {
        // 极少数情况：存档位已被占用（老版本数据或手工改过），退回 previous 命名
        let name = "previous";
        let n = 2;
        while (auth[aliasKey(id, name)] && auth[aliasKey(id, name)].key !== current) name = `previous-${n++}`;
        auth[aliasKey(id, name)] ??= { type: "api_key", key: current };
      }
    }
  }

  auth[id] = { ...(auth[id] ?? {}), type: "api_key", key };
  const relay = registry?.relays?.[id];
  if (relay) {
    relay.activeKey = alias;
    relay.keyAliases = keyAliasesOf(auth, id).map((e) => e.alias);
    relay.updatedAt = new Date().toISOString();
  }
  return { alias, key };
}

/** 删除别名。活动 Key 不能直接删，避免把正在用的凭据删掉。 */
export function removeKeyAlias(auth, registry, relayId, alias) {
  const id = validateRelayId(relayId);
  if (String(alias ?? "").trim().toLowerCase() === DEFAULT_ALIAS) {
    throw new Error(`"default" 是最初配置的 Key 存档，不能删除；先 pmh key use ${id} <其他别名> 切走`);
  }
  const a = validateAlias(alias);
  const name = aliasKey(id, a);
  if (!auth[name]) throw new Error(`"${id}" 没有名为 "${a}" 的 Key 别名`);
  if (registry?.relays?.[id]?.activeKey === a) {
    throw new Error(`"${a}" 是当前活动 Key。先切换到别的：pmh key use ${id} <其他别名>`);
  }
  delete auth[name];
  syncRelayAliases(registry, id, auth);
}

/** 从 auth.json 反推别名列表，保持注册表一致。 */
export function syncRelayAliases(registry, relayId, auth) {
  const relay = registry?.relays?.[relayId];
  if (!relay) return;
  const aliases = keyAliasesOf(auth, relayId).map((e) => e.alias);
  relay.keyAliases = aliases;
  if (!aliases.includes(relay.activeKey)) relay.activeKey = aliases[0] ?? null;
}
