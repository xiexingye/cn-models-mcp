/**
 * Minimal OpenAI-compatible client for the four providers in the registry.
 *
 * Deliberately dependency-free: global fetch only. That keeps the install light
 * and means every request/response is visible in ~120 lines instead of hidden in
 * an SDK — which is what you want for an MCP server that has to be auditable.
 */

import { getModel, getProvider } from './model-registry.mjs';

/** Thrown when a required API key is not configured. Carries onboarding info. */
export class ConfigError extends Error {
  constructor(provider) {
    super(`${provider.label} 的 API Key 未配置（环境变量 ${provider.envKey}）`);
    this.name = 'ConfigError';
    this.provider = provider;
  }
}

/** Thrown when the upstream vendor rejects or fails the request. */
export class ProviderError extends Error {
  constructor(provider, message, { status, body } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.body = body;
  }
}

export function resolveAuth(providerName, env = process.env) {
  const provider = getProvider(providerName);
  if (!provider) throw new Error(`未知 provider: ${providerName}`);
  const apiKey = env[provider.envKey];
  if (!apiKey) throw new ConfigError(provider);
  return { provider, apiKey };
}

/** True during DeepSeek's peak window: Mon-Fri 09:00-12:00 and 14:00-18:00 Beijing time. */
export function isDeepseekPeak(now = new Date()) {
  const beijing = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = beijing.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getHours() * 60 + beijing.getMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

function effectivePrice(model) {
  if (model.provider === 'deepseek' && model.price.offPeak && !isDeepseekPeak()) {
    return { ...model.price, ...model.price.offPeak, window: 'off-peak' };
  }
  return { ...model.price, window: model.price.offPeak ? 'peak' : 'standard' };
}

/**
 * Call one model. Returns the text plus a normalized usage/cost block so callers
 * (and the model itself) can see what a call cost.
 */
export async function chat({ modelId, messages, temperature, maxTokens = 2048, timeoutMs = 120_000, env = process.env }) {
  const model = getModel(modelId);
  if (!model) throw new Error(`未知模型: ${modelId}（用 list_models 查看可用模型）`);
  const { provider, apiKey } = resolveAuth(model.provider, env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  let res;
  try {
    res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        messages,
        max_tokens: maxTokens,
        ...(temperature === undefined ? {} : { temperature }),
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ProviderError(provider, `${model.id} 请求超时（${timeoutMs}ms）`, {});
    }
    throw new ProviderError(provider, `${model.id} 网络错误: ${err.message}`, {});
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail = json?.error?.message || json?.message || raw.slice(0, 300) || '(空响应体)';
    throw new ProviderError(provider, `${model.id} 调用失败 HTTP ${res.status}: ${detail}`, {
      status: res.status,
      body: raw.slice(0, 1000),
    });
  }

  const choice = json?.choices?.[0];
  const text = choice?.message?.content ?? '';
  const reasoning = choice?.message?.reasoning_content?.trim() || null;
  const usage = json?.usage ?? {};
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;

  if (!text) {
    // Reasoning models spend their budget on hidden thinking first. If the caller's
    // max_tokens is small, thinking can consume all of it and leave content empty —
    // a confusing "empty answer" that is really a token-budget problem.
    const reason = choice?.finish_reason ?? 'unknown';
    const hint =
      reasoningTokens > 0
        ? `思考过程占用了 ${reasoningTokens} 个输出 token（思考 token 按输出价计费），正文没有剩余预算。请把 maxTokens 调大（建议 ≥ 2000），或改用不带思考档的模型。`
        : `finish_reason=${reason}。可以调大 maxTokens 后重试。`;
    throw new ProviderError(provider, `${model.id} 返回空正文：${hint}`, {
      status: undefined,
      body: raw.slice(0, 1000),
    });
  }

  const price = effectivePrice(model);
  const costCny = (inputTokens * price.in + outputTokens * price.out) / 1e6;

  return {
    model: model.id,
    provider: model.provider,
    providerLabel: provider.label,
    text: text.trim(),
    reasoning,
    usage: { inputTokens, outputTokens, reasoningTokens, totalTokens: usage.total_tokens ?? inputTokens + outputTokens },
    costCny: Number(costCny.toFixed(6)),
    priceWindow: price.window,
    elapsedMs: Date.now() - started,
  };
}

/** Human-readable one-liner used in tool output. */
export function summarize(result) {
  const { providerLabel, model, usage, costCny, priceWindow, elapsedMs } = result;
  const windowNote = priceWindow === 'off-peak' ? '，闲时价' : '';
  const thinkingNote = usage.reasoningTokens ? `（含思考 ${usage.reasoningTokens}）` : '';
  return `${providerLabel} · ${model} · ${usage.inputTokens}↓ ${usage.outputTokens}↑${thinkingNote} tokens · ¥${costCny.toFixed(4)}${windowNote} · ${elapsedMs}ms`;
}
