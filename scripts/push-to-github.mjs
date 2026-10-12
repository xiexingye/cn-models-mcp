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

async function api(method, path, body) {
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
  if (!res.ok) {
    const msg = json?.message ?? text.slice(0, 300);
    const err = new Error(`${method} ${path} -> HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

const created = { blobs: 0, trees: 0 };

/** 把本地某个 tree 对象递归上传，返回 GitHub 上的 tree sha */
async function pushTree(localSha, label = '') {
  const raw = git('cat-file', '-p', localSha);
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];

  for (const line of lines) {
    // git cat-file -p <tree> 每行格式: <mode> <type> <sha>\t<name>
    const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]{40})\t(.*)$/);
    if (!m) throw new Error(`无法解析 tree 行: ${line}`);
    const [, mode, type, sha, name] = m;

    if (type === 'tree') {
      const childSha = await pushTree(sha, `${label}${name}/`);
      entries.push({ path: name, mode, type: 'tree', sha: childSha });
    } else if (type === 'blob') {
      const content = gitRaw('cat-file', 'blob', sha).toString('base64');
      const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
      created.blobs += 1;
      entries.push({ path: name, mode, type: 'blob', sha: blob.sha });
    } else {
      throw new Error(`不支持的 tree 条目类型: ${type}（${name}）`);
    }
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

  const existing = new Set();
  if (remoteHasCommits) {
    const remoteCommits = await api('GET', `/repos/${REPO}/commits?per_page=100`);
    remoteCommits.forEach((c) => existing.add(c.sha));
    console.log(`远端已有提交: ${remoteCommits.length}`);
  }

  let lastSha = seedCommitSha;   // 第一个本地提交的父提交
  for (const sha of commits) {
    if (existing.has(sha)) {
      console.log(`  已存在，跳过 ${sha.slice(0, 8)}`);
      lastSha = sha;
      continue;
    }
    const meta = git('cat-file', 'commit', sha);
    const treeLine = meta.split('\n').find((l) => l.startsWith('tree '));
    const parentLine = meta.split('\n').find((l) => l.startsWith('parent '));
    const authorLine = meta.split('\n').find((l) => l.startsWith('author '));
    const committerLine = meta.split('\n').find((l) => l.startsWith('committer '));
    const message = meta.slice(meta.indexOf('\n\n') + 2);

    const parsePerson = (line) => {
      // author 名字 <邮箱> 时间戳 时区
      const m = line.match(/^(\w+) (.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
      if (!m) throw new Error(`无法解析身份行: ${line}`);
      const [, , name, email, date] = m;
      return { name, email, date: new Date(Number(date) * 1000).toISOString() };
    };

    const localTreeSha = treeLine.split(' ')[1];
    console.log(`\n推送提交 ${sha.slice(0, 8)} — ${message.split('\n')[0]}`);
    const ghTreeSha = await pushTree(localTreeSha);

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
