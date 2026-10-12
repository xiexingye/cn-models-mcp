#!/usr/bin/env node
/**
 * Zero-dependency setup doctor. Run: node src/doctor.mjs
 *
 * Reads the same registry the server uses, so it can never drift from runtime
 * behaviour. Does no network calls: a wrong key still shows as "已配置".
 */

import { PROVIDERS, MODELS, getProvider, estimateCostCny, REFERENCE } from './model-registry.mjs';
import { loadEnv, maskKey } from './config.mjs';

const env = loadEnv();

const OK = '✅';
const NO = '⬜';
const WARN = '⚠️ ';

console.log('');
console.log('  cn-models-mcp · 配置体检');
console.log('  ─────────────────────────────────────────────');
console.log(`  Node ${process.version}${Number(process.versions.node.split('.')[0]) >= 24 ? '' : '   ' + WARN + '需要 Node >= 24（MCP SDK v2 要求 >= 20，本项目的 --experimental-transform-types 启动方式要求 >= 24）'}`);
console.log('');

let configured = 0;
for (const [name, provider] of Object.entries(PROVIDERS)) {
  const value = env[provider.envKey];
  const models = MODELS.filter((m) => m.provider === name);
  if (value) {
    configured += 1;
    console.log(`  ${OK} ${provider.label.padEnd(16)} ${provider.envKey} = ${maskKey(value)}`);
  } else {
    console.log(`  ${NO} ${provider.label.padEnd(16)} ${provider.envKey} 未配置`);
    console.log(`     ${' '.repeat(14)}申请：${provider.keysUrl}`);
  }
  console.log(`     ${' '.repeat(14)}模型：${models.map((m) => m.id).join('、') || '（注册表里暂无）'}`);
}

console.log('');
console.log('  ─────────────────────────────────────────────');
console.log(`  已配置厂商：${configured}/${Object.keys(PROVIDERS).length}`);
console.log('');

if (configured === 0) {
  console.log('  下一步：任选一家申请密钥（支付宝可充值，无需海外卡/VPN），然后二选一');
  console.log('');
  console.log('    方式 A（推荐，不动系统环境变量）：');
  console.log('      新建文件  ~/.cn-models-mcp.json');
  console.log('      内容      { "DEEPSEEK_API_KEY": "sk-..." }');
  console.log('');
  console.log('    方式 B：在 MCP 客户端配置的 env 段里填（见 README 的配置示例）');
  console.log('');
} else {
  const sample = { inputTokens: 1_000_000, outputTokens: 200_000 };
  console.log('  参考成本（100 万输入 + 20 万输出 token 的一次批处理）：');
  for (const m of MODELS) {
    if (!env[getProvider(m.provider).envKey]) continue;
    const cost = estimateCostCny(m.id, sample);
    console.log(`    ${m.id.padEnd(20)} 约 ¥${cost.cny.toFixed(2)}`);
  }
  const ref = estimateCostCny('deepseek-v4-pro', sample);
  const refOpus = (sample.inputTokens * REFERENCE.price.in + sample.outputTokens * REFERENCE.price.out) / 1e6;
  if (ref && refOpus) {
    console.log(`    ${'（对照）'.padEnd(14)} ${REFERENCE.label} 同样工作量约 ¥${refOpus.toFixed(2)}`);
  }
  console.log('');
  console.log('  下一步：直接把本 server 配进 Claude Code / Cursor / Cline（见 README），');
  console.log('          然后在对话里说「用 deepseek 给我第二个意见」试试。');
  console.log('');
}
