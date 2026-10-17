// 模型关键词匹配：命令行和 pi 扩展共用同一套打分思路
// （扩展是单文件、可被用户单独拷走，所以那边保留了一份等价实现，改这里记得同步）。

export function scoreModel(model, query) {
  const id = String(model.model ?? model.id ?? "").toLowerCase();
  const provider = String(model.provider ?? "").toLowerCase();
  const full = `${provider}/${id}`;
  const name = String(model.name ?? "").toLowerCase();
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 0;
  if (id === q || full === q) return 1000;
  if (id.endsWith(q)) return 800;
  if (id.includes(q)) return 600 - id.indexOf(q);
  if (full.includes(q)) return 500 - full.indexOf(q);
  if (name.includes(q)) return 400 - name.indexOf(q);
  const hay = `${full} ${name}`;
  const tokens = q.split(/[\s/_:-]+/).filter(Boolean);
  if (!tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits += 1;
  return hits === tokens.length ? 200 + hits * 10 : 0;
}

/** 从小到大排序（分数高的在前），只返回命中的。 */
export function searchModels(entries, query) {
  return entries
    .map((entry) => ({ entry, s: scoreModel(entry, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.entry);
}
