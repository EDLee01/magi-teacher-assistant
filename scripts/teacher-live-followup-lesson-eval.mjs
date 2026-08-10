import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { app, safeStorage } from "electron";

import {
  listArtifactFiles,
  loadFilePreview,
  resolveArtifactFile
} from "../desktop/artifact-preview.mjs";
import { PHYSICS_TEACHER_OPENAI_KEY_ENV } from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";
import { SessionStore } from "../dist/session-store.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-followup-lesson-eval.json"
);
const modelAlias = process.env.MAGI_TEACHER_LESSON_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";
const timeoutMs = Number(process.env.MAGI_TEACHER_LESSON_EVAL_TIMEOUT_MS) || 300_000;
const artifactStem = `业务测试-摩擦力浮力讲评课-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")}`;
const prompt = [
  "继续上一轮考试分析，请为初二1班准备一节45分钟的物理讲评课，只处理已经确认薄弱的滑动摩擦力及受力分析、浮力大小与排开液体体积。",
  "Q3得分率50%、Q4得分率58%是数据事实；错误原因仍是待课堂核实的教学解释，不能写成已经确认的学生错误观念。",
  "课堂流程安排5至8个环节，每个环节必须分别写清“用时：X分钟”、教师做什么、学生做什么、所需材料和学习证据；所有环节用时合计必须正好45分钟。",
  "至少包含一次先暴露学生原有想法的任务、一项能区分会套公式与理解物理过程的当堂检测、板书设计、检测答案或判断标准、分层作业和复测安排。",
  "请核对项目中的课标、教材或教研资料。备课依据至少列出两份实际使用的来源文件名和资料ID；找不到精确依据时明确边界，不得虚构课标条目或教材页码。",
  `完整教案写入 artifacts/${artifactStem}.docx 和 artifacts/${artifactStem}.pdf，两份内容一致。`,
  "聊天中只简要说明课题、45分钟和两个文件名，不要粘贴完整教案。"
].join("\n");
const seedExamPrompt = "请分析这次匿名逐题成绩，严格找出低于60%的题目，并给出下一节讲评课方向。";
const seedExamAnswer = [
  "数据事实：Q3（滑动摩擦力及受力分析）得分率50%，Q4（浮力大小与排开液体体积）得分率58%；Q2恰好60%，不列入低于60%的题目。",
  "教学解释：Q3可能需要核实摩擦力方向判断，Q4可能需要核实阿基米德原理和排开液体体积变化；这些错因必须通过学生作答或课堂任务继续确认。",
  "下一步可以在同一Session中继续准备一节讲评课。"
].join("\n");

let runtime;
let resultMessage = "";
const startedAt = new Date().toISOString();

try {
  const magiRoot = process.env.MAGI_CONFIG_DIR
    ? path.resolve(process.env.MAGI_CONFIG_DIR)
    : path.join(os.homedir(), ".magi-next");
  const runtimeEnv = {
    ...(await readPrivateProviderEnv(path.join(magiRoot, "provider.env"))),
    ...process.env,
    MAGI_SQLITE_DRIVER: "builtin"
  };

  if (modelAlias === "physics-teacher") {
    reportStage("解锁桌面端已保存的模型密钥");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
    const encryptedKey = await readFile(path.join(magiRoot, "desktop", "openai-api-key.enc"));
    const apiKey = safeStorage.decryptString(encryptedKey).trim();
    if (!apiKey) throw new Error("已保存的模型密钥为空");
    runtimeEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV] = apiKey;
  }

  process.env.MAGI_SQLITE_DRIVER = "builtin";
  runtime = createPhysicsTeacherRuntime(runtimeEnv);
  const selected = runtime.service
    .listProjects()
    .map((project) => ({
      project,
      resourceCount: runtime.service.listResources(project.id).length
    }))
    .sort((left, right) => right.resourceCount - left.resourceCount)[0];
  if (!selected || selected.resourceCount === 0) {
    throw new Error("没有包含教学资料的项目可用于追问备课测试");
  }

  const lessonSession = runtime.service.createSession({
    projectId: selected.project.id,
    title: `追问备课业务测试 · ${new Date().toLocaleString("zh-CN")}`,
    kind: "lesson-planning"
  });
  const seedStore = SessionStore.open(runtime.magiPaths);
  try {
    seedStore.appendMessage({
      sessionId: lessonSession.sessionId,
      role: "user",
      content: seedExamPrompt,
      metadata: { source: "teacher-live-followup-lesson-seed" }
    });
    seedStore.appendMessage({
      sessionId: lessonSession.sessionId,
      role: "assistant",
      content: seedExamAnswer,
      metadata: { source: "teacher-live-followup-lesson-seed" }
    });
  } finally {
    seedStore.close();
  }

  const projectPaths = runtime.service.projectPathsForExisting(selected.project.id);
  const artifactsBefore = new Map(
    (await listArtifactFiles(projectPaths.artifacts)).map((file) => [
      file.relativePath,
      `${file.sizeBytes}:${file.updatedAt}`
    ])
  );

  reportStage(
    `继续项目“${selected.project.name}”的 Session“${lessonSession.title}”，教学资料 ${selected.resourceCount} 份`
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("追问备课业务测试超时"), timeoutMs);
  timer.unref?.();
  try {
    const result = await runtime.service.sendMessage({
      sessionId: lessonSession.sessionId,
      prompt,
      modelAlias,
      resourceQuery:
        "2022课程标准 人教版教材 滑动摩擦力 浮力 阿基米德原理 受力分析 课堂教学 讲评课",
      permissionScope: "project-write",
      signal: controller.signal
    });
    resultMessage = result.message;
  } finally {
    clearTimeout(timer);
  }

  const artifactsAfter = await listArtifactFiles(projectPaths.artifacts);
  const changedArtifacts = artifactsAfter.filter(
    (file) => artifactsBefore.get(file.relativePath) !== `${file.sizeBytes}:${file.updatedAt}`
  );
  const docx = changedArtifacts.find(
    (file) => file.name === `${artifactStem}.docx` && file.extension === ".docx"
  );
  const pdf = changedArtifacts.find(
    (file) => file.name === `${artifactStem}.pdf` && file.extension === ".pdf"
  );
  assert.ok(docx, `没有生成指定的 DOCX：${artifactStem}.docx`);
  assert.ok(pdf, `没有生成指定的 PDF：${artifactStem}.pdf`);

  const docxPath = await resolveArtifactFile(projectPaths.artifacts, docx.relativePath);
  const pdfPath = await resolveArtifactFile(projectPaths.artifacts, pdf.relativePath);
  const docxPreview = await loadFilePreview(docxPath, docx.name);
  const pdfPreview = await loadFilePreview(pdfPath, pdf.name);
  assert.equal(docxPreview.kind, "html", "DOCX 没有通过桌面端内嵌预览转换");
  assert.equal(pdfPreview.kind, "pdf", "PDF 没有通过桌面端内嵌预览加载");
  const docxText = await extractDocxText(docxPath);
  const pdfText = await extractPdfText(pdfPath);
  assert.equal((await readFile(pdfPath)).subarray(0, 5).toString("ascii"), "%PDF-");
  assert.match(pdfText, /摩擦/, "PDF 中没有可读取的中文“摩擦”");
  assert.match(pdfText, /浮/, "PDF 中没有可读取的中文“浮力”");

  const assertions = evaluateLessonResult({
    message: resultMessage,
    docxText,
    artifactStem
  });
  await writeReport({
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    project: selected.project.name,
    sessionId: lessonSession.sessionId,
    resourceCount: selected.resourceCount,
    modelAlias,
    artifacts: changedArtifacts,
    assertions,
    message: resultMessage
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        project: selected.project.name,
        session: lessonSession.title,
        resourceCount: selected.resourceCount,
        modelAlias,
        artifacts: changedArtifacts.map((file) => file.relativePath),
        assertions,
        reportPath
      },
      null,
      2
    )}\n`
  );
} catch (error) {
  await writeReport({
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    modelAlias,
    artifactStem,
    error: error instanceof Error ? error.stack || error.message : String(error),
    message: resultMessage
  });
  process.stderr.write(
    `[追问备课业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
  app.exit(process.exitCode || 0);
}

function evaluateLessonResult({ message, docxText, artifactStem: expectedStem }) {
  assert.match(message, new RegExp(escapeRegExp(`${expectedStem}.docx`)), "聊天中缺少DOCX文件名");
  assert.match(message, new RegExp(escapeRegExp(`${expectedStem}.pdf`)), "聊天中缺少PDF文件名");
  assert.match(message, /45\s*分钟/, "聊天中没有确认45分钟");
  assert.ok(message.length < 1_200, "聊天回复过长，疑似粘贴了完整教案");

  assert.match(docxText, /讲评课|课时方案|教案/, "教案缺少明确标题");
  assert.match(docxText, /Q3[^\n]{0,80}50\s*%|50\s*%[^\n]{0,80}Q3/i, "教案未引用Q3数据");
  assert.match(docxText, /Q4[^\n]{0,80}58\s*%|58\s*%[^\n]{0,80}Q4/i, "教案未引用Q4数据");
  assert.match(docxText, /数据事实|分析边界/, "教案没有区分数据事实或分析边界");
  assert.match(docxText, /待核实|仍需核实|课堂核实|可能/, "教案把错因写成了已确认事实");
  assert.match(docxText, /学习目标|教学目标|可观察目标|本课目标/, "教案缺少学习目标");
  assert.match(docxText, /教师(?:做什么|活动|行为)/, "课堂流程缺少教师活动");
  assert.match(docxText, /学生(?:做什么|活动|任务)/, "课堂流程缺少学生活动");
  assert.match(docxText, /学习证据|判断.*学会|评价证据/, "课堂流程缺少学习证据");
  assert.match(docxText, /暴露.*(?:想法|判断)|原有想法|先判断/, "缺少暴露原有想法的任务");
  assert.match(docxText, /套公式|物理过程/, "当堂检测没有区分套公式与过程理解");
  assert.match(docxText, /板书/, "教案缺少板书设计");
  assert.match(docxText, /当堂检测|退出条|出门条/, "教案缺少当堂检测");
  assert.match(docxText, /答案|判断标准|评分标准/, "当堂检测缺少答案或判断标准");
  assert.match(docxText, /分层作业|基础巩固|针对纠错/, "教案缺少分层作业");
  assert.match(docxText, /复测/, "教案缺少复测安排");
  assert.match(docxText, /仍需教师确认|教师确认/, "教案缺少教师确认项");
  assert.match(docxText, /资料\s*ID|资料ID/, "备课依据缺少资料ID");
  const sourceIds = new Set(docxText.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi) ?? []);
  assert.ok(sourceIds.size >= 2, "备课依据少于两份可核对资料");

  const durations = [...docxText.matchAll(/用时[：:]\s*(\d{1,2})\s*分钟/g)].map((match) =>
    Number(match[1])
  );
  assert.ok(durations.length >= 5 && durations.length <= 8, "课堂流程应有5至8个带用时的环节");
  assert.equal(
    durations.reduce((total, value) => total + value, 0),
    45,
    `课堂环节用时合计不是45分钟：${durations.join("+")}`
  );

  return [
    "延续同一Session的Q3/Q4学情",
    "课堂流程5至8环节且用时合计45分钟",
    "每环节包含教师、学生、材料和学习证据",
    "错因保持待核实而非过度断言",
    "包含想法暴露、过程理解检测、板书、作业与复测",
    "引用至少两份带资料ID的项目依据",
    "生成可预览DOCX与中文可读PDF",
    "聊天只返回摘要和文件名"
  ];
}

async function extractDocxText(filePath) {
  const { stdout } = await execFileAsync(
    "/usr/bin/textutil",
    ["-convert", "txt", "-stdout", filePath],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }
  );
  return stdout;
}

async function extractPdfText(filePath) {
  const commands = [
    process.env.MAGI_PDFTOTEXT_PATH,
    "pdftotext",
    "/opt/homebrew/bin/pdftotext",
    "/usr/local/bin/pdftotext"
  ].filter(Boolean);
  for (const command of new Set(commands)) {
    try {
      const { stdout } = await execFileAsync(command, [filePath, "-"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000
      });
      if (stdout.trim()) return stdout;
    } catch {
      // Try the next installed extractor.
    }
  }
  throw new Error("没有可用的 pdftotext，无法验证 PDF 中文内容");
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportStage(message) {
  process.stdout.write(`[追问备课业务测试] ${message}\n`);
}
