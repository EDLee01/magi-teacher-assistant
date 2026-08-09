# Magi 物理教师运行时瘦身方案

教师版不删除 Magi 的通用工具源码，而是使用独立的 `PhysicsTeacherToolProfile` 控制每次对话真正可见和可执行的能力。首轮保留只读 `Skill`，使模型能根据教师的自然语言任务加载物理教学流程；同时保留 Python、文件处理、公开资料搜索和 Git，避免把完整 Coding Agent 的工具面暴露给教师项目。

## 工具分层

首轮固定加载 7 个工具：

- `ToolSearch`
- `WebSearch`
- `WebFetch`
- `FileRead`
- `Skill`
- `Brief`
- `AskUserQuestion`

需要时可通过 `ToolSearch` 加载：

- 网页：`WebBrowser`
- 文件检索：`Glob`、`Grep`
- 文件修改：`FileWrite`、`FileEdit`、`FilePatch`
- Notebook：`NotebookRead`、`NotebookEdit`
- 分析执行：`Bash`
- Git：`GitSummary`、`GitStatus`、`GitDiff`、`GitLog`、`GitShow`、`GitBranchList`、`GitStage`
- Session 检索与消息：`SessionSearch`、`SendUserMessage`

教师运行时只开放教学任务需要的工具，但模型每轮只看到已经加载的少量工具定义。

## 权限范围

- `项目内读写`：默认模式。`workspace/` 和 `artifacts/` 内的文件写入直接执行；上传原件、正式记忆和项目外路径仍拒绝。
- `只读`：只保留检索、读取和只读命令，不开放文件修改。
- `操作前询问`：文件写入、编辑、命令执行和 Git 暂存进入桌面审批弹窗；教师只能批准当前一次或拒绝。

相对路径、`./artifacts/` 和当前项目内的绝对 `artifacts/`、`workspace/` 路径会归一到同一权限范围，避免模型因为路径写法不同误判为只读。

## 目录边界

```text
project/
├── uploads/                       原始资料，只读使用
├── memory/                        审核后的项目记忆，不由文件工具修改
├── artifacts/                     分析结果、图表和教师下载文件
└── workspace/
    ├── analysis-scripts/          Python 分析脚本
    ├── mappings/                  Excel/CSV 字段映射
    └── templates/                 教案和练习模板
```

文件写入工具只允许操作 `workspace/` 和 `artifacts/`。`uploads/`、`memory/` 和 `artifacts/` 默认加入项目 Git 忽略规则，Git 主要管理分析脚本、字段映射和模板。

## Python 与 Shell

允许的自动执行命令：

- `python3 workspace/analysis-scripts/<script>.py ...`
- `python workspace/analysis-scripts/<script>.py ...`
- `pwd`、`ls`、`cat`、`head`、`tail`、`wc` 和只读 `sed`
- 只读 `git status`、`git diff`、`git log`、`git show`

默认拒绝：

- Shell 串联、管道、重定向和命令替换
- `rm`、`sudo`、`curl`、`wget`、`ssh`、`scp`
- `pip install`
- `git push`、`git reset`、`git clean`、`git checkout`
- 路径穿越和绝对路径参数

默认运行上限为 60 秒，可通过 `MAGI_TEACHER_BASH_TIMEOUT_MS` 调整，最大 5 分钟。

当前实现提供的是应用层命令和路径控制。正式处理真实学生数据时，Python 还应运行在独立容器或低权限系统账号中，将 `uploads/` 以只读方式挂载、将 `artifacts/` 作为唯一可写目录，并默认关闭容器网络。这是部署层必须完成的第二道边界。

## 关闭的能力

教师版不向模型开放以下工具：

- 文件删除
- Git 分支创建、切换、删除、reset 和 stash
- SSH、SCP 和多机执行
- Worktree
- GitHub 写操作
- Cron 创建与删除
- 进程终止
- Magi 配置修改和 Skill 安装

以后出现明确教学场景时，可以逐项加入 Profile，不需要恢复整套工具面。
