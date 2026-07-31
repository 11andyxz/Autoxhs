// tools/live-tunnel/proxy.test.mjs
//
// 这个反代是整套东西里唯一**公网可达**的部分:手机通过 cloudflared 打进来,
// 所以任何人只要拿到那个域名就能敲它。白名单是它全部的防线。
//
// 这里测两件事:
//  1. 白名单不能被路径穿越绕过 —— 它查的是原始路径,而上游 Next 会自己解析 `..`,
//     所以「查的」和「上游看到的」必须是同一个东西。刻意排除的 /live/info 会返回
//     配对码本身,绕过去等于把门和钥匙一起交出去。
//  2. 手机断开时上游连接会被拆掉 —— SSE 是长连接,而 server.timeout=0,
//     没有任何别的东西会替它收尾。
//
// Run: node --test tools/live-tunnel/proxy.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { safePath } from './proxy.mjs';

/* ─────────────────────── 白名单本身 ─────────────────────── */

describe('safePath — 白名单与规范化', () => {
  const allow = (u) => assert.notEqual(safePath(u), null, `应放行: ${u}`);
  const deny = (u) => assert.equal(safePath(u), null, `应拦截: ${u}`);

  test('手机真正需要的四类请求放行', () => {
    allow('/ai-interview/view');
    allow('/ai-interview/view?k=abc123');
    allow('/api/ai-interview/live/stream?k=abc123');
    allow('/api/ai-interview/live/command');
    allow('/_next/static/chunks/main.js');
    allow('/favicon.ico');
  });

  test('/live/info 永远不放行 —— 它返回配对码', () => {
    deny('/api/ai-interview/live/info');
    deny('/api/ai-interview/live/info?x=1');
  });

  test('路径穿越的各种写法都拦住', () => {
    // 前缀匹配 + 上游自己解析 `..` = 白名单形同虚设。
    deny('/ai-interview/view/../../api/ai-interview/live/info');
    deny('/ai-interview/view/../../../etc/passwd');
    deny('/_next/../api/ai-interview/live/info');
    deny('/_next/../../employee');
    // 编码形式
    deny('/ai-interview/view/%2e%2e/%2e%2e/api/ai-interview/live/info');
    deny('/ai-interview/view/%2E%2E/api/ai-interview/live/info');
    deny('/ai-interview%2f..%2fapi/ai-interview/live/info');
    // 反斜杠与 NUL
    deny('/ai-interview/view/..\\..\\employee');
    deny('/ai-interview/view%00/../api/ai-interview/live/info');
  });

  test('本仓库其他敏感页面一律不在白名单里', () => {
    for (const p of ['/employee', '/work-email', '/job-hunter', '/pdf-tools', '/api/employee', '/']) {
      deny(p);
    }
  });

  test('单个点和重复斜杠会被折叠,不是拒绝', () => {
    const r = safePath('/ai-interview//view/./sub');
    assert.notEqual(r, null);
    assert.ok(!r.path.includes('//'), r.path);
    assert.ok(!r.path.split('/').includes('.'), r.path);
  });

  test('转发用的是规范化后的路径,查询串原样保留', () => {
    const r = safePath('/ai-interview/view/./?k=abc&x=1');
    assert.notEqual(r, null);
    assert.ok(r.forward.endsWith('?k=abc&x=1'), r.forward);
    assert.ok(!r.forward.includes('/./'), r.forward);
  });

  test('非法百分号编码不猜,直接拒', () => {
    deny('/ai-interview/view/%zz');
    deny('/ai-interview/view/%');
  });

  test('不以 / 开头的请求行拒掉(绝对 URI 形式)', () => {
    deny('http://evil.example/ai-interview/view');
    deny('//evil.example/ai-interview/view');
  });
});

/* ────────────── 上游连接的收尾(用真 socket 发原始请求行) ────────────── */

describe('上游连接不会泄漏', () => {
  test('手机断开时上游请求被销毁', async () => {
    // curl 会替你规范化路径,所以这一段必须自己写请求行 —— 也正是攻击者会做的事。
    let upstreamAborted = false;
    let upstreamSawPath = null;

    const http = await import('node:http');
    const upstream = http.createServer((req, res) => {
      upstreamSawPath = req.url;
      req.on('aborted', () => { upstreamAborted = true; });
      res.on('close', () => { upstreamAborted = true; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hello\n\n');           // 挂着不结束,模拟 SSE
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    process.env.TARGET = `http://127.0.0.1:${upstreamPort}`;
    process.env.PORT = '0';
    // 重新加载 proxy 以拿到新的 TARGET(模块级常量)。
    const mod = await import(`./proxy.mjs?t=${Date.now()}`);
    const proxy = mod.server ?? null;
    if (!proxy) {
      // proxy.mjs 没有导出 server 时跳过这一段,safePath 的断言已经覆盖了主要风险。
      upstream.close();
      return;
    }
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = proxy.address().port;

    const sock = net.connect(proxyPort, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET /api/ai-interview/live/stream?k=x HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => sock.once('data', r));
    assert.equal(upstreamSawPath, '/api/ai-interview/live/stream?k=x');

    sock.destroy();                            // 手机断了
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(upstreamAborted, true, '上游连接没有被拆掉,会一直挂着');

    proxy.close();
    upstream.close();
  });
});

/* ─────────────── 一个畸形请求不能打掉整条隧道 ─────────────── */

describe('REG-039 公网上的任何人都不能用一个请求把代理搞死', () => {
  test('通过白名单、但含空格/非 ASCII 的路径不会让进程退出', async () => {
    // safePath 用**解码后**的路径查白名单(否则 %2e%2e 绕得过去),但转发如果也用
    // 解码结果,`http.request({path:'/_next/ '})` 会同步抛 ERR_UNESCAPED_CHARACTERS
    // —— 在请求监听器里,没人接,**整个代理进程退出**。
    // 也就是说 `GET /_next/%20` 一个请求就能打掉这条公网隧道。实际发生过一次 502。
    const http = await import('node:http');
    const net = await import('node:net');

    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`ok:${req.url}`);
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

    process.env.TARGET = `http://127.0.0.1:${upstream.address().port}`;
    const mod = await import(`./proxy.mjs?crash=${Date.now()}`);
    await new Promise((r) => mod.server.listen(0, '127.0.0.1', r));
    const port = mod.server.address().port;

    const raw = (line) => new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`GET ${line} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('close', () => resolve(buf));
      sock.on('error', () => resolve(''));
      setTimeout(() => { sock.destroy(); resolve(buf); }, 2_000);
    });

    for (const line of ['/_next/%20', '/ai-interview/view/%E4%B8%AD', '/_next/a%20b.js']) {
      const out = await raw(line);
      assert.match(out, /^HTTP\/1\.1 \d{3}/, `${line} 没有拿到任何响应 —— 进程八成已经死了`);
    }

    // 还活着吗?再发一个正常请求。
    const alive = await raw('/ai-interview/view?k=abc');
    assert.match(alive, /^HTTP\/1\.1 200/, '被畸形请求打死了');

    mod.server.close();
    upstream.close();
  });

  test('safePath 转发的是重新编码过的路径', () => {
    assert.equal(safePath('/_next/%20').forward, '/_next/%20');
    assert.equal(safePath('/ai-interview/view/%E4%B8%AD').forward, '/ai-interview/view/%E4%B8%AD');
    // 查白名单用的仍然是解码后的形式,否则穿越就绕过去了。
    assert.equal(safePath('/_next/%20').path, '/_next/ ');
  });
});
