#!/usr/bin/env node
// 转接: 第二版的 src/play/context-hook.ts (Claude Code 钩子: 放行循环 / 管道、拦串联 sleep、读文件禁区、收件箱、快满提醒、压缩前后存笔记) 在新项目里是 core/brains/hooks/hook.ts (启动即运行, 读 process.argv)。
// 装模组那条路 (run.ts) 写进角色目录 .claude/settings.json 的钩子命令指向这里: 搬家后这个文件没了, 2026-11-08 连续班 6 个钩子每次都 "Cannot find module" (hooksSeen 为空, 组合命令被 dontAsk 拒 9 次)。
import "../../core/brains/hooks/hook.ts";
