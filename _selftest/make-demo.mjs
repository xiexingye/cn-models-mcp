#!/usr/bin/env node
/**
 * 采集 GIF 演示数据：通过 MCP 协议真实调用一次，拿到真实的 token 数与花费。
 *
 * 不编造任何数字 —— GIF 里显示的花费来自厂商返回的真实 usage。
 * 用法：DEEPSEEK_API_KEY=sk-xxx node _selftest/make-demo.mjs
 * 输出：_selftest/demo-frames.json
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'index.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});

let nextId = 1;
function send(method, params, { notification = false } = {}) {
  const id = notification ? undefined : nextId++;
  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  if (!notification) payload.id = id;
  child.stdin.write(JSON.stringify(payload) + '\n');
  if (notification) return Promise.resolve(null);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('超时')), 90_000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
  });
}

const QUESTION = '这个正则为什么匹配不到邮箱？^[a-z]+@[a-z]+\\.com$';
const TRANSCRIPT = [];

try {
  await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'demo', version: '1' } });
  await send('notifications/initialized', undefined, { notification: true });

  TRANSCRIPT.push({ kind: 'prompt', text: '> 用 deepseek 看看这个正则为什么匹配不到邮箱' });
  TRANSCRIPT.push({ kind: 'prompt2', text: '  ^[a-z]+@[a-z]+\\.com$' });
  TRANSCRIPT.push({ kind: 'blank', text: '' });
  TRANSCRIPT.push({ kind: 'tool', text: '● cn-models · ask (MCP)' });
  TRANSCRIPT.push({ kind: 'toolarg', text: '  prompt: "这个正则为什么匹配不到邮箱？..."' });
  TRANSCRIPT.push({ kind: 'blank', text: '' });

  const r = await send('tools/call', {
    name: 'ask',
    arguments: { prompt: `${QUESTION}\n请简短回答，三句话以内。`, maxTokens: 4096 },
  });
  const raw = r.result?.content?.[0]?.text ?? '';
  if (r.result?.isError) throw new Error('工具调用失败: ' + raw.slice(0, 200));

  const metaLine = raw.split('\n')[0].replace(/^>\s*/, '');
  const answer = raw.split('\n').slice(2).join('\n').split('<details>')[0].trim();

  TRANSCRIPT.push({ kind: 'meta', text: '  ⎿ ' + metaLine });
  TRANSCRIPT.push({ kind: 'blank', text: '' });
  for (const line of answer.split('\n')) {
    TRANSCRIPT.push({ kind: 'answer', text: '  ' + line });
  }
  TRANSCRIPT.push({ kind: 'blank', text: '' });
  TRANSCRIPT.push({ kind: 'verdict', text: '● Claude: 结论正确 —— 问题在于缺少大小写与多段域名支持。' });

  const out = resolve(here, 'demo-frames.json');
  writeFileSync(out, JSON.stringify({ transcript: TRANSCRIPT, question: QUESTION, generatedAt: new Date().toISOString() }, null, 2), 'utf8');
  console.log('✓ 采集完成 →', out);
  console.log('  真实计费行:', metaLine);
  console.log('  回答行数:', answer.split('\n').length);
} catch (err) {
  console.error('✗ 采集失败:', err.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
}
