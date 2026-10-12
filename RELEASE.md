# 发布清单

## 已完成（可核对）

| 项 | 状态 |
| --- | --- |
| `package.json` 仓库地址 | ✅ 已改为 `github.com/xiexingye/cn-models-mcp` |
| 包名可用性 | ✅ `cn-models-mcp` / `cn-models` / `mcp-cn-models` 均未被占用 |
| `npm pack` 预演 | ✅ 10 个文件、20.2 kB；`src/` 完整、测试与文档已排除 |
| registry 配置 | ✅ 已移除指向只读镜像的 `.npmrc`，当前为 `registry.npmjs.org` |
| LICENSE | ✅ MIT |
| 三个测试套件 | ✅ stdio 9/9 · HTTP 8/8 · 跨厂商 10/10 |
| README 首屏 GIF | ✅ `docs/demo.gif`（真实调用回放） |

---

## ⚠️ 待你处理 1：轮换两个 API Key

**我无法代你轮换** —— 这需要登录你的厂商控制台。请在浏览器里操作：

| 厂商 | 轮换地址 | 操作 |
| --- | --- | --- |
| DeepSeek | https://platform.deepseek.com/api_keys | 删除旧 key → 新建 → 复制 |
| 智谱 GLM | https://bigmodel.cn/usercenter/proj-mgmt/apikeys | 同上 |

**为什么必须换**：这两个 key 出现在聊天记录里了，任何能看到该记录的人都能用它消耗你的余额。

轮换后把新 key 写进 `~/.cn-models-mcp.json`（推荐，不动系统环境变量）：

```json
{
  "DEEPSEEK_API_KEY": "sk-新的",
  "ZHIPU_API_KEY": "新的"
}
```

然后跑一次体检确认新 key 生效：

```bash
node src/doctor.mjs
```

---

## ⚠️ 待你处理 2：发布到 npm（当前被网络阻塞）

### 现状诊断（2026-10-12 实测）

| 端点 | 结果 | 影响 |
| --- | --- | --- |
| `registry.npmjs.org`（发布 API） | ✅ HTTP 200 | `npm publish` 本身可用 |
| `registry.npmjs.org/-/whoami` | ✅ 401（预期） | 鉴权链路正常 |
| **`www.npmjs.com`（网站）** | ❌ **HTTP 403** | **无法注册账号、无法生成 token** |

**结论**：被卡的只有"必须走网站"的两个动作（注册、生成 token）。已尝试换节点 / 全局模式 / 手机热点均无效，属 IP/指纹级 WAF 拦截。

### 三条可行出路

**出路 A：换个网络一次性拿 token（推荐）**

只需**一次**在别的网络环境完成注册 + 生成 token（token 只显示一次，务必复制保存）。之后：

> **发布可以完全交给 GitHub Actions** —— CI 跑在 GitHub 的机器上，出口 IP 与你无关，所以本地网络再差也不影响发布。

**出路 B：用 git 直装（已实测可行，无需 npm 账号）**

```bash
npx -y github:xiexingye/cn-models-mcp
# 或
npm i -g github:xiexingye/cn-models-mcp
```

走 `github.com` + `codeload`，**不经过 npm registry 与 npmjs.com**。已实测 `npm install <git 仓库>` 能正确装出包并注册 `bin`。README 已作为备选安装方式写入。

> 代价：用户装到的是仓库当前状态而非发布版本，也没有 provenance 徽章。适合先让项目跑起来。

**出路 C：等网络环境变化**

npm 的 WAF 放行策略会变（换时间段、换出口 IP 段都可能突然通），过几天再试一次注册页。

### 账号到手后的发布流程

**两条路，推荐第一条。**

### 路线 A：CI 发布（`.github/workflows/publish.yml` 已写好）

**为什么推荐**：不用碰 `npm login`（浏览器交互 + 2FA 在本机不一定顺畅），token 只存在 GitHub 加密 secret 里。

**步骤：**

1. **在 npmjs.com 生成 token** → 头像 → Access Tokens → Generate New Token → **Granular Access Token**
   - 权限：`Read and write`
   - 范围：选择你要发布的包（首次发布前包还不存在，选 "All packages" 或发布后再收紧）
   - 有效期：建议 90 天
   - ⚠️ 如果没有绑 2FA，npm 会强制走邮件验证码；**建议直接开 2FA**，否则某些账号类型无法创建 write token

2. **存进 GitHub secret**（仓库 → Settings → Secrets and variables → Actions → New repository secret）
   - 名称：`NPM_TOKEN`
   - 值：上一步的 token

   > 或命令行：`gh secret set NPM_TOKEN`

3. **触发发布**，任选一种：
   - 推 tag：`git tag v0.1.0 && git push origin v0.1.0`
   - 或在 GitHub 上建一个 Release
   - 或在 Actions 页面手动跑 `Publish`（默认 `dry_run=true`，只做打包预演；改成 false 才真发）

工作流会依次做：`npm ci` → `npm pack --dry-run` → **校验 tag 与 `package.json` 版本一致**（不一致直接拒绝发布，防止发错版本）→ `npm publish --access public --provenance`。

### 路线 B：本地发布（npm 网络恢复后）

```bash
cd cn-models-mcp
npm login --registry https://registry.npmjs.org/
npm publish --access public --registry https://registry.npmjs.org/ --cache ./.npm-cache
```

> `--cache ./.npm-cache` 是必要的：npm 默认缓存目录在本机实测会报 `EPERM`。

### 发布后验证

```bash
npm view cn-models-mcp version          # 看到 0.1.0 即成功
npx -y cn-models-mcp --help             # 能启动即成功（会等 stdin，Ctrl+C 退出）
```

### 首次发布之后：切到 Trusted Publishing（OIDC）

**重要背景**：npm 正在淘汰 token 发布，**2027 年 1 月起 token 不能单独发布**。所以首次发布成功后应立即切换：

```bash
# npm >= 11.15，会要求 2FA
npm trust github cn-models-mcp --repo xiexingye/cn-models-mcp --file publish.yml --allow-publish --yes
```

或网页操作：npmjs.com → 你的包 → **Settings → Trusted publishing** → 填 `xiexingye/cn-models-mcp` + 工作流文件名 `publish.yml`。

绑定后：工作流里的 `NODE_AUTH_TOKEN` 不再被使用（npm 优先走 OIDC），**可以删除 `NPM_TOKEN` secret 并在 npm 上吊销该 token**。`id-token: write` 权限已配好，`--provenance` 也已加上，所以切换不需要改代码。

> ⚠️ 注意：trusted publisher 里填的**工作流文件名必须完全一致**（含 `.yml`、区分大小写），否则会报 `ENEEDAUTH` 或 `404 on PUT`。

---

## 待你处理 3：GitHub 仓库

```bash
cd cn-models-mcp
git init
git add .
git status                      # ← 务必确认没有 .env、_selftest/*.jsonl、node_modules
git commit -m "feat: MCP server exposing DeepSeek/Kimi/GLM/Qwen as a cheap second opinion"
git branch -M main
git remote add origin https://github.com/xiexingye/cn-models-mcp.git
git push -u origin main
```

仓库建好后建议补上：

- **About**：`让 Claude Code / Cursor 多一个便宜的第二意见 · DeepSeek / Kimi / GLM / Qwen · 无需海外卡与 VPN`
- **Topics**：`mcp` `model-context-protocol` `claude-code` `cursor` `cline` `deepseek` `kimi` `glm` `qwen` `llm`
- 勾选 Issues

---

## 首发（决定第一周能不能过 50 star）

按预期回报排序，**发布后 24 小时内一次性发完**：

| 渠道 | 标题建议 |
| --- | --- |
| **V2EX** `/go/programming` | 「给 Claude Code 配了个便宜的第二意见：一次调用 0.0015 元」 |
| **LinuxDo** AI 板块 | 同上（该社区对 MCP 接受度高） |
| **掘金 / 少数派** | 教程向：「我是怎么把 DeepSeek 接进 Claude Code 的」+ 仓库链接 |
| **Hacker News** | `Show HN: MCP server that adds cheap Chinese LLMs as a second opinion to Claude Code` |
| **r/LocalLLaMA · r/ChatGPTCoding** | 英文；**务必说明是 API 调用而非本地模型**，否则会被误解 |
| **即刻 / 小红书** | 面向"被 Opus 账单吓到"的泛用户，突出 ¥0.0015 vs ¥3 |

**时机**：跟着模型发布走（GLM / Kimi / DeepSeek 出新版当天或次日发更新），流量是平时数倍。

---

## 已知限制（写进首发文案更显诚实，也减少 issue）

- 仅支持 **stdio 与 Streamable HTTP**；纯云端宿主需用 `--http`
- 不支持流式输出到客户端（一次性返回）
- 无会话级累计花费统计
- `kimi-k3` / `qwen3-coder-plus` 的单价尚未实测对账（缺密钥）；智谱与 DeepSeek 已对账
- DSH 用户需走桥接插件，不能直接抄 `.mcp.json`
