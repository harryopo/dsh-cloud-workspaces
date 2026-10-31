# 升级到 DSH 0.2 + 插件 0.4.0（含回滚）

> 适用于把本机从 **DSH 0.1.1-rc.2 + 插件 0.3.0** 升到 **DSH 0.2.1-rc.5 + 插件 0.4.0**。
> 0.4.0 是 breaking：0.2 SDK 删除了 settings 命名空间并改了后台任务生产者 API。
> **升级会重启承载会话的 `dsh web`（默认 4500），正在跑的会话会中断** —— 挑空闲时做。

## 0. 升级前备份（1 分钟）

```powershell
# 关闭 dsh web 之前先复制这两个文件
Copy-Item "$HOME\.dsh\settings.yaml" "$HOME\.dsh\settings.yaml.bak-0.1"
Copy-Item "$HOME\.dsh\dsh-remote-ide.json" "$HOME\.dsh\dsh-remote-ide.json.bak-0.1"
Copy-Item "$HOME\.dsh\profiles\web\package.json" "$HOME\.dsh\profiles\web\package.json.bak-0.1"
```

确认当前版本：

```powershell
dsh --version                     # 期望 0.1.1-rc.2
npm ls -g @deepseek-ai/dsh --depth=0
```

## 1. 升级 DSH

```powershell
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version                     # 期望 0.2.1-rc.5
```

## 2. 停掉旧的 dsh web

在运行 4500 的那个终端按 `Ctrl+C`（或关闭该终端）。**会话历史不丢**，但正在执行的 turn 会中断。

## 3. 升级插件

```powershell
# 已发布版本
dsh plugin --profile web add dsh-cloud-workspaces@0.4.0

# 或者本地源码（开发机）：
# dsh plugin --profile web add "link:C:\Users\Administrator\dsh-remote-ide-dev"
```

## 4. 启动并验证

```powershell
dsh web --port 4500
```

逐项检查：

1. 设置页「SSH 连接」能看到旧主机（首次启动会把 `settings.yaml` 里的 `dsh-remote-ide-hosts` 段导入 0600 store）；
2. 「添加工作区」打开双栏工作台：左栏有 本机 / 最近 / 主机，右栏能浏览远端目录；
3. 选中某个远端目录 → 「使用此目录」→ 会话里 `bash` 落到服务器；
4. 诊断日志确认宿主半已加载：

```powershell
Get-Content "$HOME\.dsh\dsh-remote-ide-debug.log" -Tail 10
# 期望看到：
#   apply: dsh-cloud-workspaces host half starting
#   typert inject fired
#   typert registered; store hosts=N
```

5. 后台任务冒烟：在云端会话里跑一条 `run_in_background` 命令，再用 `job_output` 读输出。

## 5. 回滚（出问题 5 分钟内退回）

```powershell
npm install -g @deepseek-ai/dsh@0.1.1-rc.2
dsh plugin --profile web add dsh-cloud-workspaces@0.3.0
# 如 settings 被误改再恢复：
# Copy-Item "$HOME\.dsh\settings.yaml.bak-0.1" "$HOME\.dsh\settings.yaml" -Force
dsh web --port 4500
```

**回滚安全性**：0.4.0 的迁移只**读** `settings.yaml`、把主机写进 `dsh-remote-ide.json`，不删除旧段；0.3.0 仍从 settings 读主机，因此回滚后主机配置还在。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件加载失败 / 工具消失 | 宿主仍是 0.1.x | 先完成第 1 步；0.4.0 的 peer 要求 `^0.2.1-rc.5` |
| 打开选择器主机为空 | client codec 或 host 半未就绪 | 看浏览器 Console 有无 `typert mount failed`；看调试日志 |
| 设置页看不到主机 | store 为空且旧段不存在 | 确认 `~/.dsh/settings.yaml` 里还有 `dsh-remote-ide-hosts:`；或直接点「添加主机」 |
| 升级后会话列表在但打不开 | 旧会话绑定的占位工作区路径仍有效 | 占位目录在 `~/.dsh/remote/<hostId>/<b64>`，不要删；重新打开会话即可 |
