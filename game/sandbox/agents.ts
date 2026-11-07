// 沙盘里的角色 (程序这一侧): 建、收、留言, 以及替模型转发一条命令。管理操作走沙盘的 rpc (RCON / UDP), 模型的命令行拿不到这个口。
import { randomUUID } from "node:crypto";
import type { SandboxServer } from "./server.ts";

export type AgentRow = { name: string; alive: boolean; position?: { x: number; y: number }; unit?: number; deaths: number; mail: number };
export type AgentRequest = { id?: string; who: string; action: string; args?: Record<string, unknown> };
export type AgentReply = { id?: string; ok: boolean; tick?: number; result?: unknown; error?: { code: string; message: string } };

export class Agents {
  private server: SandboxServer;
  constructor(server: SandboxServer) { this.server = server; }

  async create(name: string): Promise<{ name: string; unit: number; position: { x: number; y: number } }> {
    return (await this.server.rpc("agent_create", { name })) as { name: string; unit: number; position: { x: number; y: number } };
  }

  async remove(name: string): Promise<{ removed: boolean; died: boolean }> {
    return (await this.server.rpc("agent_remove", { name })) as { removed: boolean; died: boolean };
  }

  async list(): Promise<AgentRow[]> {
    const r = (await this.server.rpc("agents", {}, { retry: true })) as { agents?: AgentRow[] };
    return Array.isArray(r.agents) ? r.agents : []; // Lua 空表回来是 {}
  }

  async tell(name: string, text: string): Promise<void> {
    await this.server.rpc("agent_tell", { name, text });
  }

  /** 替模型转发一条命令 (via: 只读动作走 UDP 更快; 游戏暂停时 UDP 不通, 退回 RCON) */
  async dispatch(req: AgentRequest, opts: { via?: "rcon" | "udp"; timeoutMs?: number } = {}): Promise<AgentReply> {
    const request = { id: req.id ?? randomUUID(), who: req.who, action: req.action, args: req.args ?? {} };
    try {
      return (await this.server.rpc("agent_dispatch", { request }, { via: opts.via, timeoutMs: opts.timeoutMs })) as AgentReply;
    } catch (e) {
      if (opts.via === "udp") return (await this.server.rpc("agent_dispatch", { request }, { timeoutMs: opts.timeoutMs })) as AgentReply;
      throw e;
    }
  }
}
