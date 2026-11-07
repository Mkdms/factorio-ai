// 给模型看的紧凑文字: 对象一行一个键, 数组里的对象写成一行; 太长就截断并提示缩小范围。
export const MAX_OUT = 8000;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${inline(x)}`).join(", ")}}`;
  return scalar(v);
}

export function compact(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}(空)`;
    return v.map((x) => `${pad}- ${inline(x)}`).join("\n");
  }
  if (v && typeof v === "object") {
    const rows = Object.entries(v as Record<string, unknown>);
    if (!rows.length) return `${pad}(空)`;
    return rows.map(([k, x]) => {
      if (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length && Object.values(x).some((y) => y && typeof y === "object")) return `${pad}${k}:\n${compact(x, indent + 1)}`;
      if (Array.isArray(x) && x.length > 3) return `${pad}${k} (${x.length}):\n${compact(x, indent + 1)}`;
      return `${pad}${k}: ${inline(x)}`;
    }).join("\n");
  }
  return pad + scalar(v);
}

export function cap(text: string, max = MAX_OUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…截断: 共 ${text.length} 字, 缩小范围 (radius / limit) 再查`;
}
