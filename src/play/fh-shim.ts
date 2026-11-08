#!/usr/bin/env node
// 转接: 第二版的 src/play/fh-shim.ts (角色目录里 ./fh 的入口) 在新项目里是 commands/fh.ts (启动即运行; 命令行用 commands/cli/cli.js, RCON 或管道照环境变量)。
// 装模组那条路 (run.ts --kit party) 写的 ./fh 指向这里 (2026-11-08 补: 没有它 ./fh 一启动就找不到模块)
import "../../commands/fh.ts";
