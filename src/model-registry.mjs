/**
 * Model registry — the single source of truth for providers, models and prices.
 *
 * Prices are CNY per 1M tokens, as published by each vendor's pricing page.
 * `in` = cache-miss input, `out` = output. `peak` reflects the vendor's peak-hour
 * price when the vendor has time-of-day pricing (DeepSeek does).
 *
 * Verified against vendor docs on 2026-10-12. Vendors change prices — if you find
 * a stale number, PRs to this file are the easiest contributions to accept.
 */

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    pricingUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    note: '闲暇时段（北京时间周一至周五 9:00-12:00、14:00-18:00 之外）价格为高峰价的一半',
  },
  moonshot: {
    label: 'Kimi / Moonshot',
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.cn/v1',
    keysUrl: 'https://platform.kimi.com/console/api-keys',
    pricingUrl: 'https://platform.kimi.com/docs/pricing/chat',
  },
  zhipu: {
    label: '智谱 GLM',
    envKey: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keysUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    pricingUrl: 'https://bigmodel.cn/pricing',
  },
  dashscope: {
    label: '通义千问 Qwen',
    envKey: 'DASHSCOPE_API_KEY',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keysUrl: 'https://bailian.console.aliyun.com/',
    pricingUrl: 'https://help.aliyun.com/zh/model-studio/models',
  },
};

/**
 * Cheap-and-fast tier: used for routine "second opinion" calls.
 */
export const MODELS = [
  {
    id: 'deepseek-flash',
    provider: 'deepseek',
    label: 'DeepSeek V4.1 Flash',
    contextTokens: 1_000_000,
    price: { in: 2, out: 8, peak: { in: 2, out: 8 }, offPeak: { in: 1, out: 4 }, cacheHit: { in: 0.04, offPeakIn: 0.02 } },
    good: ['日常问答', '代码补全', '长文档总结', '便宜的批量任务'],
    thinking: true,
    vision: true,
  },
  {
    id: 'glm-5.3-flash',
    provider: 'zhipu',
    label: 'GLM-5.3-Flash',
    contextTokens: 200_000,
    price: { in: 0.5, out: 2 },
    good: ['极低成本初筛', '格式转换', '简单抽取'],
    thinking: false,
    vision: false,
    priceVerified: '2026-10-12 实测对账：19↓ 185↑ → ¥0.00038，与 ¥0.5/¥2 一致',
  },
  {
    id: 'qwen3-coder-plus',
    provider: 'dashscope',
    label: 'Qwen3 Coder Plus',
    contextTokens: 1_000_000,
    price: { in: 4, out: 16 },
    good: ['代码生成', '仓库级理解', '重构'],
    thinking: false,
    vision: false,
    priceNote: '价格以阿里云百炼定价页为准',
  },

  /**
   * Strong tier: the "call in the big gun but cheaper than Opus" tier.
   */
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    label: 'DeepSeek V4 Pro',
    contextTokens: 1_000_000,
    price: { in: 9, out: 27, offPeak: { in: 4.5, out: 13.5 } },
    good: ['复杂推理', '大型重构', '疑难 bug 定位'],
    thinking: true,
    vision: false,
  },
  {
    id: 'kimi-k3',
    provider: 'moonshot',
    label: 'Kimi K3',
    contextTokens: 256_000,
    price: { in: 4, out: 16 },
    good: ['长上下文', '资料研读', '复杂 agent 任务'],
    thinking: true,
    vision: true,
    priceNote: '价格以 Kimi 定价页为准',
  },
  {
    id: 'glm-5.3',
    provider: 'zhipu',
    label: 'GLM-5.3',
    contextTokens: 200_000,
    price: { in: 4, out: 16 },
    good: ['中文写作', '结构化输出', '代码审查'],
    thinking: true,
    vision: false,
    priceVerified: '2026-10-12 实测对账：19↓ 184↑ → ¥0.00302，与 ¥4/¥16 一致',
  },
];

/** Reference point for "how much did I just save" math. */
export const REFERENCE = {
  label: 'Claude Opus 5.5',
  price: { in: 30.4, out: 152 },
  note: '官方 $4/$20 每百万 token，按 7.6 汇率折算；仅供参考，用于展示国内模型的成本差距',
};

export function getProvider(name) {
  return PROVIDERS[name] ?? null;
}

export function getModel(id) {
  return MODELS.find((m) => m.id === id) ?? null;
}

export function modelsWithKey(env = process.env) {
  return MODELS.filter((m) => Boolean(env[getProvider(m.provider).envKey]));
}

export function missingKeys(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => !env[p.envKey])
    .map(([name, p]) => ({ name, label: p.label, envKey: p.envKey, keysUrl: p.keysUrl }));
}

/**
 * Cost of one call in CNY. `cacheRatio` is the share of input tokens served from
 * the vendor's prompt cache (cheaper for DeepSeek).
 */
export function estimateCostCny(modelId, { inputTokens = 0, outputTokens = 0, cacheRatio = 0 } = {}) {
  const model = getModel(modelId);
  if (!model) return null;
  const p = model.price;
  const cachePrice = p.cacheHit?.in ?? p.in;
  const inputCost = ((1 - cacheRatio) * inputTokens * p.in + cacheRatio * inputTokens * cachePrice) / 1e6;
  const outputCost = (outputTokens * p.out) / 1e6;
  return { cny: inputCost + outputCost, inputCost, outputCost };
}
