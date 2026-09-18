# 中文推广成稿（掘金 / V2EX 通用，按平台微调标题）

**发布清单**
- 掘金：分类「开发工具 / 人工智能」，标签 `DeepSeek`、`AI编程`、`SSH`、`效率工具`；封面用 `docs/screenshots/workspace-picker.png`
- V2EX：节点 `/go/programmer` 或 `/go/share`，标题短、正文口语化，代码块少用
- 少数派（可选）：改写为「我是如何让编码 Agent 直接在服务器上干活的」第一人称

**标题候选**
- 掘金：让 DeepSeek Harness 的编码 Agent 直接在远程 Linux 服务器上干活——零远端安装
- V2EX：写了个 DSH 插件，agent 的 bash/读写文件全部透明走 SSH 到服务器，不用装任何远端组件

---

## 正文

做 AI 编码工具的朋友应该都遇到过这个场景：代码和数据都在远程 Linux 服务器上，但 coding agent 只能在你本地机器跑——要么 SSH 开另一个终端人肉来回搬，要么用各种同步工具跟文件漂移搏斗。

现有的远程方案（比如各家 remote IDE）大多要在服务器上装一个几百 MB 的 server 组件，首次连接自动下载。我就想：SSH 本身已经有 exec / SFTP / PTY 三种通道，为什么不能让 agent 的工具**直接**走这些标准通道？

于是写了 `dsh-cloud-workspaces`——DeepSeek Harness (DSH) 的云端工作区插件。效果是：

1. 「添加工作区」里多一个「云端 (SSH)」tab，选主机、浏览远端目录、一键绑定
2. 之后这个会话里，agent 的 `bash` / `read` / `write` / `edit` / `glob` / `grep` **全部透明落在服务器上执行**，工具名、参数、UI 卡片跟本地一模一样
3. 长任务（apt/npm install、编译、测试套件）传 `run_in_background: true` 起成后台 job，`job_output` 轮询、完成自动通知
4. **服务器上什么都不用装**——标准 sshd 就行，密码认证连 PAM/keyboard-interactive 都处理了，还支持 ProxyJump 跳板链

技术上最有意思的是「透明」这件事：利用 DSH 的 `agent/created` 钩子，在会话作用域注册与官方同名的遮蔽工具，本地会话完全不受影响；后台任务直接复用官方 `ctx.jobs` 契约（注册表留在宿主内存，远程性下沉到执行层——每个 job 一条常驻 SSH 通道，close 事件就是权威退出码，零轮询）。

插件是纯官方 SDK 写的双面插件（Node host 半 + 浏览器 client 半），Apache-2.0，一条命令安装：

```sh
dsh plugin --profile web add dsh-cloud-workspaces
```

GitHub：https://github.com/harryopo/dsh-cloud-workspaces （如果觉得有点意思，欢迎点个 Star）
npm：https://www.npmjs.com/package/dsh-cloud-workspaces

欢迎提 issue / PR，尤其是各种奇奇怪怪的服务器环境（SELinux、堡垒机、老 OpenSSH）——这些都是真实场景。
