#!/usr/bin/env node
// 转接: 第二版的 src/play/know.ts (./know 关键词) 在新项目里是 commands/know.ts。
// 装模组那条路 (run.ts --kit party) 写的 ./know 指向这里 (2026-11-08 补: 没有它 ./know 一启动就找不到模块)
import { main } from "../../commands/know.ts";
import { argvFromFile } from "../../commands/argv-file.ts";

process.exitCode = await main(argvFromFile(process.argv.slice(2)));
