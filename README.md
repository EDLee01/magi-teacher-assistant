# Magi Teacher Assistant

[中文说明](README.zh-CN.md)

Magi Teacher Assistant is a desktop AI workspace for teachers. It keeps teaching resources, conversations, generated files, and reviewed project memory together instead of treating every chat as an isolated task.

Physics is the first MVP subject. The product architecture is designed to extend to other subjects without changing the Project/Session workflow.

> Status: early MVP for teacher testing. The current build has been developed and tested on macOS.

## Current capabilities

- Project and Session workspaces for long-running teaching work
- Project resources plus one-off chat attachments and folder import
- Automatic project Wiki generation from uploaded resources
- Exam analysis, lesson preparation, question design, and follow-up discussion
- Reviewed cross-session memory; new findings are not silently saved
- OpenAI-compatible model URL, API key, and model configuration
- Permission scopes for read-only and file-writing tasks
- In-app preview for Markdown, PDF, DOCX, HTML, images, and text files

## Run the desktop app

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/EDLee01/magi-teacher-assistant.git
cd magi-teacher-assistant
npm install
npm run teacher:desktop
```

Open Settings in the app and enter an OpenAI-compatible base URL, API key, and model name.

## Data boundary

The source code is public, but teaching materials are not part of this repository. Textbooks, exam papers, student records, model credentials, generated artifacts, and local databases stay in the user's private runtime directory and are covered by `.gitignore` rules.

The product supports two resource sources:

1. Teachers upload their own files or folders.
2. A deployment connects to a private teaching-resource API.

## Verification

```bash
npm run test:teacher-desktop
npm run test:teacher-skill
npx vitest run tests/physics-teacher.test.ts --maxWorkers=1
npm run scan:secrets
```

## Documentation

- [Desktop app](docs/physics-teacher-desktop.md)
- [Backend](docs/physics-teacher-backend.md)
- [Runtime profile](docs/physics-teacher-runtime-profile.md)
- [Teaching-resource API](docs/teaching-resource-api.md)

## Foundation

This project is built on the [Magi](https://github.com/EDLee01/magi) agent runtime. The repository keeps the runtime's model, tool, skill, memory, and execution capabilities while presenting a smaller teacher-facing product.

## License

MIT
