# 待办与发布清单

> 这份文件是给作者（不是给用户）的。README 是对外的门面，这里记录"离一个能拿 star 的仓库还差什么"。

## 一、发布前必做（当前状态：**准备就绪，仅差执行**）

详见 **[RELEASE.md](RELEASE.md)**。要点：

- ✅ 包名 `cn-models-mcp` 未被占用（已验证）
- ✅ `npm pack --dry-run`：10 个文件 / 20.2 kB，`src/` 完整
- ✅ 仓库地址已填 `xiexingye`
- ✅ 已移除指向只读镜像的 `.npmrc`（否则 `npm publish` 必失败）
- ✅ **CI 发布工作流已就绪**：`.github/workflows/publish.yml`（tag 触发 + 版本一致性校验 + `--provenance` + OIDC `id-token: write`）
- ⏳ **轮换两个 API Key**（我无法代做，需登录厂商控制台）
- ⏳ **在 npm 生成 token → 存入 GitHub secret `NPM_TOKEN` → 推 tag 发布**（首次必须用 token，因为 npm 只能给已存在的包绑定 Trusted Publisher）
- ⏳ 首次发布后切换到 **Trusted Publishing（OIDC）**并吊销 token —— npm 将于 **2027-01 起禁止 token 单独发布**

> 本地 git 仓库已初始化，23 个文件已 `git add`（`.env` / `node_modules` / 渲染产物均已排除）。**只差 git 身份配置**（`user.name` / `user.email`）即可完成首次提交。


<details>
<summary>历史记录：早期版本的本地安装说明（发布后不再需要）</summary>

README 里的快速开始用的是 `npx -y cn-models-mcp`，发布到 npm 后即可用。若暂不发布，可把 MCP 配置的 `command` 改成 `node` + 本机绝对路径：

```json
{
  "mcpServers": {
    "cn-models": {
      "command": "node",
      "args": ["C:/完整路径/cn-models-mcp/src/index.mjs"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

</details>


## 二、涨星机制自检（对照七个杠杆）

| 杠杆 | 状态 | 说明 |
| --- | --- | --- |
| **README 效果展示（GIF）** | ✅ **已完成** | `docs/demo.gif`（900×560，36 帧，11.8 秒，255 KB）已放进 README 首屏。内容是**真实调用的回放**：打字机输入 → MCP 工具调用 → 真实计费行 `58↓ 365↑ · ¥0.0015 · 3183ms` → 三行回答 → Claude 判断结论正确。数字全部来自厂商返回的真实 usage |
| 10 秒可验证 | ✅ | GIF 第一屏就能看懂"问一句 → 花 0.0015 元 → 拿到答案"，且**有真实数字** |
| **npm 上架** | ⏸ **已暂缓** | `www.npmjs.com` 对本机出口 IP 返回 403（WAF 拦截），无法注册账号/生成 token。已实测 `registry.npmjs.org` 正常（200/401），所以发布通道本身没问题。**改用 `npx -y github:xiexingye/cn-models-mcp` 作为安装方式**（不经过 npm，已实测可用） |
| 一行安装 | ✅ | `npx -y github:xiexingye/cn-models-mcp`（上架后换成包名） |
| **兼容性边界写清** | ✅ | 已补 11 个客户端的矩阵 + Windsurf/Zed 字段差异 + DSH 需桥接插件（避免"装了没反应"的差评） |
| 定位清晰 | ✅ | 开篇第一句就说明"不用海外卡/VPN"+"第二意见" |
| 真实数据不吹 | ✅ | 价格表由脚本从注册表生成，核对日期写明；智谱价格已实测对账；GIF 数字来自真实调用 |
| **功能面覆盖更广** | ✅ | 新增 `--http`（Streamable HTTP），覆盖 ChatGPT 开发者模式与云端宿主 |
| LICENSE / 贡献指引 | ✅ | MIT，路线图里点名了最容易的 PR |
| 首发渠道 | ⏳ 待做 | 见第三节 |
| 诚实边界 | ✅ | FAQ + 设计取舍里承认"不替代主模型" |


## 三、首发渠道清单（按预期回报排序）

1. **V2EX** `/go/create` 或 `/go/programming` —— 标题写痛点不写技术：「给 Claude Code 配了个便宜的第二意见，一个月省了 XX 元」
2. **LinuxDo** —— MCP / AI 板块，该社区对 MCP 工具接受度高
3. **掘金 / 少数派** —— 发一篇「我是怎么把 DeepSeek 接进 Claude Code 的」教程，文末放仓库
4. **Hacker News（Show HN）** —— 英文标题示例：`Show HN: MCP server that adds cheap Chinese LLMs as a second opinion to Claude Code`
5. **r/LocalLLaMA、r/ChatGPTCoding** —— 英文，注意说明"API 调用"而非本地模型，避免被误解
6. **即刻 / 小红书** —— 面向"被 Opus 账单吓到"的泛用户

**时机建议**：跟着模型发布走（GLM / Kimi / DeepSeek 出新版当天或次日发相关更新），流量是平时的数倍。

## 四、可以立刻做的三个低成本改进

- [ ] **录 GIF**（最高优先）：终端 + Claude Code 对话，20 秒内展示"提问 → 工具调用 → 花费 → 结论"。放在 README 第一屏
- [ ] **加一个"为什么不用 X"对比表**：vs 中转站、vs 直接换主模型、vs 各厂商 SDK —— 消除读者疑问能显著提高转化
- [ ] **加 `screenshots/` 目录**并链接进 README（GitHub 上图片比外部图床稳）

## 五、已知技术限制（写进 README 更显诚实）

- 不支持流式输出（MCP 工具返回一次性结果），长回答等待时间较长
- 没有会话级累计花费统计（只有单次花费）
- `qwen3-coder-plus` / `glm-5.3-flash` 的价格标注为"以定价页为准"，未逐项核对

## 六、验证记录（防止后人重复踩坑）

### 真实端到端结果：9/9 通过

用 `_selftest/harness.mjs`（最小 MCP 客户端，保持连接直到收到响应）跑真实 API：

```
✓ initialize 握手 — serverInfo=cn-models-mcp
✓ 协议版本协商 — 2025-11-25
✓ tools/list 返回 4 个工具 — ask, check_setup, compare, list_models
✓ check_setup 正常返回
✓ ask 真实调用成功 — DeepSeek · deepseek-flash · 37↓ 195↑（含思考 155） tokens · ¥0.0008，闲时价 · 1992ms
✓ 小预算空正文给出可操作提示
✓ 未知模型被正确拒绝
✓ compare 多模型对比成功 — 2/2 个模型返回成功，合计花费约 ¥0.0010
✓ stderr 有启动日志（协议通道未被污染）
```

### 实测中发现并修复的三个真问题

1. **思考 token 吃光预算导致空正文**（最重要）
   DeepSeek 默认开思考，思考 token 从 `max_tokens` 扣且按输出价计费。`maxTokens=150` 时正文必空。
   → 修复：默认值提到 4096；空正文时返回可操作提示（说明思考占了多少、建议调到多少）；`summarize()` 标注"含思考 N"。
2. **429 / 402 错误提示映射反了**
   国内厂商余额不足常用 **429** 而非 402。→ 已对调并合并提示。
3. **思考过程原文污染上下文**
   思考链又长又自指（模型在里面自言自语）。→ 截断到 600 字并标注总长度。

### 测试环境的三个坑（与代码无关，但会浪费你时间）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| npm 默认缓存目录 | `EPERM: open '%LOCALAPPDATA%\npm-cache\_cacache\tmp\...'` | `npm install --cache <工作区内目录>` |
| registry 直连 | `基础连接已经关闭` / `schannel: AcquireCredentialsHandle failed` | 用 `registry.npmmirror.com`（`.npmrc` 已配） |
| 管道喂请求做 e2e | 异步工具（`ask`）的响应**永远收不到** | stdin 一关，在途请求随进程退出；必须用握有管道的客户端（`harness.mjs`）。另外 `Start-Process -RedirectStandardOutput` 是块缓冲，强杀进程会丢缓冲 → 输出 0 字节，**不能**用它验证 |
| PS 5.1 `Set-Content -Encoding UTF8` | 写出 **BOM**，`JSON.parse` 直接报错 | 用 `[IO.File]::WriteAllText` + `UTF8Encoding($false)`，或 `-Encoding ASCII` |

### 尚未验证的部分（诚实记录）

- ~~`compare` 只测了同一厂商的两个模型~~ → **已补测跨厂商（2026-10-12）**：DeepSeek + 智谱 GLM 三家（`deepseek-flash` / `glm-5.3` / `glm-5.3-flash`）同时对比，3/3 成功，结果一致（都答 1024），合计花费 ¥0.0012 计算正确
- **智谱 GLM 价格已实测对账**（本次最有价值的验证）：
  - `glm-5.3-flash`：19↓ 185↑ → 复算 ¥0.000380 vs 上报 ¥0.000400，与注册表 ¥0.5/¥2 一致 ✅
  - `glm-5.3`：19↓ 184↑ → 复算 ¥0.003020 vs 上报 ¥0.003000，与注册表 ¥4/¥16 一致 ✅
  - 两者均**未被误判为闲时价**（智谱无时段定价，判定逻辑正确）✅
- DeepSeek 的 `¥1/¥4`（闲时）/ `¥2/¥8`（高峰）也经实调用核对一致
- 未验证：`kimi-k3`、`qwen3-coder-plus`（缺密钥）；`deepseek-v4-pro` 价格未逐项对账
- 未在**真实 MCP 宿主**（Claude Code / Cursor / Cline）里装过；协议层用 harness 验证，宿主侧配置示例按官方文档编写
- 未做流式、未做并发压力测试

### 跨厂商验证脚本

`_selftest/cross-provider.mjs`（10 项）会在真实调用后**独立复算计费**并与服务端上报值比对，同时检查"是否被误判为闲时价"：

```bash
DEEPSEEK_API_KEY=sk-xxx ZHIPU_API_KEY=xxx node _selftest/cross-provider.mjs
```

这套"真实调用 + 计费对账"的模式建议在每次改 `model-registry.mjs` 价格后跑一次——价格写错是这类项目最容易悄悄亏钱的地方。


## 七、安全提醒（给作者）

- 测试用的 DeepSeek 密钥曾出现在聊天记录中，**建议在控制台轮换一次**
- 密钥全程只作为进程环境变量传入，**没有写进仓库任何文件**；`.gitignore` 已排除 `.env`
- 首次 `git push` 前确认 `git status` 里没有 `.env`、`_selftest/*.jsonl`、`.npm-cache/`

