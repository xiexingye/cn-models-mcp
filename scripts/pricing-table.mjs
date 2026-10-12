#!/usr/bin/env node
/**
 * Generates the pricing comparison used in README.md, straight from the registry.
 * Run: npm run pricing   (writes docs/pricing.md and prints to stdout)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODELS, REFERENCE, getProvider, estimateCostCny } from '../src/model-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const SCENARIOS = [
  { name: '轻量（问 100 个问题）', inputTokens: 300_000, outputTokens: 100_000 },
  { name: '中度（一个月的日常编码助手）', inputTokens: 5_000_000, outputTokens: 2_000_000 },
  { name: '重度（跑一整天 agent）', inputTokens: 30_000_000, outputTokens: 10_000_000 },
];

const cny = (n) => `¥${n.toFixed(n < 10 ? 2 : 1)}`;

const lines = [];
lines.push('# 成本对比（由 `npm run pricing` 自动生成，请勿手改）');
lines.push('');
lines.push('单价单位：人民币元 / 百万 token（输入 / 输出）。DeepSeek 有闲时价（闲时 = 高峰的半价）。');
lines.push('');
lines.push('| 模型 | 输入 / 输出 | ' + SCENARIOS.map((s) => s.name).join(' | ') + ' |');
lines.push('| --- | --- | ' + SCENARIOS.map(() => '---').join(' | ') + ' |');

for (const m of MODELS) {
  const label = getProvider(m.provider).label;
  // Time-of-day pricing must not make the generated numbers depend on when the
  // script happens to run: show both windows explicitly and cost the peak one.
  const price = m.price.offPeak
    ? `¥${m.price.in} / ¥${m.price.out}<br>（闲时 ¥${m.price.offPeak.in} / ¥${m.price.offPeak.out}）`
    : `¥${m.price.in} / ¥${m.price.out}`;
  const costs = SCENARIOS.map((s) => {
    const cost = estimateCostCny(m.id, { ...s, cacheRatio: 0 });
    return cost ? cny(cost.cny) : '—';
  });
  lines.push(`| \`${m.id}\`（${label}） | ${price} | ${costs.join(' | ')} |`);
}

const opusCosts = SCENARIOS.map((s) =>
  cny((s.inputTokens * REFERENCE.price.in + s.outputTokens * REFERENCE.price.out) / 1e6),
);
lines.push(`| **${REFERENCE.label}**（对照） | ¥${REFERENCE.price.in} / ¥${REFERENCE.price.out} | ${opusCosts.join(' | ')} |`);

lines.push('');
const mid = SCENARIOS[1];
const cheapest = [...MODELS]
  .map((m) => ({ id: m.id, cost: estimateCostCny(m.id, mid).cny }))
  .sort((a, b) => a.cost - b.cost)[0];
const opusMid = (mid.inputTokens * REFERENCE.price.in + mid.outputTokens * REFERENCE.price.out) / 1e6;
const ratio = opusMid / cheapest.cost;
lines.push(
  `结论：同一份中度工作量，最便宜的国内模型（\`${cheapest.id}\`，${cny(cheapest.cost)}）约为 ${REFERENCE.label}（${cny(opusMid)}）的 **1/${ratio.toFixed(1)}**。`,
);
lines.push('');
lines.push('> 换算说明：' + REFERENCE.note);
lines.push('> 价格核对日期 2026-10-12。厂商会调价 —— 发现过期数字请提 PR 改 `src/model-registry.mjs`。');

const markdown = lines.join('\n') + '\n';
mkdirSync(resolve(root, 'docs'), { recursive: true });
writeFileSync(resolve(root, 'docs/pricing.md'), markdown, 'utf8');
process.stdout.write(markdown);
