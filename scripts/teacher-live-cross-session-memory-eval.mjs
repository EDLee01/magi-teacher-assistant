import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, safeStorage } from "electron";

import { ensureMagiHome, getMagiPaths } from "../dist/paths.js";
import {
  PHYSICS_TEACHER_MODEL_ALIAS,
  PHYSICS_TEACHER_OPENAI_KEY_ENV,
  readPhysicsTeacherModelSettings,
  writePhysicsTeacherModelSettings
} from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-cross-session-memory-eval.json"
);
const timeoutMs = Number(process.env.MAGI_TEACHER_MEMORY_EVAL_TIMEOUT_MS) || 240_000;
const stableEvidence = [
  "S01连续三次在滑动摩擦力任务中出现相同问题：第一次漏写研究对象，第二次漏画摩擦力方向，第三次没有写出匀速状态下的平衡关系。",
  "教师已经逐次核对原卷与订正记录；下周近期目标确定为“三步受力链：研究对象→受力→平衡关系”。",
  "S02只在一次牛奶密度迁移题中把分子分母写反，随后短复测2/2；这条单次错误不足以形成长期能力判断。"
].join("\n");
const stablePrompt = [
  "请根据项目资料判断哪些学情证据适合跨 Session 使用。",
  "只把 S01 有连续证据支持的结论，以 project 类别创建一条待教师确认的项目记忆草稿；草稿要保留匿名编号、三次证据和近期教学目标。",
  "不要直接写入正式记忆，也不要只在聊天里贴一段所谓草稿：必须使用受控的 MemoryDraft 工具。",
  "S02 的单次错误不要写入任何草稿。完成后只告诉我已生成几条待确认草稿以及需要去哪里确认。"
].join("\n");
const unstablePrompt = [
  "再看 S02：她只有一次密度表达式写反，随后短复测2/2。",
  "我想把她记成“物理基础薄弱”，请按项目记忆规则判断；如果证据不够，就明确拒绝创建新的记忆草稿。"
].join("\n");
const recallPrompt = [
  "这是一个全新的 Session。只根据本项目已经由教师确认的正式长期记忆回答：",
  "S01 下一阶段最需要关注的一个教学重点是什么？请同时说明这个判断来自怎样的连续证据。",
  "不要搜索旧 Session，也不要把待确认或已拒绝的草稿当作事实。"
].join("\n");
const isolatedProjectPrompt = [
  "只根据这个项目已经确认的正式长期记忆回答：S01 下一阶段最需要关注什么？",
  "如果本项目没有相关正式记忆，就直接说明没有，不能调用其他项目或旧 Session。"
].join("\n");

async function runLiveCrossSessionMemoryEval() {
  let runtime;
  let isolatedRoot;
  const startedAt = new Date().toISOString();
  const partial = {};
  try {
    const realPaths = getMagiPaths(process.env);
    const providerEnv = await readPrivateProviderEnv(path.join(realPaths.root, "provider.env"));
    const realRuntimeEnv = { ...providerEnv, ...process.env, MAGI_SQLITE_DRIVER: "builtin" };
    const settings = readPhysicsTeacherModelSettings(realPaths, realRuntimeEnv);
    if (!settings) throw new Error("桌面端尚未保存可用的 OpenAI 兼容模型设置");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
    const encryptedKey = await readFile(path.join(realPaths.root, "desktop", "openai-api-key.enc"));
    const apiKey = safeStorage.decryptString(encryptedKey).trim();
    if (!apiKey) throw new Error("已保存的模型密钥为空");

    isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "magi-teacher-memory-live-"));
    const runtimeEnv = {
      ...realRuntimeEnv,
      MAGI_CONFIG_DIR: isolatedRoot,
      MAGI_TEACHER_CONFIG_DIR: path.join(isolatedRoot, "physics-teacher"),
      [PHYSICS_TEACHER_OPENAI_KEY_ENV]: apiKey
    };
    const isolatedPaths = getMagiPaths(runtimeEnv);
    ensureMagiHome(isolatedPaths);
    writePhysicsTeacherModelSettings({
      paths: isolatedPaths,
      baseUrl: settings.baseUrl,
      model: settings.model,
      env: runtimeEnv
    });

    process.env.MAGI_SQLITE_DRIVER = "builtin";
    runtime = createPhysicsTeacherRuntime(runtimeEnv);
    const service = runtime.service;
    const project = service.createProject({
      name: "跨Session记忆业务测试",
      grade: "九年级",
      className: "匿名测试班"
    });
    service.uploadResource({
      projectId: project.id,
      filename: "匿名连续学情证据.txt",
      body: Buffer.from(stableEvidence, "utf8"),
      mimeType: "text/plain",
      kind: "student-learning"
    });

    const evidenceSession = service.createSession({
      projectId: project.id,
      title: "连续证据确认",
      kind: "exam-analysis"
    });
    stage("真实模型创建待确认草稿");
    const stableResult = await sendWithTimeout(service, {
      sessionId: evidenceSession.sessionId,
      prompt: stablePrompt,
      resourceQuery: "S01 S02 连续三次 摩擦力 三步受力链",
      modelAlias: PHYSICS_TEACHER_MODEL_ALIAS,
      permissionScope: "project-write"
    });
    partial.stableMessage = stableResult.message;
    const draftsAfterStable = service.listMemoryDrafts(project.id);
    const pending = draftsAfterStable.filter((draft) => draft.status === "pending");
    const formalBeforeApply = service.readMemory(project.id, "projects/context.md");
    assert.equal(pending.length, 1, `稳定证据应产生1条待确认草稿，实际${pending.length}条`);
    const stableDraft = pending[0];
    assert.equal(stableDraft.targetFile, "projects/context.md", "稳定学情没有进入项目类草稿");
    assert.equal(stableDraft.sourceSession, evidenceSession.sessionId, "草稿没有保留来源Session");
    assert.match(stableDraft.content, /S01/, "草稿缺少匿名编号S01");
    assert.match(stableDraft.content, /连续|三次/, "草稿缺少连续证据边界");
    assert.match(stableDraft.content, /滑动摩擦力|三步受力链|平衡关系/, "草稿缺少教学重点");
    assert.doesNotMatch(
      stableDraft.content,
      /姓名|电话|学困生|差生|基础薄弱/,
      "草稿包含不必要个人信息或固定标签"
    );
    assert.doesNotMatch(formalBeforeApply, /三步受力链/, "教师确认前已污染正式记忆");
    assert.match(stableResult.message, /待确认|确认|项目资料/, "聊天没有说明教师确认边界");

    stage("模拟教师在项目记忆面板确认草稿");
    const applied = service.applyMemoryDraft(project.id, stableDraft.id);
    assert.equal(applied.status, "applied");
    const formalAfterApply = service.readMemory(project.id, "projects/context.md");
    assert.match(formalAfterApply, /三步受力链/, "教师确认后正式记忆没有写入");

    stage("真实模型拒绝把单次错误升级为长期标签");
    const countBeforeUnstable = service.listMemoryDrafts(project.id).length;
    const unstableResult = await sendWithTimeout(service, {
      sessionId: evidenceSession.sessionId,
      prompt: unstablePrompt,
      resourceQuery: "S02 密度表达式 短复测",
      modelAlias: PHYSICS_TEACHER_MODEL_ALIAS,
      permissionScope: "project-write"
    });
    partial.unstableMessage = unstableResult.message;
    assert.equal(
      service.listMemoryDrafts(project.id).length,
      countBeforeUnstable,
      "单次错误仍创建了新的长期记忆草稿"
    );
    assert.match(
      unstableResult.message,
      /证据不足|单次|一次|不创建|不写入|不能形成|不应形成/,
      "没有向教师说明单次错误不能形成长期结论"
    );

    const rejected = service.proposeMemory({
      projectId: project.id,
      category: "project",
      content: "S03已稳定使用紫色标记法完成受力分析。",
      reason: "用于验证被拒绝草稿不会被召回",
      sourceSession: evidenceSession.sessionId,
      confidence: 0.5
    });
    service.rejectMemoryDraft(project.id, rejected.id);

    stage("在全新Session召回教师已确认记忆");
    const recallSession = service.createSession({
      projectId: project.id,
      title: "新Session备课",
      kind: "lesson-planning"
    });
    const recallResult = await sendWithTimeout(service, {
      sessionId: recallSession.sessionId,
      prompt: recallPrompt,
      modelAlias: PHYSICS_TEACHER_MODEL_ALIAS,
      permissionScope: "read-only"
    });
    partial.recallMessage = recallResult.message;
    assert.match(recallResult.message, /S01/, "新Session没有召回匿名对象S01");
    assert.match(recallResult.message, /三步受力链/, "新Session没有召回已确认教学重点");
    assert.match(recallResult.message, /连续|三次/, "新Session丢失了证据边界");
    assert.doesNotMatch(recallResult.message, /紫色标记法/, "已拒绝草稿污染了新Session");
    assert.doesNotMatch(recallResult.message, /物理基础薄弱/, "单次错误标签污染了新Session");

    stage("验证项目之间不共享学生学情记忆");
    const otherProject = service.createProject({
      name: "项目隔离业务测试",
      grade: "九年级",
      className: "另一匿名班"
    });
    const otherSession = service.createSession({
      projectId: otherProject.id,
      title: "项目隔离检查",
      kind: "lesson-planning"
    });
    const isolatedResult = await sendWithTimeout(service, {
      sessionId: otherSession.sessionId,
      prompt: isolatedProjectPrompt,
      modelAlias: PHYSICS_TEACHER_MODEL_ALIAS,
      permissionScope: "read-only"
    });
    partial.isolatedMessage = isolatedResult.message;
    assert.doesNotMatch(isolatedResult.message, /三步受力链/, "项目记忆泄漏到另一个项目");
    assert.match(
      isolatedResult.message,
      /没有|无相关|未找到|缺少/,
      "另一个项目没有明确说明记忆缺失"
    );

    const assertions = evaluateCrossSessionMemoryResult({
      stableMessage: stableResult.message,
      unstableMessage: unstableResult.message,
      recallMessage: recallResult.message,
      isolatedMessage: isolatedResult.message,
      stableDraft: {
        status: stableDraft.status,
        targetFile: stableDraft.targetFile,
        content: stableDraft.content,
        sourceSessionMatches: stableDraft.sourceSession === evidenceSession.sessionId
      },
      formalBeforeApply,
      formalAfterApply,
      draftCountBeforeUnstable: countBeforeUnstable,
      draftCountAfterUnstable: service
        .listMemoryDrafts(project.id)
        .filter((draft) => draft.id !== rejected.id).length
    });
    const report = {
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      model: settings.model,
      storage: "isolated temporary Magi root (deleted after test)",
      project: project.name,
      stableMessage: stableResult.message,
      unstableMessage: unstableResult.message,
      recallMessage: recallResult.message,
      isolatedMessage: isolatedResult.message,
      stableDraft: {
        status: stableDraft.status,
        targetFile: stableDraft.targetFile,
        content: stableDraft.content,
        sourceSessionMatches: stableDraft.sourceSession === evidenceSession.sessionId
      },
      assertions
    };
    await writeReport(report);
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  } catch (error) {
    await writeReport({
      status: "failed",
      startedAt,
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack || error.message : String(error),
      ...partial
    });
    process.stderr.write(
      `[跨Session记忆业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    runtime?.close();
    if (isolatedRoot) await rm(isolatedRoot, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}

export function evaluateCrossSessionMemoryResult({
  stableMessage,
  unstableMessage,
  recallMessage,
  isolatedMessage,
  stableDraft,
  formalBeforeApply,
  formalAfterApply,
  draftCountBeforeUnstable,
  draftCountAfterUnstable
}) {
  assert.equal(stableDraft.status, "pending", "稳定结论没有先停留在待确认状态");
  assert.equal(stableDraft.targetFile, "projects/context.md", "草稿没有进入项目记忆范围");
  assert.equal(stableDraft.sourceSessionMatches, true, "草稿没有保留来源Session");
  assert.match(stableDraft.content, /S01/);
  assert.match(stableDraft.content, /连续|三次/);
  assert.doesNotMatch(stableDraft.content, /姓名|电话|学困生|差生|基础薄弱/);
  assert.doesNotMatch(formalBeforeApply, /三步受力链/);
  assert.match(formalAfterApply, /三步受力链/);
  assert.equal(draftCountAfterUnstable, draftCountBeforeUnstable);
  assert.match(stableMessage, /待确认|确认|项目资料/);
  assert.match(unstableMessage, /证据不足|单次|一次|不创建|不写入|不能形成|不应形成/);
  assert.match(recallMessage, /S01/);
  assert.match(recallMessage, /三步受力链/);
  assert.match(recallMessage, /连续|三次/);
  assert.doesNotMatch(recallMessage, /紫色标记法|物理基础薄弱/);
  assert.doesNotMatch(isolatedMessage, /三步受力链/);
  return [
    "稳定学情只创建待确认项目记忆草稿",
    "教师确认前正式记忆保持不变",
    "教师确认后新Session召回教学重点与证据边界",
    "单次错误没有升级为固定能力标签或长期记忆",
    "已拒绝草稿不会污染新Session",
    "不同项目之间不共享学生学情记忆"
  ];
}

async function sendWithTimeout(service, input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("跨Session记忆业务测试超时"), timeoutMs);
  timer.unref?.();
  try {
    return await service.sendMessage({ ...input, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function writeReport(report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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

function stage(message) {
  process.stdout.write(`[跨Session记忆业务测试] ${message}\n`);
}

if (process.env.MAGI_TEACHER_MEMORY_ASSERTIONS_ONLY !== "1") {
  await runLiveCrossSessionMemoryEval();
}
