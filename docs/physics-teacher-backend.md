# Magi 教师助手后端

这是基于 Magi Runtime 的物理教师产品后端。界面可以采用“项目 + Session + 对话”的形式：一个项目对应一个长期教学环境，一次考试分析、一次备课或一次复测各自使用独立 Session，同一项目内共享教师确认过的长期记忆。

## 已实现的能力

| 模块                 | 用途                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| Project              | 保存年级、班级、教材版本和项目私有目录                                              |
| Session              | 保存一次考试分析、备课、练习调整或复测对话                                          |
| Project Memory       | 在同一项目的 Session 间保留已确认的学情和教学决定                                   |
| Memory Draft         | 新发现先生成草稿，由教师应用或拒绝，不静默写入长期记忆                              |
| Upload Source        | 教师直接上传试卷、成绩表、答题明细和教研文档                                        |
| Magi Wiki            | 导入后按教学用途分类，生成目录、分类页和可追溯的资料来源页                          |
| Remote API Source    | 检索团队维护的闭源教学资料服务，只保存密钥环境变量名                                |
| Magi Agent           | 使用项目记忆与检索到的资料继续对话，默认只读运行                                    |
| Teacher Tool Profile | 首轮加载 7 个工具（含只读 Skill），按需开放公开资料搜索、Python、文件编辑和安全 Git |

## 启动

面向教师使用时，直接启动桌面端：

```bash
npm install
npm run teacher:desktop
```

桌面端会自动启动本机后端、生成本次运行专用的访问 Token，并通过受限 IPC 调用接口。无需教师另开终端运行服务。桌面端使用方法见 [physics-teacher-desktop.md](./physics-teacher-desktop.md)。

需要单独调试或部署 HTTP 服务时，可先按 Magi 的方式在配置文件中设置模型 Provider，然后运行：

```bash
npm ci
npm run teacher:serve
```

默认监听 `http://127.0.0.1:8877`。默认数据目录为：

```text
~/.magi-next/physics-teacher/
├── state/physics-teacher.sqlite
└── projects/<project-id>/
    ├── AGENTS.md
    ├── workspace/
    │   └── wiki/
    │       ├── INDEX.md
    │       ├── curriculum-textbooks.md
    │       └── sources/<resource-id>.md
    ├── uploads/
    ├── artifacts/
    └── memory/
```

常用环境变量：

| 变量                                | 说明                                    |
| ----------------------------------- | --------------------------------------- |
| `MAGI_TEACHER_CONFIG_DIR`           | 修改教师助手的私有数据根目录            |
| `MAGI_TEACHER_BIND`                 | 监听地址，默认 `127.0.0.1`              |
| `MAGI_TEACHER_PORT`                 | 监听端口，默认 `8877`                   |
| `MAGI_TEACHER_API_TOKEN`            | HTTP Bearer Token；监听非本机地址时必填 |
| `MAGI_TEACHER_CORS_ORIGIN`          | 允许访问 API 的前端 Origin              |
| `MAGI_TEACHER_MAX_UPLOAD_BYTES`     | 单个上传文件大小上限，默认 64 MiB       |
| `MAGI_PDFTOTEXT_PATH`               | 可选，指定 PDF 正文抽取工具路径         |
| `MAGI_TEACHER_ALLOW_HTTP_RESOURCES` | 开发环境确需 HTTP 资料接口时设为 `1`    |

## 开源代码与闭源资料的边界

可以进入公开仓库的内容：

- Project、Session、Memory 和资料 Provider 的程序代码
- 数据库表结构、接口协议、测试使用的虚构样例
- 不包含真实资料和密钥的部署说明

不得进入公开仓库的内容：

- 教材原文、教辅、试卷原件及其批量解析结果
- 学生姓名、成绩、答题明细、教师账号等个人或校内数据
- 闭源资料库本体、索引文件、下载链接和 API 密钥
- 生产数据库、上传目录、日志和备份

本后端默认把以上内容放在仓库之外的私有运行目录，并将文件权限收紧为仅当前系统用户可读写。远程资料源的配置只记录 `apiKeyEnv`，例如 `SCHOOL_MATERIALS_API_KEY`；真实密钥由部署环境注入。

若部署为闭源产品，还应在网关层补充租户隔离、账号权限、操作审计、传输加密、备份策略以及符合学校要求的数据保留/删除机制。

## 安全默认值

- 服务默认只绑定本机；对外监听必须设置 API Token。
- 模型使用教师工具 Profile：可在 `workspace/` 编写分析脚本、在 `artifacts/` 输出结果，但不能修改上传原件和正式记忆。
- Session 中形成的新学情不会自动成为长期事实，必须经过 Memory Draft 审核。
- 上传文件会重命名后保存，阻止通过文件名跳出项目目录，并记录 SHA-256 校验值。
- API 返回上传资料元数据时不会暴露服务器上的实际存储路径。

具体 REST 协议见 [teaching-resource-api.md](./teaching-resource-api.md)。

教师运行时保留与关闭的工具见 [physics-teacher-runtime-profile.md](./physics-teacher-runtime-profile.md)。
