// 角色目录里的 PowerShell 包装脚本 (库): 有的模型在 Windows 上用 PowerShell 跑命令, `./fh` 会落到同名 fh.ps1 (pwsh 7 和 5.1 都核过)。
// 参数在 PowerShell 里是完整的; 经 cmd / sh 转手会把带引号的 JSON 拆坏 (2026-11-04 实测), 所以:
//   argvFilePs1: 把 $args 写成 JSON 数组文件, 只把文件路径交给 node (脚本侧 commands/argv-file.ts 读回)。
// 单引号里的值用 PowerShell 的规则转义 (' → '')。

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 通用包装: node <script> --argv-file <文件> <固定参数…>; env 里的变量先 $env: 设好 */
export function argvFilePs1(nodeBin: string, envFile: string, script: string, fixedArgs: string[], env: Record<string, string> = {}): string {
  const sets = Object.entries(env).map(([k, v]) => `$env:${k} = ${q(v)}`);
  const fixed = fixedArgs.map(q).join(" ");
  return [
    "# 由 core/run/ps1-wrap.ts 生成: 参数原样写成文件交给 node (PowerShell 5.1 / cmd 会把 JSON 参数拆坏)",
    "$ErrorActionPreference = 'Stop'",
    "$f = Join-Path $PSScriptRoot ('.argv-' + [guid]::NewGuid().ToString('N') + '.json')",
    "[IO.File]::WriteAllText($f, (ConvertTo-Json -Compress -InputObject @($args)), (New-Object Text.UTF8Encoding $false))",
    ...sets,
    `& ${q(nodeBin)} ${q(`--env-file-if-exists=${envFile}`)} ${q(script)} --argv-file $f${fixed ? " " + fixed : ""}`,
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}
