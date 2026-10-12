#!/usr/bin/env node
/**
 * HTTP (Streamable HTTP) 传输测试。
 *
 * 用法：node _selftest/http-test.mjs   （会自行在 3921 端口起一个 server 子进程）
 *
 * 注意：客户端必须同时接受 application/json 与 text/event-stream，否则按规范会被
 * 拒为 406 —— 这是 Streamable HTTP 的要求，不是本项目的限制。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'index.mjs');
const PORT = 3921;
const URL_ = `http://127.0.0.1:${PORT}/mcp`;
const ACCEPT = 'application/json, text/event-stream';

const child = spawn(process.execPath, [serverPath, '--http', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
const stderrLines = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderrLines.push(c.trim()));

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

/** 从 SSE 或纯 JSON 响应体里取出第一个 JSON-RPC 消息 */
function parseBody(text) {
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

async function waitForListen(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stderrLines.join(' ').includes('监听')) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

try {
  check('HTTP 服务启动并打印监听地址', await waitForListen(), stderrLines.find((l) => l.includes('监听')) ?? stderrLines.join(' '));

  const initRes = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } },
    }),
  });
  check('initialize 返回 200', initRes.status === 200, `status=${initRes.status}`);
  check('响应为 text/event-stream', (initRes.headers.get('content-type') ?? '').includes('text/event-stream'), initRes.headers.get('content-type'));

  const init = parseBody(await initRes.text());
  check('HTTP 侧 serverInfo 正确', init.result?.serverInfo?.name === 'cn-models-mcp', `serverInfo=${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  check('协议版本协商', Boolean(init.result?.protocolVersion), init.result?.protocolVersion);

  const listRes = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const list = parseBody(await listRes.text());
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check('tools/list 经 HTTP 返回 4 个工具', names.length === 4, names.join(', '));

  // 规范要求：只接受 application/json 的客户端应被拒绝
  const badRes = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  });
  const badBody = await badRes.text();
  check('缺少 text/event-stream 时返回 406 并说明原因', badRes.status === 406 && badBody.includes('text/event-stream'), `status=${badRes.status}`);

  // 带密钥时顺便验证 HTTP 上跑真实工具调用
  if (process.env.DEEPSEEK_API_KEY || process.env.ZHIPU_API_KEY) {
    const callRes = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_setup', arguments: {} } }),
    });
    const call = parseBody(await callRes.text());
    const txt = call.result?.content?.[0]?.text ?? '';
    check('HTTP 上执行 tools/call 成功', !call.result?.isError && txt.includes('配置体检'), txt.split('\n')[0]);
  } else {
    console.log('  · 未提供厂商密钥，跳过 HTTP 工具调用实测');
  }
} catch (err) {
  check('HTTP 测试执行', false, err.message);
} finally {
  child.kill();
  const passed = results.filter(Boolean).length;
  console.log(`\n结果：${passed}/${results.length} 项通过`);
  process.exit(passed === results.length ? 0 : 1);
}
