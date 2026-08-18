# 调研报告 05：TDSF 项目群知识吸收与灵感提炼

> 调研对象：`D:\ai\linux教学一体`（TDSF-Linux 项目群）
> 调研目的：为 DSH「服务器开发 Agent 模式」方案书（docs/03）补充知识、验证选型、获取灵感
> 调研日期：2026-08-15
> 关联文档：docs/03-方案书-服务器开发Agent模式.md、docs/04-调研报告-开源远程开发方案对比.md

---

## 一、TDSF 项目群是什么（调研快照）

TDSF（Trustworthy Decision System Framework）是**「Linux 教学 + 运维 AI 决策辅助」人机协同可信决策智能体**，火山杯参赛项目。核心定位：不做替代判断的全自动 AIOps，而是**证据可核验、风险可感知、经验可沉淀**的运维搭档。

项目群构成（均为本机已有资产）：

| 子项目 | 说明 | 对我们价值 |
|---|---|---|
| `docs/technical/TDSF-Linux-技术方案书.md` | v3.0 定稿方案书（LangGraph 状态机 + 证据链 + 风险分级） | 机制设计灵感 |
| `docs/idea-to-dev-output/` | 45+ 份调研报告 + 8 份源码分析报告 | 开源生态知识库 |
| `docs/technical/开源项目复用清单.md` | 18 个 clone 项目的 License 核实 + 复用分级 | 复用纪律方法论 |
| `opensource-reference/` | 18 个已 clone 开源项目源码 | 可直接查阅 |
| `tdsf-linux-desktop/` | Electron 主项目（ssh2 + xterm.js + React） | 技术栈对照 |
| `tdsf-translate-v140/` | 终端翻译桌面应用（Electron + SSH） | SSH 架构对照 |

---

## 二、直接可用的知识（三大块）

### 2.1 OpenHands 沙箱架构 —— 与我们方案 B「执行后端替换型」同构（源码级验证）

TDSF 已 clone 并完成 `25-源码分析-OpenHands沙箱.md`，核心结论可直接引用进我们的方案书：

- **`SandboxService` 抽象接口**：`search_sandboxes / get_sandbox / get_sandbox_by_session_api_key / start / stop / pause / delete`，实现有 Local / Remote / Kubernetes 三态。
- **Action / Observation 协议**：Agent 发 Action → 沙箱执行 → 回传 Observation，与 DSH 的「provider 替换」完全同构。
- **RemoteSandboxService 细节**（`openhands/app_server/sandbox/remote_sandbox_service.py`）：
  - 通过 HTTP（httpx）连远程 runtime API，`X-API-Key` 认证；
  - `session_api_key` 以哈希存储，pause/delete 时主动作废 key；
  - 多服务暴露：`AGENT_SERVER / VSCODE / WORKER`。

**关键反衬**：OpenHands Remote 沙箱连的是**远程容器平台（runtime API）**，不是 SSH 直连。而 DSH 服务器开发模式走 **SSH 直连** —— 复用 dsh-remote-ide 已端到端验证的 ssh2 引擎，**比 OpenHands 更轻、免部署远程服务端**，这是我们的差异化优势，方案书 2.4 节可补此论证。

### 2.2 SSH 生态技术栈 —— TDSF 独立调研交叉验证了我们的全部选型

`07-开源项目调研-SSH远程操控.md` 是 TDSF 对 SSH 方向的深度调研（15+ 项目），结论与 dsh-remote-ide 已采用的方案**逐项吻合**：

| 能力 | TDSF 调研结论 | dsh-remote-ide 现状 | 一致性 |
|---|---|---|---|
| SSH 协议底层 | `mscdex/ssh2` 是 Node.js 事实标准（月下载 2930 万） | engine.ts 已用 ssh2 | ✅ |
| SFTP 文件 CRUD | `ssh2-sftp-client`（Promise API，首选） | engine.ts SFTP CRUD 已实现 | ✅ |
| 非交互命令执行 | webssh2 Exec Channel 模式 | engine.ts exec 已实现 | ✅ |
| 终端渲染 | xterm.js（VS Code/Hyper 同款） | 未来 ssh_terminal（PTY）工具可复用 | 💡 |
| 本地 PTY | `microsoft/node-pty` | 远程 PTY 由 ssh2 shell channel 提供 | 💡 |
| 连接管理器 | Tabby 数据模型（分组/搜索/跳板机） | store.ts 主机配置可借鉴扩展 | 💡 |
| 凭证安全 | Electron safeStorage / OS keychain | ~/.dsh/dsh-remote-ide.json（0600） | 💡 可加 |
| 安全审计 | JumpServer：会话录制 + 行为审计 + MFA | 可作远期能力参考 | 💡 |

**结论**：我们方案书的技术选型（ssh2 引擎）被另一个独立项目群的深度调研再次验证，风险极低。

### 2.3 开源复用纪律方法论 —— 可借鉴进 dsh-remote-ide 的开发规范

TDSF 的 `开源项目复用清单.md` 沉淀了一套成熟的开源复用纪律，我们可直接套用：

1. **4 级复用分级**：🟢 直接依赖（MIT/Apache-2.0/BSD）/ 🟡 借鉴架构（仅参考思路，代码自研，文件头标注 `Borrowed from`）/ ⚪ 待评估 / 🔴 红线（GPL/AGPL/SSPL 仅借鉴思想，禁止复制代码）。
2. **License 首行核实**：不凭 README/记忆推断，clone 后先读 LICENSE 文件首行。
3. **源码分析前置**：进入 🟢/🟡 前必须先产出源码分析报告。
4. **AGPL 传染铁律**：AGPL 网络传染（SaaS 部署也必须开源整个服务栈），参赛/商业项目一律禁止直接依赖。

**应用到 dsh-remote-ide**：ssh2 为 MIT（🟢 直接依赖 ✅ 已在用）；未来若参考 Tabby/WebSSH2/xterm.js 等架构（均为 MIT/Apache-2.0），走 🟡 借鉴架构并保留出处注释。

---

## 三、获得的灵感（四条，可演进为方案书后续能力）

### 3.1 风险分级 + 人工确认断点（TDSF 核心机制 → DSH 远程模式的安全增强）

TDSF 的核心机制：**中高风险操作必须经过人工确认，且确认时看到的证据链可核验、可核实**（LangGraph interrupt / human-in-the-loop）。这与 OpenHands 的 confirmation policy、grok-build 的 CapabilityMode 是同一安全共识。

**对 DSH 服务器开发模式的启示**：远程模式比本地更危险（操作的是真实生产/教学服务器）。建议方案书新增安全章节，分三档能力：

- 只读模式：`CapabilityMode` 四档（ReadOnly / ReadWrite / Execute / All），远程连接默认低档位；
- 高危命令确认：`rm -rf`、`fdisk`、`mkfs`、`systemctl restart` 等需 agent 侧确认；
- 操作留痕：每次 `ssh_exec` 记录「命令 + 输出摘要 + 时间戳」到会话日志，可追溯、可回放（对齐 JumpServer 会话录制思想）。

### 3.2 证据可核验（Ground-Check）→ 远程工具输出可追溯

TDSF 的 `ground_check()`：结论引用的证据必须**确实来自某一次真实工具调用输出**，而非 LLM 顺着上下文编造。对 DSH 远程模式的启示：`ssh_exec`/`ssh_read` 的输出应以结构化方式回传并留痕，agent 引用时可追溯出处——这本身就是 DSH 工具调用记录机制的自然延伸，无需新造，但可在 preset 的 system prompt 中强调「引用远程输出时必须基于真实工具结果」。

### 3.3 会话录制 + 回放（JumpServer / TDSF）→ 教学与审计场景

TDSF 调研中 JumpServer（企业级 PAM）的**会话录制 + 行为审计**能力，对应教学/管理场景价值高：可回放 agent 在远程服务器上的全部操作序列。DSH 的对话历史天然保留工具调用序列，未来可低成本实现「操作回放」。

### 3.4 命令片段库 + 教学差异化（Nexterm Snippets / Termius）

TDSF 调研的 Snippets 命令片段库（预设命令一键执行）+ 危险操作预警，是「服务器开发模式」面向教学（用户是深信息学生）的可选增强：远程连接后提供常用教学命令片段。**仅作远期候选，不影响 v0.1 核心闭环。**

---

## 四、对我们方案书的具体修订建议

| # | 建议 | 落点（docs/03 章节） | 来源 |
|---|---|---|---|
| 1 | 2.4 节补充 OpenHands RemoteSandboxService 细节论证「SSH 直连 vs 容器平台 API」差异化 | 二、可行性结论 | 2.1 |
| 2 | 新增「远程模式安全分级」章节（只读档 / 高危命令确认 / 操作留痕） | 三、技术方案之后 | 3.1 |
| 3 | 技术选型节补充「ssh2 生态经 TDSF 独立调研交叉验证」证据 | 三、技术方案 | 2.2 |
| 4 | 开发规范节引入开源复用纪律（4 级分级 + License 核实 + Borrowed from 注释） | 附录/开发规范 | 2.3 |
| 5 | 远期候选列：会话回放（3.3）、命令片段库（3.4）、PTY 终端工具复用 xterm.js 生态（2.2） | 「后续候选」 | 3.x |

---

## 五、结论

TDSF 项目群是**高价值的本地知识资产**，与 DSH 服务器开发模式存在三个直接交汇点：

1. **同构架构背书**：OpenHands 沙箱（SandboxService 抽象 + Remote 实现）源码级验证了「执行后端替换」路线的正确性，且反衬出 SSH 直连的差异化优势；
2. **选型交叉验证**：TDSF 的 SSH 生态深度调研与 dsh-remote-ide 已用技术栈逐项吻合，技术风险进一步降低；
3. **机制灵感**：风险分级人工确认、证据可核验、会话留痕/回放，可直接演进为远程模式的安全与审计能力。

**不需要从 TDSF 引入任何代码依赖**——它的价值在知识层（调研结论、机制设计、纪律方法论），而非代码层（TDSF 是 Python/Electron 教学运维栈，与 DSH 插件形态不同）。

---

**调研人**：DSH 开发组 · **日期**：2026-08-15
