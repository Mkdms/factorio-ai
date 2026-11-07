#!/usr/bin/env node
// 角色目录里 ./fh 的入口: 参数可以走文件 (--argv-file, PowerShell 版包装 fh.ps1 用; commands/argv-file.ts), 然后原样交给派对的命令行 (commands/cli/cli.js)。
// 环境变量由角色目录的包装脚本给 (FH_SOCKET 管道、FH_REF_DIR 手册目录、FH_DEADLINE_FILE); 角色名和 --timeout 90000 --journal 也是包装脚本追加的。
import { fileURLToPath } from "node:url";
import { argvFromFile } from "./argv-file.ts";

const cli = fileURLToPath(new URL("./cli/cli.js", import.meta.url));
process.argv = [process.argv[0], cli, ...argvFromFile(process.argv.slice(2))];
await import("./cli/cli.js");
