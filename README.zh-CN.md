# Magi 教师助手

[English](README.md)

Magi 教师助手是一款面向教师的桌面 AI 工作台。它把教学资料、对话、生成文件和经过教师确认的项目记忆放在同一个工作环境中，不必每次对话都从头开始。

物理是首个 MVP 学科，后续可以沿用同一套 Project / Session 工作方式扩展到其他学科。

> 当前状态：供教师业务测试的早期 MVP，目前主要在 macOS 上开发和验证。

## 当前能力

- 用 Project 管理长期教学工作，用 Session 区分考试分析、备课、出题和复测
- 支持项目基础资料、单次对话附件和文件夹导入
- 上传资料后自动整理项目 Wiki
- 支持考试分析、教师备课、出题和连续追问
- 跨 Session 项目记忆，新结论经教师确认后再保存
- 配置兼容 OpenAI 协议的 URL、API Key 和模型名称
- 区分只读、项目内读写等权限范围
- 在应用内预览 Markdown、PDF、DOCX、HTML、图片和文本文件

## 启动桌面端

需要 Node.js 22 或更高版本。

```bash
git clone https://github.com/EDLee01/magi-teacher-assistant.git
cd magi-teacher-assistant
npm install
npm run teacher:desktop
```

启动后在“设置”中填写兼容 OpenAI 协议的模型 URL、API Key 和模型名称。

## 数据边界

仓库只公开程序代码，不包含教学资料。教材、试卷、学生成绩、模型密钥、生成文件和本地数据库都保存在用户的私有运行目录中，并由 `.gitignore` 规则排除。

资料可以来自两种渠道：

1. 教师上传自己的文件或文件夹。
2. 部署方接入闭源教学资料 API。

## 验证

```bash
npm run test:teacher-desktop
npm run test:teacher-skill
npx vitest run tests/physics-teacher.test.ts --maxWorkers=1
npm run scan:secrets
```

## 相关文档

- [桌面端](docs/physics-teacher-desktop.md)
- [后端](docs/physics-teacher-backend.md)
- [Runtime 瘦身方案](docs/physics-teacher-runtime-profile.md)
- [教学资料接口](docs/teaching-resource-api.md)

## 技术基础

项目基于 [Magi](https://github.com/EDLee01/magi) Agent Runtime 开发，保留模型、工具、Skill、记忆与执行能力，对教师呈现更轻量的产品界面。

## License

MIT
