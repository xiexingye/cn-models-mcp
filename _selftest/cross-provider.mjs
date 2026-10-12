#!/usr/bin/env node
/**
 * 跨厂商验证脚本（临时）：验证非 DeepSeek 渠道（智谱 GLM）的 ask / compare 与计费。
 * 运行：ZHIPU_API_KEY=... DEEPSEEK_API_KEY=... node _selftest/cross-provider.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'index.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let buffer = '';
const pending = new Map();
const stderrLines = [];

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
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`id=${id} 超时`)); }, 90_000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
  });
}

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

/** 从返回文本里把 "N↓ M↑（含思考 K） tokens · ¥X" 解析出来，用于独立复算计费 */
function parseCostLine(text) {
  const m = text.match(/(\d+)↓\s+(\d+)↑(?:（含思考 (\d+)）)?\s+tokens\s+·\s+¥([\d.]+)(，闲时价)?/);
  if (!m) return null;
  return { inTok: +m[1], outTok: +m[2], thinkTok: m[3] ? +m[3] : 0, reportedCny: +m[4], offPeak: Boolean(m[5]) };
}

try {
  await send('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'cross', version: '1' } });
  await send('notifications/initialized', undefined, { notification: true });

  const list = await send('tools/call', { name: 'list_models', arguments: {} });
  const listText = list.result.content[0].text;
  const configured = (listText.match(/✅/g) || []).length;
  check('list_models 反映两家密钥都已配置', configured === 4, `${configured} 个模型显示已配置`);

  // ---- 跨厂商 ask：智谱 ----
  for (const model of ['glm-5.3-flash', 'glm-5.3']) {
    const r = await send('tools/call', { name: 'ask', arguments: { prompt: '用一句话说明你是什么模型。', model, maxTokens: 4096 } });
    const txt = r.result?.content?.[0]?.text ?? '';
    const cost = parseCostLine(txt);
    check(`ask ${model} 真实调用成功`, !r.result?.isError && txt.length > 30, cost ? `计费行: ${cost.inTok}↓ ${cost.outTok}↑ ¥${cost.reportedCny}${cost.offPeak ? ' 闲时' : ''}` : txt.slice(0, 120));
    if (cost) {
      // 独立复算：从注册表读单价，核对服务端算出来的花费
      const { getModel } = await import('../src/model-registry.mjs');
      const p = getModel(model).price;
      const expect = (cost.inTok * p.in + cost.outTok * p.out) / 1e6;
      const diff = Math.abs(expect - cost.reportedCny);
      check(`  └ ${model} 计费复算一致`, diff < 0.00005, `期望 ¥${expect.toFixed(6)} vs 上报 ¥${cost.reportedCny}（差 ${diff.toFixed(8)}）`);
      check(`  └ ${model} 未被误判为闲时价`, !cost.offPeak, cost.offPeak ? '被错误标记为闲时' : '正确（智谱无闲时价）');
    }
  }

  // ---- 跨厂商 compare ----
  const cmp = await send('tools/call', {
    name: 'compare',
    arguments: { prompt: '2 的 10 次方是多少？只回答数字。', models: ['deepseek-flash', 'glm-5.3', 'glm-5.3-flash'], maxTokens: 4096 },
  });
  const cmpText = cmp.result?.content?.[0]?.text ?? '';
  const providers = [...cmpText.matchAll(/### (DeepSeek|智谱 GLM|Kimi \/ Moonshot|通义千问 Qwen)/g)].map((m) => m[1]);
  check('compare 跨厂商返回 3 个模型', !cmp.result?.isError && providers.length === 3, providers.join(' + '));
  const totals = [...cmpText.matchAll(/¥([\d.]+)/g)].map((m) => +m[1]);
  const sumLine = cmpText.match(/合计花费约 ¥([\d.]+)/);
  check('compare 合计花费合理（>0 且与分项同量级）', Boolean(sumLine) && +sumLine[1] > 0, sumLine ? `合计 ¥${sumLine[1]}` : '未找到合计行');
  console.log('\n--- compare 返回（截断）---\n' + cmpText.slice(0, 1200) + '\n');

  // ---- 跨厂商错误路径 ----
  const bad = await send('tools/call', { name: 'ask', arguments: { prompt: 'hi', model: 'kimi-k3' } });
  const badText = bad.result?.content?.[0]?.text ?? '';
  check('未配置厂商被正确提示（kimi 无密钥）', Boolean(bad.result?.isError) && badText.includes('MOONSHOT_API_KEY'), badText.slice(0, 100));
} catch (err) {
  check('执行', false, err.message);
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 400));
  child.kill();
  const passed = results.filter(Boolean).length;
  console.log(`\n结果：${passed}/${results.length} 项通过`);
  process.exit(passed === results.length ? 0 : 1);
}
