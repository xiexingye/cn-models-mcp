/**
 * Credential loading, in priority order:
 *   1. real environment variables (what MCP clients let you configure)
 *   2. ~/.cn-models-mcp.json  ->  { "DEEPSEEK_API_KEY": "...", ... }
 *   3. ./.env                 ->  DEEPSEEK_API_KEY=...
 *
 * Nothing is ever written to disk by this tool, and keys are never logged in full.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv(env = process.env, { cwd = process.cwd() } = {}) {
  const merged = { ...env };

  const jsonPath = join(homedir(), '.cn-models-mcp.json');
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && !merged[k]) merged[k] = v;
      }
    } catch (err) {
      console.error(`[cn-models-mcp] 忽略无法解析的 ${jsonPath}: ${err.message}`);
    }
  }

  const dotenvPath = resolve(cwd, '.env');
  if (existsSync(dotenvPath)) {
    try {
      for (const [k, v] of Object.entries(parseDotEnv(readFileSync(dotenvPath, 'utf8')))) {
        if (!merged[k]) merged[k] = v;
      }
    } catch (err) {
      console.error(`[cn-models-mcp] 忽略无法读取的 ${dotenvPath}: ${err.message}`);
    }
  }

  return merged;
}

/** Mask a key for display: never print a full secret. */
export function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 6)}…${key.slice(-4)}（${key.length} 位）`;
}
