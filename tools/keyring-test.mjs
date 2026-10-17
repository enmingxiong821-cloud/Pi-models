#!/usr/bin/env node
// Key 别名测试：命名校验、自动启用、切换时保留旧 Key、打码、删除保护。
import assert from "node:assert/strict";
import {
  DEFAULT_ALIAS, activateAlias, addKeyAlias, aliasKey, keyAliasesOf, keyOf, keyStatus,
  removeKeyAlias, syncRelayAliases, validateAlias,
} from "../src/keyring.mjs";
import { emptyRegistry } from "../src/registry.mjs";

const step = (name, fn) => {
  fn();
  console.error(`  ✔ ${name}`);
};

step("别名命名：只允许安全字符，default 保留", () => {
  assert.equal(validateAlias("backup-2"), "backup-2");
  assert.throws(() => validateAlias("bad alias"), /只能用/);
  assert.throws(() => validateAlias("default"), /保留名/);
  assert.throws(() => validateAlias(""), /只能用/);
  assert.throws(() => validateAlias("a".repeat(33)), /只能用/);
});

step("没有活动 Key 时，新增别名自动成为活动 Key", () => {
  const auth = {};
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", keyAliases: [], activeKey: null };
  const res = addKeyAlias(auth, "crow5", "main", "sk-main-0001", { registry });
  assert.equal(res.active, true);
  assert.equal(auth.crow5.key, "sk-main-0001");
  assert.equal(auth[aliasKey("crow5", "main")].key, "sk-main-0001");
  assert.equal(registry.relays.crow5.activeKey, "main");
  assert.deepEqual(keyAliasesOf(auth, "crow5").map((e) => e.alias), ["default", "main"]);
});

step("已有活动 Key 时，新增别名不抢活动位", () => {
  const auth = { crow5: { type: "api_key", key: "sk-main-0001" } };
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", keyAliases: ["default"], activeKey: "default" };
  const res = addKeyAlias(auth, "crow5", "backup", "sk-backup-0002", { registry });
  assert.equal(res.active, false);
  assert.equal(auth.crow5.key, "sk-main-0001");
  assert.equal(registry.relays.crow5.activeKey, "default");
});

step("切换活动 Key：复制到 pi 认的位置，原 Key 存档为 default", () => {
  const auth = { crow5: { type: "api_key", key: "sk-main-0001" } };
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", keyAliases: ["default", "backup"], activeKey: "default" };
  auth[aliasKey("crow5", "backup")] = { type: "api_key", key: "sk-backup-0002" };
  activateAlias(auth, registry, "crow5", "backup");
  assert.equal(auth.crow5.key, "sk-backup-0002");
  assert.equal(registry.relays.crow5.activeKey, "backup");
  assert.equal(keyOf(auth, "crow5", "main"), null);
  assert.equal(keyOf(auth, "crow5", "previous"), null);
  assert.equal(keyOf(auth, "crow5", DEFAULT_ALIAS), "sk-main-0001");
  assert.deepEqual(keyAliasesOf(auth, "crow5").map((e) => e.alias), ["default", "backup"]);

  activateAlias(auth, registry, "crow5", DEFAULT_ALIAS);
  assert.equal(auth.crow5.key, "sk-main-0001");
  assert.equal(keyOf(auth, "crow5", "backup"), "sk-backup-0002");
  assert.equal(registry.relays.crow5.activeKey, "default");
});

step("keyStatus 打码且标出活动别名", () => {
  const auth = {
    crow5: { type: "api_key", key: "sk-1234567890abcdef" },
    "crow5@backup": { type: "api_key", key: "sk-abcdefghijklmnop" },
  };
  const status = keyStatus(auth, "crow5", "backup");
  assert.equal(status.length, 2);
  assert.ok(status.every((s) => !s.masked.includes("1234567890")));
  assert.equal(status.find((s) => s.alias === "backup").active, true);
});

step("删除保护：活动别名不能删", () => {
  const auth = {
    crow5: { type: "api_key", key: "sk-a" },
    "crow5@backup": { type: "api_key", key: "sk-b" },
  };
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", keyAliases: ["default", "backup"], activeKey: "backup" };
  assert.throws(() => removeKeyAlias(auth, registry, "crow5", "backup"), /活动 Key/);
});

step("删除不存在的别名会报错；删除普通别名会同步注册表", () => {
  const auth = {
    crow5: { type: "api_key", key: "sk-a" },
    "crow5@extra": { type: "api_key", key: "sk-b" },
  };
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", keyAliases: ["default", "extra"], activeKey: "default" };
  assert.throws(() => removeKeyAlias(auth, registry, "crow5", "missing"), /没有名为/);
  removeKeyAlias(auth, registry, "crow5", "extra");
  assert.equal(auth["crow5@extra"], undefined);
  assert.deepEqual(registry.relays.crow5.keyAliases, ["default"]);
});

step("syncRelayAliases 在活动别名消失时回退", () => {
  const registry = emptyRegistry();
  registry.relays.crow5 = { id: "crow5", keyAliases: ["default", "gone"], activeKey: "gone" };
  syncRelayAliases(registry, "crow5", { crow5: { key: "sk-a" } });
  assert.deepEqual(registry.relays.crow5.keyAliases, ["default"]);
  assert.equal(registry.relays.crow5.activeKey, "default");
});

console.error("\nkeyring-test: 全部通过");
