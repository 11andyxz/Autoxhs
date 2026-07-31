#!/usr/bin/env node
/**
 * 副屏专用反向代理 —— 给 cloudflared 隧道用。
 *
 * 为什么不直接 `cloudflared tunnel --url http://localhost:3100`:
 * 那样会把**整个** Autoxhs 开到公网,包括 /employee ——那个页面按设计是无鉴权的,
 * 里面存着雇员的 PII 和证件扫描件。本地 APP_PASSWORD 也没生效(副屏页无鉴权直接 200)。
 * 隧道地址是随机域名不等于安全:它会进 Cloudflare 的日志、会被贴进聊天记录、
 * 会留在手机浏览器历史里。
 *
 * 所以这里只放行「手机看答案」真正需要的那几条路径,其余一律 404 ——
 * 就算隧道地址泄漏,能拿到的也只有一个还需要配对码的副屏页面。
 *
 * 用法:
 *   node tools/live-tunnel/proxy.mjs                 # 听 3111,转发到 3100
 *   PORT=3111 TARGET=http://localhost:3100 node ...
 * 然后:
 *   cloudflared tunnel --url http://localhost:3111
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const PORT = Number(process.env.PORT || 3111);
const TARGET = new URL(process.env.TARGET || 'http://localhost:3100');

/**
 * 白名单。前缀匹配,fail-closed。
 *
 * 刻意**不**放行 /api/ai-interview/live/info —— 那个接口会返回配对码本身,
 * 等于把门和钥匙放在一起。配对码只从 Mac 上取。
 */
const ALLOW = [
  '/ai-interview/view',              // 副屏页面
  '/api/ai-interview/live/stream',   // SSE:字幕与答案
  '/api/ai-interview/live/command',  // 手机 → 桌面端(截图 / 发送)
  '/_next/',                         // 页面的 JS/CSS(静态资源,不含数据)
  '/favicon.ico',
];

const allowed = (path) => ALLOW.some((p) => path === p || path.startsWith(p));

/**
 * 把请求行里的路径变成「可以拿去查白名单」的形式,拿不准就返回 null(fail-closed)。
 *
 * 为什么必须有这一步:白名单查的是原始路径,而转发时用的是 `req.url` 原样,
 * 上游 Next 会自己解析 `..`。于是
 *     GET /ai-interview/view/../../api/ai-interview/live/info
 * 前缀匹配到 `/ai-interview/view` 通过白名单,最后打到 `/live/info` ——
 * 而那个接口返回的正是**配对码本身**,是这份白名单唯一刻意排除的东西。
 * 这条隧道是公网可达的,所以这不是理论问题。
 *
 * 规则:
 *  - 编码过的点和斜杠(%2e / %2f / %5c)一律拒,不做「解一次再看」的猜测;
 *  - 解码后出现 `..`、反斜杠、NUL 一律拒;
 *  - 规范化后必须仍然命中白名单,并且**用规范化后的路径转发**。
 */
export function safePath(rawUrl) {
  const raw = String(rawUrl ?? '/');
  const [rawPath, ...rest] = raw.split('?');
  const query = rest.length ? `?${rest.join('?')}` : '';

  if (/%2e|%2f|%5c|%00/i.test(rawPath)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;                       // 非法百分号编码
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.split('/').includes('..')) return null;
  if (!decoded.startsWith('/')) return null;

  // 折叠掉 `.` 和多余的斜杠。到这里已经没有 `..` 了,所以不可能越过根。
  const normalized = decoded
    .split('/')
    .filter((seg, i) => seg !== '.' && (seg !== '' || i === 0))
    .join('/') || '/';
  const path = normalized === '' ? '/' : normalized;

  if (!allowed(path)) return null;

  // 白名单用**解码后**的路径判断(否则 %2e%2e 能绕过去),但转发必须用**重新编码**
  // 的路径:`http.request({path})` 对含空格或非 ASCII 的 path 会同步抛
  // ERR_UNESCAPED_CHARACTERS,而那是在请求监听器里 —— 没人接,**整个代理进程退出**。
  //
  // 也就是说 `GET /_next/%20` 这样一个请求就能让公网上的任何人打掉这条隧道,
  // 而这条隧道恰恰是公开可达、且这个文件自己的注释说「会被扫」的那一个。
  const forwardPath = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return { path, forward: `${forwardPath}${query}` };
}

export const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    // 请求处理里的同步异常绝不能带走进程:这是公网可达的唯一一环,一个畸形请求
    // 就把手机上的副屏打成 502(实际发生过一次,见 safePath 里的注释)。
    console.log(`[live-tunnel] request error: ${e?.message || e}`);
    try {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    } catch { /* 连接已经没了 */ }
  }
});

// 最后一道:任何漏网的同步异常也只记录,不退出。守着一个已经在服务的隧道,
// 比「干净地崩掉」有价值得多。
process.on('uncaughtException', (e) => {
  console.log(`[live-tunnel] uncaught: ${e?.message || e}`);
});

function handle(req, res) {
  const safe = safePath(req.url);
  const path = (req.url || '/').split('?')[0];

  if (!safe) {
    // 打出来,方便发现「谁在扫这个地址」。
    console.log(`[live-tunnel] 404 ${req.method} ${path}`);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const upstream = http.request(
    {
      hostname: TARGET.hostname,
      port: TARGET.port || 80,
      // 规范化后的路径,不是 req.url 原样 —— 否则白名单查的和上游看到的
      // 是两个不同的东西。
      path: safe.forward,
      method: req.method,
      headers: { ...req.headers, host: `${TARGET.hostname}:${TARGET.port}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      // pipe 而不是攒完再发:SSE 是长连接,缓冲会让手机上的字全卡在最后一起出现。
      up.pipe(res);
    },
  );

  // 手机断了(切后台、锁屏、换网络)就把上游也拆掉。SSE 是长连接,而
  // server.timeout=0 意味着没有任何东西会替我们收尾:每一次断开都留下一个
  // 挂着的上游请求,Next 那边的 subscribeLive 也就永远不会退订。
  const teardown = () => { upstream.destroy(); };
  res.on('close', teardown);
  req.on('aborted', teardown);

  upstream.on('error', (e) => {
    console.log(`[live-tunnel] upstream error ${path}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Upstream unavailable — 本机 web/ 那边 npm run dev 在跑吗?');
  });

  req.pipe(upstream);
}

// SSE 的连接会一直挂着,别让 Node 的默认超时把它掐断。
server.timeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

// 被 import 进测试时不要自己起服务。
//
// 必须用 pathToFileURL(resolve(argv[1])):`argv[1]` 通常是**相对路径**
// (`node tools/live-tunnel/proxy.mjs`),手工拼 `file://` + 相对路径得到的是
// `file://tools/...`,永远不等于 `import.meta.url` 的 `file:///Users/...`。
// 上一版就是这么写的,结果**代理从来不监听** —— cloudflared 打不到源站,
// 手机上是 502,而本机什么错都不报。
const isMain = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) server.listen(PORT, '127.0.0.1', () => {
  console.log(`[live-tunnel] 127.0.0.1:${PORT} → ${TARGET.origin}`);
  console.log(`[live-tunnel] 只放行: ${ALLOW.join('  ')}`);
  console.log('[live-tunnel] 下一步: cloudflared tunnel --url http://localhost:' + PORT);
});
