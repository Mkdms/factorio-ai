// 不开游戏的单元测试: 蓝图编解码、RCON 拆包 / 按 id 认领 / 认证 / 超时 / 存活检测、回复解析。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import zlib from "node:zlib";
import { encodeBlueprint, decodeBlueprint, decodeGameString, mapVersion } from "../game/blueprint.ts";
import { RconClient, encodePacket, decodePackets } from "../game/sandbox/rcon.ts";
import { parseReply, SandboxError, longBracket } from "../game/sandbox/server.ts";

test("蓝图编解码来回一致, 版本号按 16 位一段编码", () => {
  const bp = { blueprint: { item: "blueprint", entities: [{ entity_number: 1, name: "inserter", position: { x: 0.5, y: 0.5 } }] } };
  const s = encodeBlueprint(bp);
  assert.equal(s[0], "0");
  assert.deepEqual(decodeBlueprint(s), bp);
  assert.equal(mapVersion("2.1.24"), 2 * 2 ** 48 + 1 * 2 ** 32 + 24 * 2 ** 16);
});

test("游戏 encode_string 的结果能解回 (zlib 和裸 deflate 都认)", () => {
  assert.equal(decodeGameString(zlib.deflateSync("你好").toString("base64")), "你好");
  assert.equal(decodeGameString(zlib.deflateRawSync("abc").toString("base64")), "abc");
});

test("回复解析: j: / z: 正常, 其他一律当没读到; 长括号避开内容", () => {
  assert.deepEqual(parseReply('j:{"ok":true,"data":1,"tick":5}'), { ok: true, data: 1, tick: 5 });
  const z = "z:" + zlib.deflateSync('{"ok":true,"data":[],"tick":1}').toString("base64");
  assert.equal(parseReply(z).ok, true);
  assert.throws(() => parseReply(""), SandboxError);
  assert.throws(() => parseReply("Cannot execute command"), SandboxError);
  assert.deepEqual(longBracket("abc"), ["[[", "]]"]);
  assert.deepEqual(longBracket("a]]b"), ["[=[", "]=]"]);
});

test("RCON 包: 半截包留到下次, 多个包一次切开", () => {
  const a = encodePacket(7, 2, "hello"), b = encodePacket(8, 0, "");
  const all = Buffer.concat([a, b]);
  const r1 = decodePackets(all.subarray(0, a.length + 3));
  assert.deepEqual(r1.packets, [{ id: 7, type: 2, body: "hello" }]);
  assert.equal(r1.rest.length, 3);
  const r2 = decodePackets(Buffer.concat([r1.rest, all.subarray(a.length + 3)]));
  assert.deepEqual(r2.packets, [{ id: 8, type: 0, body: "" }]);
});

/** 假的 RCON 服务器, 照 2.1.24 实测的行为: 每条命令回一个包 (大回复也不拆); "late:..." 晚 100 毫秒才回; "sleep" 之后这条连接不再回复 */
function fakeServer(password: string, port = 0): Promise<{ port: number; server: net.Server; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    let buf = Buffer.alloc(0);
    let stalled = false;
    sock.on("error", () => undefined);
    sock.on("data", (d) => {
      if (stalled) return;
      buf = Buffer.concat([buf, d]);
      const { packets, rest } = decodePackets(buf);
      buf = rest;
      for (const p of packets) {
        if (p.type === 3) {
          sock.write(encodePacket(0, 0, ""));
          sock.write(encodePacket(p.body === password ? p.id : -1, 2, ""));
        } else if (p.body === "sleep") {
          stalled = true;
          return;
        } else if (p.body.startsWith("late:")) {
          setTimeout(() => sock.writable && sock.write(encodePacket(p.id, 0, p.body)), 100);
        } else {
          sock.write(encodePacket(p.id, 0, p.body));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, server, sockets })));
}

test("RCON: 回复按 id 认领, 晚到的回复不会张冠李戴; 大回复一个包", async () => {
  const { port, server } = await fakeServer("pw");
  const c = new RconClient({ port, password: "pw" });
  await c.connect();
  const [a, b, big] = await Promise.all([c.exec("late:first"), c.exec("second"), c.exec("x".repeat(100_000))]);
  assert.equal(a, "late:first");
  assert.equal(b, "second");
  assert.equal(big.length, 100_000);
  c.close();
  server.close();
});

test("RCON: 密码错立刻报错不重试", async () => {
  const { port, server } = await fakeServer("pw");
  const c = new RconClient({ port, password: "wrong", connectDeadlineMs: 5000 });
  await assert.rejects(c.connect(), /密码错误/);
  server.close();
});

test("RCON: 服务器晚起来也能连上 (启动中重试)", async () => {
  const probe = net.createServer();
  const port: number = await new Promise((r) => probe.listen(0, "127.0.0.1", () => r((probe.address() as net.AddressInfo).port)));
  await new Promise((r) => probe.close(r));
  const c = new RconClient({ port, password: "pw", connectDeadlineMs: 10_000 });
  const p = c.connect();
  await new Promise((r) => setTimeout(r, 700));
  const { server } = await fakeServer("pw", port);
  await p;
  assert.equal(await c.exec("okok"), "okok");
  c.close();
  server.close();
});

test("RCON: 超时报错并断开, 只读命令重连后重试成功", async () => {
  const { port, server } = await fakeServer("pw");
  const c = new RconClient({ port, password: "pw", timeoutMs: 300 });
  await c.connect();
  await assert.rejects(c.exec("sleep"), /超时/);
  assert.equal(await c.exec("after", { retry: true }), "after");
  c.close();
  server.close();
});

test("RCON 存活检测: 服务器没了发 dead 事件", async () => {
  const { port, server, sockets } = await fakeServer("pw");
  const c = new RconClient({ port, password: "pw", timeoutMs: 300, connectDeadlineMs: 200 });
  await c.connect();
  const dead = new Promise((r) => c.once("dead", r));
  c.heartbeat(100, "123");
  server.close();
  for (const s of sockets) s.destroy();
  await dead;
  assert.equal(c.alive, false);
  c.close();
});
