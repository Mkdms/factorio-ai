// Windows 系统代理 (库): 控制接口要读各家额度 (HTTPS), 本机直连会被地区拦截 (403)。命令行里通常设了 HTTPS_PROXY, 但双击界面程序时
// 界面起的控制接口只继承 Explorer 的环境, 没有这两个变量。
// 没设代理变量时读 Windows 的系统代理 (设置 → 网络 → 代理, 即 HKCU\...\Internet Settings 的 ProxyEnable / ProxyServer; 代理软件开"系统代理"就是改这里)。
import { execFileSync } from "node:child_process";

/** ProxyServer 的值 → 代理地址: "127.0.0.1:10809" 原样; "http=h:p;https=h:p;socks=h:p" 先取 https 再取 http (socks 不用); 没写协议的补 http:// */
export function parseProxyServer(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let hostPort = s;
  if (s.includes("=")) {
    const parts = Object.fromEntries(s.split(";").map((p) => p.split("=").map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[1]));
    hostPort = parts.https ?? parts.http ?? "";
    if (!hostPort) return null;
  }
  return /^[a-z]+:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`;
}

/** reg query 的输出 → 系统代理地址; 没开 (ProxyEnable 0) 或没写地址返回 null */
export function parseRegQuery(out: string): string | null {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out);
  if (!enabled || parseInt(enabled[1], 16) === 0 || !server) return null;
  return parseProxyServer(server[1]);
}

/** 读 Windows 系统代理; 不是 Windows、读不到、没开都返回 null */
export function systemProxy(run: (file: string, args: string[]) => string = (f, a) => execFileSync(f, a, { encoding: "utf8", windowsHide: true, timeout: 5_000 })): string | null {
  if (process.platform !== "win32") return null;
  try { return parseRegQuery(run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"])); } catch { return null; }
}

/** 没设 HTTPS_PROXY / HTTP_PROXY 时, 把系统代理填进去 (只改这个进程的环境; 本机地址不走代理); 返回用上的代理, 没用返回 null */
export function useSystemProxy(env: NodeJS.ProcessEnv = process.env, read: () => string | null = () => systemProxy()): string | null {
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) return null;
  const p = read();
  if (!p) return null;
  env.HTTPS_PROXY = p;
  env.HTTP_PROXY = p;
  env.NO_PROXY ??= "127.0.0.1,localhost";
  return p;
}
