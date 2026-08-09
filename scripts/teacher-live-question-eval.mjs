import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, safeStorage } from "electron";

import { PHYSICS_TEACHER_OPENAI_KEY_ENV } from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";

const prompt =
  process.env.MAGI_TEACHER_QUESTION_EVAL_PROMPT?.trim() ||
  "参考项目里的广州中考题库，按广州中考风格出10道初中物理题：5道单项选择题、2道填空题、3道大题。附完整答案和解析，题目不要依赖未提供的图片。";
const modelAlias = process.env.MAGI_TEACHER_QUESTION_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";

let runtime;
try {
  const magiRoot = process.env.MAGI_CONFIG_DIR
    ? path.resolve(process.env.MAGI_CONFIG_DIR)
    : path.join(os.homedir(), ".magi-next");

  reportStage("加载 Magi 教学项目");
  const runtimeEnv = {
    ...(await readPrivateProviderEnv(path.join(magiRoot, "provider.env"))),
    ...process.env,
    MAGI_SQLITE_DRIVER: "builtin"
  };
  if (modelAlias === "physics-teacher") {
    reportStage("解锁桌面端模型密钥");
    await app.whenReady();
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
    const encryptedKey = await readFile(path.join(magiRoot, "desktop", "openai-api-key.enc"));
    const apiKey = safeStorage.decryptString(encryptedKey).trim();
    if (!apiKey) throw new Error("已保存的模型密钥为空");
    runtimeEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV] = apiKey;
  }
  process.env.MAGI_SQLITE_DRIVER = "builtin";
  runtime = createPhysicsTeacherRuntime(runtimeEnv);
  reportStage("教学运行时已就绪");
  const candidates = runtime.service
    .listProjects()
    .map((project) => ({
      project,
      resourceCount: runtime.service.listResources(project.id).length
    }))
    .sort((left, right) => right.resourceCount - left.resourceCount);
  const selected = candidates[0];
  if (!selected || selected.resourceCount === 0) {
    throw new Error("没有包含题库资料的教学项目可用于测试");
  }

  reportStage(`选择包含 ${selected.resourceCount} 份资料的项目`);
  const session = runtime.service.createSession({
    projectId: selected.project.id,
    title: `出题质量测试 · ${new Date().toLocaleString("zh-CN")}`,
    kind: "practice-adjustment"
  });
  reportStage(`调用模型 ${modelAlias}`);
  const result = await runtime.service.sendMessage({
    sessionId: session.sessionId,
    prompt,
    modelAlias,
    resourceQuery: "广州中考物理 真题 2023 2024 2025 题目 解析 年报",
    permissionScope: "read-only"
  });

  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 200, "模型返回的试卷内容过短");
  process.stdout.write(
    `${JSON.stringify(
      {
        project: selected.project.name,
        resourceCount: selected.resourceCount,
        modelAlias,
        sessionId: session.sessionId,
        message: result.message
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  process.stderr.write(
    `[出题测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
  app.exit(process.exitCode || 0);
}

async function readPrivateProviderEnv(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || match[2] === "") continue;
    const rawValue = match[2];
    result[match[1]] =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
  }
  return result;
}

function reportStage(message) {
  process.stderr.write(`[出题测试] ${message}\n`);
}
