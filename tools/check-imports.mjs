// 静态核 import: 从入口文件出发, 递归看每个相对 import 的文件在不在、要的具名导出有没有 (不执行任何模块)
import fs from "node:fs";
import path from "node:path";

const entry = path.resolve(process.argv[2]);
const seen = new Set();
const problems = [];
const exportsOf = new Map();

function exportsIn(file) {
  if (exportsOf.has(file)) return exportsOf.get(file);
  const names = new Set();
  exportsOf.set(file, names);
  let src;
  try { src = fs.readFileSync(file, "utf8"); } catch { return names; }
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s+["']([^"']+)["'])?/gm)) {
    for (const part of m[1].split(",")) { const p = part.trim(); if (!p) continue; const as = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p); if (as) names.add(as[2] ?? as[1]); }
  }
  for (const m of src.matchAll(/^export\s+\*\s+from\s+["']([^"']+)["']/gm)) {
    const target = resolveFrom(file, m[1]);
    if (target) for (const n of exportsIn(target)) names.add(n);
  }
  if (/^export\s+default\b/m.test(src)) names.add("default");
  return names;
}

function resolveFrom(file, spec) {
  if (!spec.startsWith(".")) return null;
  const p = path.resolve(path.dirname(file), spec);
  for (const cand of [p, `${p}.ts`, `${p}.mjs`, `${p}.js`, path.join(p, "index.ts")]) if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  return p;
}

function walk(file, from) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!fs.existsSync(file)) { problems.push(`缺文件 ${path.relative(process.cwd(), file)} (被 ${path.relative(process.cwd(), from)} import)`); return; }
  const src = fs.readFileSync(file, "utf8");
  const re = /^(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)?\s*(?:,\s*\{([^}]*)\})?\s*from\s+["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    const spec = m[4];
    if (!spec.startsWith(".")) continue;
    const target = resolveFrom(file, spec);
    walk(target, file);
    if (!fs.existsSync(target)) continue;
    const wanted = `${m[2] ?? ""},${m[3] ?? ""}`.split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim());
    const have = exportsIn(target);
    for (const w of wanted) if (!have.has(w)) problems.push(`${path.relative(process.cwd(), file)}: 从 ${spec} 要 ${w}, 没有`);
  }
  // 动态 import("./x.ts") 也看文件在不在
  for (const m of src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) { const t = resolveFrom(file, m[1]); if (!fs.existsSync(t)) problems.push(`缺文件 ${path.relative(process.cwd(), t)} (被 ${path.relative(process.cwd(), file)} 动态 import)`); }
}

walk(entry, entry);
console.log(`走过 ${seen.size} 个文件, 问题 ${problems.length} 个`);
for (const p of [...new Set(problems)]) console.log("- " + p);
