#!/usr/bin/env node
/**
 * Minimal MCP client harness for end-to-end testing.
 *
 * Why this exists: piping a request file into the server (cmd "< file > file")
 * closes stdin as soon as the last line is read, which ends the stdio connection
 * while an async tool call (one that hits a vendor API) is still in flight — the
 * response is then lost. A real MCP host keeps the connection open, so this
 * harness does the same: spawn the server, write requests, wait for each response
 * by id, then shut down.
 *
 * Usage: node _selftest/harness.mjs
 * Requires the provider keys you want to exercise in the environment.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'index.mjs');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

let buffer = '';
const pending = new Map();
const stderrLines = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('!! 非法 JSON 行:', line.slice(0, 200));
      continue;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderrLines.push(c.trim()));

let nextId = 1;
function send(method, params, { notification = false } = {}) {
  const id = notification ? undefined : nextId++;
  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  if (!notification) payload.id = id;
  child.stdin.write(JSON.stringify(payload) + '\n');
  if (notification) return Promise.resolve(null);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`请求 ${method} (id=${id}) 超时 60s`));
    }, 60_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolvePromise(msg);
    });
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  const init = await send('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'harness', version: '1.0.0' },
  });
  check('initialize 握手', init.result?.serverInfo?.name === 'cn-models-mcp', `serverInfo=${init.result?.serverInfo?.name}`);
  check('协议版本协商', Boolean(init.result?.protocolVersion), init.result?.protocolVersion);

  await send('notifications/initialized', undefined, { notification: true });

  const list = await send('tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check('tools/list 返回 4 个工具', names.length === 4, names.join(', '));

  const setup = await send('tools/call', { name: 'check_setup', arguments: {} });
  check('check_setup 正常返回', !setup.result?.isError, setup.result?.content?.[0]?.text?.split('\n')[0]);

  const ask = await send('tools/call', {
    name: 'ask',
    arguments: { prompt: '用一句话解释什么是 MCP。', maxTokens: 4096 },
  });
  const askText = ask.result?.content?.[0]?.text ?? '';
  check('ask 真实调用成功', !ask.result?.isError && askText.length > 40, askText.split('\n')[0]);
  if (!ask.result?.isError) console.log('\n--- ask 返回 ---\n' + askText + '\n');

  const empty = await send('tools/call', {
    name: 'ask',
    arguments: { prompt: '详细解释 MCP 的设计动机与应用场景，越详细越好。', maxTokens: 150 },
  });
  const emptyText = empty.result?.content?.[0]?.text ?? '';
  check('小预算空正文给出可操作提示', Boolean(empty.result?.isError) && emptyText.includes('maxTokens'), emptyText.slice(0, 120));

  const bad = await send('tools/call', { name: 'ask', arguments: { prompt: 'hi', model: '不存在的模型' } });
  check('未知模型被正确拒绝', Boolean(bad.result?.isError), bad.result?.content?.[0]?.text?.slice(0, 80));

  const cmp = await send('tools/call', {
    name: 'compare',
    arguments: { prompt: '1+1=? 只回答数字。', models: ['deepseek-flash', 'deepseek-v4-pro'], maxTokens: 4096 },
  });
  const cmpText = cmp.result?.content?.[0]?.text ?? '';
  check('compare 多模型对比成功', !cmp.result?.isError && cmpText.includes('合计花费'), cmpText.split('\n').pop());

  check('stderr 有启动日志（协议通道未被污染）', stderrLines.join(' ').includes('cn-models-mcp'));
} catch (err) {
  check('harness 执行', false, err.message);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 500));
  child.kill();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 项通过`);
  process.exit(passed === results.length ? 0 : 1);
}
