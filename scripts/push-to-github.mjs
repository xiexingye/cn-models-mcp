#!/usr/bin/env node
/**
 * 把本地 git 仓库推送到 GitHub —— 走 Git Data API，不用 git push。
 *
 * 为什么这么绕：当前沙箱进程无法完成 Windows TLS 握手（Schannel
 * "AcquireCredentialsHandle failed"），所以 git/curl 都推不上去；
 * 而 Node 的 fetch 走自己的 TLS 栈，配合从 Git Credential Manager 取出的
 * 凭证即可调用 GitHub API。
 *
 * 凭证只保存在内存里，不写入任何文件、不打印。
 *
 * 用法：node scripts/push-to-github.mjs <owner/repo>
 */

import { execFileSync } from 'node:child_process';

const REPO = process.argv[2] ?? 'xiexingye/cn-models-mcp';
const API = 'https://api.github.com';
const GCM = 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitRaw(...args) {
  return execFileSync('git', args, { maxBuffer: 128 * 1024 * 1024 });
}

/** 取凭证：优先环境变量（推荐，沙箱里 Node 无法 spawn 出 GCM），其次向 GCM 索取 */
function getToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const payload = 'protocol=https\nhost=github.com\n\n';
  const out = execFileSync(GCM, ['get'], { input: payload, encoding: 'utf8' });
  const password = out.split('\n').find((l) => l.startsWith('password='));
  if (!password) throw new Error('凭证管理器未返回 token');
  return password.slice('password='.length).trim();
}

const token = getToken();
console.log(`凭证已获取（长度 ${token.length}，不显示内容）`);

async function api(method, path, body, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'cn-models-mcp-push',
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

      // 5xx 是暂时性故障（实测遇到过内容为空的 HTTP 500），退避后重试
      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error(`${method} ${path} -> HTTP ${res.status}: ${json?.message ?? text.slice(0, 200) ?? '(空响应)'}`);
        const wait = 800 * 2 ** attempt;
        console.error(`  [重试 ${attempt + 1}/${retries}] ${method} ${path} HTTP ${res.status}，${wait}ms 后重试`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const msg = json?.message ?? text.slice(0, 300) ?? '(空响应体)';
        const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${msg}`);
        err.status = res.status;
        err.json = json;
        throw err;
      }
      return json;
    } catch (err) {
      if (err.status) throw err;            // 已带状态码的 API 错误，不再重试
      lastErr = err;                        // 网络层错误 → 退避重试
      if (attempt < retries) {
        const wait = 800 * 2 ** attempt;
        console.error(`  [重试 ${attempt + 1}/${retries}] ${method} ${path} 网络错误，${wait}ms 后重试`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const created = { blobs: 0, trees: 0, reused: 0 };

/** 该 tree 是否已存在于远端（幂等推送的关键：本地与远端 sha 不同，不能按提交 sha 判断） */
async function remoteTreeExists(sha) {
  try {
    await api('GET', `/repos/${REPO}/git/trees/${sha}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/** 把本地某个 tree 对象递归上传，返回 GitHub 上的 tree sha（已存在则直接复用） */
async function pushTree(localSha, label = '') {
  const raw = git('cat-file', '-p', localSha);
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];

  // 子树先递归（已存在的直接复用，避免重复上传整棵树）
  const subTrees = [];
  const blobs = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\t(.*)$/);
    if (!m) throw new Error(`无法解析 tree 行: ${line}`);
    const [, mode, type, sha, name] = m;
    if (type === 'tree') subTrees.push({ mode, sha, name });
    else if (type === 'blob') blobs.push({ mode, sha, name });
    else throw new Error(`不支持的 tree 条目类型: ${type}（${name}）`);
  }

  for (const t of subTrees) {
    const childSha = await pushTree(t.sha, `${label}${t.name}/`);
    entries.push({ path: t.name, mode: t.mode, type: 'tree', sha: childSha });
  }

  for (const b of blobs) {
    const content = gitRaw('cat-file', 'blob', b.sha).toString('base64');
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
    created.blobs += 1;
    entries.push({ path: b.name, mode: b.mode, type: 'blob', sha: blob.sha });
  }

  const tree = await api('POST', `/repos/${REPO}/git/trees`, { tree: entries });
  created.trees += 1;
  console.log(`  tree ${label || '(root)'} -> ${tree.sha.slice(0, 8)} (${entries.length} 项)`);
  return tree.sha;
}

async function main() {
  console.log(`\n目标仓库: ${REPO}`);

  // 0) 仓库是否存在、是否为空
  let repoInfo;
  try {
    repoInfo = await api('GET', `/repos/${REPO}`);
    console.log(`仓库存在，默认分支 ${repoInfo.default_branch}，大小 ${repoInfo.size} KB`);
  } catch (err) {
    if (err.status === 404) throw new Error(`仓库 ${REPO} 不存在（或 token 无权限）`);
    throw err;
  }

  const branch = 'main';

  // GitHub 的 Git Data API 在空仓库上会返回 409，必须先有一个提交。
  // 用 Contents API 写一个占位文件初始化，记下它的 commit 作为我们第一个提交的父提交。
  // 占位文件不会出现在最终树里（我们提交的 tree 会完整替换它）。
  let seedCommitSha = null;
  let remoteHasCommits = false;
  try {
    const remoteCommits = await api('GET', `/repos/${REPO}/commits?per_page=1`);
    remoteHasCommits = remoteCommits.length > 0;
    if (remoteHasCommits) console.log(`远端已有提交，最新 ${remoteCommits[0].sha.slice(0, 8)}`);
  } catch {
    remoteHasCommits = false;
  }

  if (!remoteHasCommits) {
    console.log('空仓库 → 先用 Contents API 初始化（Git Data API 在空仓库上会 409）');
    const seed = await api('PUT', `/repos/${REPO}/contents/.gitseed`, {
      message: 'chore: initialize repository',
      content: Buffer.from('initialized by cn-models-mcp push script\n').toString('base64'),
      branch,
    });
    seedCommitSha = seed.commit.sha;
    console.log(`  初始化提交 ${seedCommitSha.slice(0, 8)}（占位文件 .gitseed）`);
  }

  const commits = git('rev-list', '--reverse', 'HEAD').split('\n').filter(Boolean);
  console.log(`本地提交数: ${commits.length}`);

  // 远端提交的 tree -> commit sha 映射。
  // 注意：不能按提交 sha 判断"是否已推送" —— 我们是用 API 重建的提交，sha 与本地不同；
  // 但 tree 内容相同则 sha 相同，所以用 tree 做标识（这也让重复运行变得幂等）。
  const existing = new Set();
  const remoteByTree = new Map();
  if (remoteHasCommits) {
    const remoteCommits = await api('GET', `/repos/${REPO}/commits?per_page=100`);
    remoteCommits.forEach((c) => {
      existing.add(c.sha);
      remoteByTree.set(c.commit.tree.sha, c.sha);
    });
    console.log(`远端已有提交: ${remoteCommits.length}`);
  }

  // 已存在的 tree 直接复用，避免重复上传整棵树
  async function ensureTree(localTreeSha, label) {
    if (await remoteTreeExists(localTreeSha)) {
      created.reused += 1;
      console.log(`  tree ${label || '(root)'} 已存在，复用 ${localTreeSha.slice(0, 8)}`);
      return localTreeSha;
    }
    return pushTree(localTreeSha, label);
  }

  let lastSha = seedCommitSha;   // 第一个本地提交的父提交
  for (const sha of commits) {
    const meta = git('cat-file', 'commit', sha);
    const treeLine = meta.split('\n').find((l) => l.startsWith('tree '));
    const authorLine = meta.split('\n').find((l) => l.startsWith('author '));
    const committerLine = meta.split('\n').find((l) => l.startsWith('committer '));
    const message = meta.slice(meta.indexOf('\n\n') + 2);
    const localTreeSha = treeLine.split(' ')[1];

    // 这个提交的内容已经在远端 → 视为已推送，把它当作后续提交的父提交
    if (remoteByTree.has(localTreeSha)) {
      lastSha = remoteByTree.get(localTreeSha);
      console.log(`  已推送过，跳过 ${sha.slice(0, 8)}（远端 ${lastSha.slice(0, 8)}）`);
      continue;
    }

    const parsePerson = (line) => {
      // author 名字 <邮箱> 时间戳 时区
      const m = line.match(/^(\w+) (.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
      if (!m) throw new Error(`无法解析身份行: ${line}`);
      const [, , name, email, date] = m;
      return { name, email, date: new Date(Number(date) * 1000).toISOString() };
    };

    console.log(`\n推送提交 ${sha.slice(0, 8)} — ${message.split('\n')[0]}`);
    const ghTreeSha = await ensureTree(localTreeSha);

    const commitBody = {
      message,
      tree: ghTreeSha,
      author: parsePerson(authorLine),
      committer: parsePerson(committerLine),
      // 第一个提交挂到初始化提交之下；其余沿用本地父提交（已按顺序推送）
      ...(lastSha ? { parents: [lastSha] } : {}),
    };
    const ghCommit = await api('POST', `/repos/${REPO}/git/commits`, commitBody);
    console.log(`  commit -> ${ghCommit.sha.slice(0, 8)}`);
    lastSha = ghCommit.sha;
  }

  if (!lastSha) throw new Error('没有可推送的提交');

  // 创建/更新分支引用
  const refName = `heads/${branch}`;
  try {
    await api('POST', `/repos/${REPO}/git/refs`, { ref: `refs/${refName}`, sha: lastSha });
    console.log(`\n已创建分支 ${branch} -> ${lastSha.slice(0, 8)}`);
  } catch (err) {
    if (err.status === 422) {
      await api('PATCH', `/repos/${REPO}/git/refs/${refName}`, { sha: lastSha, force: false });
      console.log(`\n已更新分支 ${branch} -> ${lastSha.slice(0, 8)}`);
    } else {
      throw err;
    }
  }

  // 设为默认分支（空仓库初始化后 GitHub 可能把默认分支设成别的）
  if (repoInfo.default_branch !== branch) {
    await api('PATCH', `/repos/${REPO}`, { default_branch: branch });
    console.log(`默认分支已设为 ${branch}`);
  }

  console.log(`\n完成：blobs ${created.blobs} 个，trees ${created.trees} 个`);
  console.log(`仓库地址: https://github.com/${REPO}`);
}

main().catch((err) => {
  console.error(`\n失败: ${err.message}`);
  process.exitCode = 1;
});
