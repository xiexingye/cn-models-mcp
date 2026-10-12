#!/usr/bin/env node
/**
 * cn-models-mcp — MCP server exposing Chinese LLM providers to Claude Code,
 * Cursor, Cline and any other MCP host.
 *
 * stdout is the JSON-RPC channel: never console.log() here. Log to stderr.
 */

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { getModel, getProvider, MODELS, PROVIDERS, estimateCostCny, modelsWithKey, missingKeys } from './model-registry.mjs';
import { chat, ConfigError, ProviderError, summarize } from './client.mjs';
import { loadEnv, maskKey } from './config.mjs';

const env = loadEnv();

// Reasoning models bill thinking tokens from this same budget, so the default has
// to leave room for both thinking and the answer. 2048 was too tight in practice.
const DEFAULT_MAX_TOKENS = 4096;

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

function fail(s) {
  return { content: [{ type: 'text', text: s }], isError: true };
}

function onboarding(env) {
  const missing = missingKeys(env);
  const lines = [
    '## 还没有配置任何 API Key',
    '',
    '任选一家，支付宝充值即可，不需要海外信用卡或 VPN：',
    '',
  ];
  for (const m of missing) {
    lines.push(`- **${m.label}** — 到 ${m.keysUrl} 申请，然后配置环境变量 \`${m.envKey}\``);
  }
  lines.push(
    '',
    '配置后重试；不确定配好没有，可以调用 `check_setup` 工具做一次体检。',
    '',
    '最快的配置方式（写进 `~/.cn-models-mcp.json`）：',
    '',
    '```json',
    '{ "DEEPSEEK_API_KEY": "sk-..." }',
    '```',
  );
  return lines.join('\n');
}

function pricingTable(env) {
  const configured = new Set(modelsWithKey(env).map((m) => m.id));
  const rows = MODELS.map((m) => {
    const provider = getProvider(m.provider);
    const price = m.price.offPeak ? `¥${m.price.offPeak.in}/¥${m.price.offPeak.out}（闲时）· ¥${m.price.in}/¥${m.price.out}（高峰）` : `¥${m.price.in}/¥${m.price.out}`;
    const state = configured.has(m.id) ? '✅ 已配置' : `⬜ 需 ${provider.envKey}`;
    const tags = [m.thinking ? '思考' : null, m.vision ? '视觉' : null].filter(Boolean).join('/') || '-';
    return `| \`${m.id}\` | ${provider.label} | ${(m.contextTokens / 1000).toFixed(0)}K | ${price} | ${tags} | ${state} |`;
  });
  return [
    '| 模型 | 厂商 | 上下文 | 价格（元/百万 token，输入/输出） | 能力 | 状态 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `已配置密钥：**${configured.size}/${MODELS.length}** 个模型可用。`,
    '',
    '价格核对日期 2026-10-12，以各厂商定价页为准（`pricing.json` 与 `src/model-registry.mjs` 是唯一数据源）。',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'cn-models-mcp', version: '0.1.0' });

  server.registerTool(
    'list_models',
    {
      description:
        '列出可用的国内模型（DeepSeek / Kimi / GLM / Qwen）及其价格、上下文长度、是否已配置密钥。想省钱或不确定该用哪个模型时先调用它。',
      inputSchema: z.object({}),
    },
    async () => text(pricingTable(env)),
  );

  server.registerTool(
    'ask',
    {
      description:
        '向一个国内模型提一个问题，拿到它的回答。用途：廉价地获取第二个意见、让便宜模型先做初筛、或处理不值得消耗主模型额度的大量文本。' +
        '只传 prompt 时会自动挑选一个已配置的最便宜模型。',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('要问的问题或要处理的文本'),
        model: z
          .string()
          .optional()
          .describe('模型 id，例如 deepseek-flash、kimi-k3、glm-5.3；省略则自动选择已配置的最便宜模型'),
        system: z.string().optional().describe('可选的系统提示词，用来约束角色或输出格式'),
        maxTokens: z.number().int().min(32).max(32000).optional().describe('最大输出 token 数，默认 2048'),
        temperature: z.number().min(0).max(2).optional().describe('采样温度，默认由厂商决定'),
      }),
    },
    async ({ prompt, model, system, maxTokens, temperature }) => {
      const available = modelsWithKey(env);
      if (available.length === 0) return fail(onboarding(env));

      const modelId = model ?? cheapestOf(available).id;
      const target = getModel(modelId);
      if (!target) {
        return fail(`未知模型 \`${modelId}\`。可用模型：${MODELS.map((m) => m.id).join('、')}`);
      }
      if (!available.some((m) => m.id === modelId)) {
        const provider = getProvider(target.provider);
        return fail(
          `模型 \`${modelId}\` 所属的 **${provider.label}** 还没配置密钥。\n\n` +
            `到 ${provider.keysUrl} 申请后配置 \`${provider.envKey}\`，或改用：${available.map((m) => m.id).join('、')}`,
        );
      }

      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });

      try {
        const result = await chat({ modelId, messages, temperature, maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS, env });
        const header = `> ${summarize(result)}`;
        // Thinking traces are long and self-referential; injecting them whole would
        // pollute the host model's context. Cap them and say so.
        const reasoning = result.reasoning
          ? `\n\n<details><summary>思考过程（前 600 字，完整内容 ${result.reasoning.length} 字）</summary>\n\n` +
            `${result.reasoning.slice(0, 600)}${result.reasoning.length > 600 ? ' …' : ''}\n\n</details>`
          : '';
        return text(`${header}\n\n${result.text}${reasoning}`);
      } catch (err) {
        return fail(formatError(err, env));
      }
    },
  );

  server.registerTool(
    'compare',
    {
      description:
        '把同一个问题同时发给多个国内模型，返回并列答案，便于交叉验证或挑选更好的那个。适合：不确定答案对不对、需要多角度、或想比较质量差异。会消耗多个模型的额度。',
      inputSchema: z.object({
        prompt: z.string().min(1).describe('要对比的问题'),
        models: z
          .array(z.string())
          .min(2)
          .max(4)
          .optional()
          .describe('要对比的模型 id 列表（2-4 个）；省略则用所有已配置模型（最多 3 个）'),
        system: z.string().optional().describe('可选的系统提示词'),
        maxTokens: z.number().int().min(32).max(32000).optional().describe('每个模型的最大输出 token，默认 2048'),
      }),
    },
    async ({ prompt, models, system, maxTokens }) => {
      const available = modelsWithKey(env);
      if (available.length === 0) return fail(onboarding(env));

      const chosen = (models ?? available.slice(0, 3).map((m) => m.id)).map((id) => id);
      const unknown = chosen.filter((id) => !getModel(id));
      if (unknown.length) return fail(`未知模型：${unknown.join('、')}`);

      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });

      const settled = await Promise.allSettled(
        chosen.map((modelId) =>
          chat({ modelId, messages, maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS, env }).then((r) => ({ modelId, r })),
        ),
      );

      const blocks = [];
      let totalCny = 0;
      settled.forEach((outcome, index) => {
        const modelId = chosen[index];
        if (outcome.status === 'fulfilled') {
          const { r } = outcome.value;
          totalCny += r.costCny;
          blocks.push(`### ${r.providerLabel} · \`${r.model}\`\n\n> ${summarize(r)}\n\n${r.text}`);
        } else {
          blocks.push(`### \`${modelId}\`\n\n> ❌ ${formatError(outcome.reason, env)}`);
        }
      });

      const ok = settled.filter((s) => s.status === 'fulfilled').length;
      const footer = `\n\n---\n\n**${ok}/${chosen.length} 个模型返回成功，合计花费约 ¥${totalCny.toFixed(4)}**`;
      return text(`${blocks.join('\n\n---\n\n')}${footer}`);
    },
  );

  server.registerTool(
    'check_setup',
    {
      description:
        '体检：检查各厂商的密钥是否配置、配置在哪一层（环境变量 / ~/.cn-models-mcp.json / .env），并给出下一步。出问题时先调用它。',
      inputSchema: z.object({}),
    },
    async () => {
      const lines = ['## 配置体检', ''];
      for (const [name, provider] of Object.entries(PROVIDERS)) {
        const value = env[provider.envKey];
        const state = value ? `✅ 已配置 ${maskKey(value)}` : '⬜ 未配置';
        lines.push(`- **${provider.label}**（\`${provider.envKey}\`）：${state}`);
      }
      const source = env.__SOURCE_NOTE__ ?? null;
      if (source) lines.push('', source);
      lines.push('');
      const available = modelsWithKey(env);
      if (available.length) {
        lines.push(`可用模型 ${available.length} 个：${available.map((m) => `\`${m.id}\``).join('、')}`);
        lines.push('', '试试：`ask` 工具，只传 prompt 即可。');
      } else {
        lines.push(onboarding(env));
      }
      return text(lines.join('\n'));
    },
  );

  return server;
}

function cheapestOf(models) {
  return models.reduce((best, m) => (estimateCostCny(m.id, { inputTokens: 1000, outputTokens: 1000 }).cny < estimateCostCny(best.id, { inputTokens: 1000, outputTokens: 1000 }).cny ? m : best));
}

function formatError(err, env) {
  if (err instanceof ConfigError) {
    return (
      `**${err.provider.label} 缺少 API Key**\n\n` +
      `到 ${err.provider.keysUrl} 申请，然后配置环境变量 \`${err.provider.envKey}\`（或写进 \`~/.cn-models-mcp.json\`）。`
    );
  }
  if (err instanceof ProviderError) {
    const hint =
      err.status === 401 || err.status === 403
        ? '\n\n提示：密钥可能无效或没有权限，用 `check_setup` 确认配置来源。'
        : err.status === 429
          ? '\n\n提示：余额不足或触发限流，去厂商控制台确认余额，或换个模型重试。'
          : err.status === 402
            ? '\n\n提示：账户余额不足，去厂商控制台充值。'
            : '';
    return `**调用失败**：${err.message}${hint}`;
  }
  return `**意外错误**：${err?.message ?? String(err)}`;
}

// ---------------------------------------------------------------------------
// 启动方式：默认 stdio（Claude Code / Cursor / Cline / Windsurf / Zed / Trae…）
//          --http 走 Streamable HTTP（ChatGPT 开发者模式、云端宿主、多客户端共享）
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const httpFlag = argv.includes('--http');
const portArg = argv.indexOf('--port');
const hostArg = argv.indexOf('--host');
const httpPort = portArg !== -1 ? Number(argv[portArg + 1]) : Number(process.env.PORT ?? 3921);
const httpHost = hostArg !== -1 ? argv[hostArg + 1] : (process.env.HOST ?? '127.0.0.1');
const verbose = process.env.DEBUG_MCP_HTTP === '1';

function startupBanner(mode) {
  return `[cn-models-mcp] 传输=${mode} · 可用模型 ${modelsWithKey(env).length}/${MODELS.length} · 日志走 stderr`;
}

if (httpFlag) {
  const { createServer } = await import('node:http');

  const handle = createMcpHandler(() => buildServer());

  async function toWebRequest(req, base) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    return new Request(base + req.url, {
      method: req.method,
      headers,
      body,
      // Node 的流式请求体需要 duplex 声明
      ...(body ? { duplex: 'half' } : {}),
    });
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      const base = `http://${req.headers.host ?? `${httpHost}:${httpPort}`}`;
      const webRes = await handle.fetch(await toWebRequest(req, base));
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
      if (webRes.body) {
        for await (const chunk of webRes.body) res.write(Buffer.from(chunk));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: `内部错误: ${err?.message ?? err}` }, id: null }));
    } finally {
      if (verbose) console.error(`[cn-models-mcp] ${req.method} ${req.url} → ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(httpPort, httpHost, resolvePromise);
  });

  console.error(startupBanner('streamable-http'));
  console.error(`[cn-models-mcp] 监听 http://${httpHost}:${httpPort}/mcp`);
  console.error('[cn-models-mcp] 注意：客户端必须同时接受 application/json 与 text/event-stream');

  const shutdown = () => {
    server.close();
    Promise.resolve(handle.close?.()).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  void serveStdio(buildServer);
  console.error(`${startupBanner('stdio')} · 协议通道 stdout`);
}
