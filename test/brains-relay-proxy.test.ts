// 中转站本机代理 (core/brains/relay.ts): 去掉请求顶层的 metadata, 其余原样透传 (路径、查询串、头、SSE 响应流); 上游连不上回 502; 本机地址绕过系统代理
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { bypassLocalProxy, startRelayProxy, stripMetadata } from "../core/brains/relay.ts";

test("stripMetadata: 只去顶层 metadata; 不是 JSON 对象 / 没有这个字段就字节不变", () => {
  const withMeta = Buffer.from(JSON.stringify({ model: "gpt-6.1-terra", metadata: { user_id: "u1" }, messages: [{ role: "user", content: "hi", metadata: { keep: 1 } }] }));
  const r = stripMetadata(withMeta);
  assert.equal(r.stripped, true);
  const o = JSON.parse(r.body.toString());
  assert.equal("metadata" in o, false);
  assert.deepEqual(o.messages[0].metadata, { keep: 1 }, "messages 里同名的键不动");
  assert.equal(o.model, "gpt-6.1-terra");
  for (const raw of ['{"model":"x","max_tokens":1}', "not json", "[1,2]", ""]) {
    const b = Buffer.from(raw);
    const s = stripMetadata(b);
    assert.equal(s.stripped, false, raw);
    assert.equal(s.body, b, `原样 (同一个 Buffer): ${raw}`);
  }
});

test("bypassLocalProxy: NO_PROXY 加上 127.0.0.1 / localhost, 已有的保留、不重复", () => {
  assert.deepEqual(bypassLocalProxy({}), { NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  assert.deepEqual(bypassLocalProxy({ NO_PROXY: "a.example.com, 127.0.0.1" }), { NO_PROXY: "a.example.com,127.0.0.1,localhost", no_proxy: "a.example.com,127.0.0.1,localhost" });
  assert.equal(bypassLocalProxy({ no_proxy: "x" }).NO_PROXY, "x,127.0.0.1,localhost", "只有小写的也算");
});

/** 假上游 (站): 记下收到的请求, 按路径回 SSE 两段 / JSON / 原样回显 */
function fakeUpstream() {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/base/v1/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "yes", "request-id": "r1" });
        res.write("event: message_start\ndata: {\"a\":1}\n\n");
        setTimeout(() => { res.write("event: message_stop\ndata: {}\n\n"); res.end(); }, 30);
      } else if (req.url?.startsWith("/base/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1" }] }));
      } else {
        res.writeHead(418, { "content-type": req.headers["content-type"] ?? "text/plain" });
        res.end(body);
      }
    });
  });
  return new Promise<{ port: number; seen: typeof seen; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) }));
  });
}

test("代理: POST /v1/messages 去掉 metadata、头和路径原样、SSE 流原样回来; GET 和非 JSON 原样透传; 计数", async () => {
  const up = await fakeUpstream();
  // 目标带路径前缀和末尾 /v1 (cleanUrl 已去掉 /v1, 这里再给一次末尾 / 看它能不能容忍)
  const proxy = await startRelayProxy(`http://127.0.0.1:${up.port}/base/`, { env: {} });
  try {
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(proxy.target, `http://127.0.0.1:${up.port}/base`);
    const payload = { model: "gpt-6.1-terra", max_tokens: 8, metadata: { user_id: "u1" }, stream: true, messages: [{ role: "user", content: "收到" }] };
    const r = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01", authorization: "Bearer sk-test", "anthropic-beta": "x", "accept-encoding": "gzip" },
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/event-stream");
    assert.equal(r.headers.get("x-upstream"), "yes");
    assert.equal(await r.text(), "event: message_start\ndata: {\"a\":1}\n\nevent: message_stop\ndata: {}\n\n");
    const s = up.seen[0];
    assert.equal(s.method, "POST");
    assert.equal(s.url, "/base/v1/messages?beta=true", "路径前缀 + 原路径 + 查询串");
    const sent = JSON.parse(s.body);
    assert.equal("metadata" in sent, false, "metadata 去掉了");
    assert.deepEqual({ ...payload, metadata: undefined }, { ...sent, metadata: undefined }, "其他字段原样");
    assert.equal(s.headers["x-api-key"], "sk-test");
    assert.equal(s.headers["anthropic-version"], "2023-06-01");
    assert.equal(s.headers.authorization, "Bearer sk-test");
    assert.equal(s.headers["anthropic-beta"], "x");
    assert.equal(s.headers["accept-encoding"], "gzip", "压缩协商原样, 代理不解压");
    assert.equal(s.headers.host, `127.0.0.1:${up.port}`, "host 换成站的");
    assert.equal(s.headers["content-length"], String(Buffer.byteLength(s.body)), "长度按改过的请求体重算");

    const g = await fetch(`${proxy.url}/v1/models`, { headers: { authorization: "Bearer sk-test" } });
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), { data: [{ id: "m1" }] });
    assert.equal(up.seen[1].url, "/base/v1/models");
    assert.equal(up.seen[1].body, "");

    const raw = "model=x&metadata=1";
    const p = await fetch(`${proxy.url}/other`, { method: "POST", headers: { "content-type": "text/plain" }, body: raw });
    assert.equal(p.status, 418);
    assert.equal(await p.text(), raw, "非 JSON 的请求体原样");
    assert.equal(up.seen[2].body, raw);

    const j = await fetch(`${proxy.url}/other`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"x"}' });
    assert.equal(await j.text(), '{"model":"x"}', "JSON 里没有 metadata: 字节原样");

    assert.deepEqual([proxy.requests, proxy.stripped, proxy.errors], [4, 1, 0]);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test("代理: 站连不上 → 502 + Anthropic 形状的错误体, 计一次 errors", async () => {
  const dead = await fakeUpstream();
  const port = dead.port;
  await dead.close(); // 端口刚释放, 没人听
  const logs: string[] = [];
  const proxy = await startRelayProxy(`http://127.0.0.1:${port}`, { env: {}, log: (s) => logs.push(s) });
  try {
    const r = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 502);
    const o = await r.json() as { type: string; error: { type: string; message: string } };
    assert.equal(o.type, "error");
    assert.equal(o.error.type, "api_error");
    assert.match(o.error.message, /本机代理连不上中转站/);
    assert.equal(proxy.errors, 1);
    assert.equal(logs.length, 1);
  } finally {
    await proxy.close();
  }
});

test("startRelayProxy: 不是 http(s) 地址直接报错", () => {
  assert.throws(() => startRelayProxy("ftp://x"), /http\(s\)/);
});
