import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, safeStorage } from "electron";

import { PHYSICS_TEACHER_OPENAI_KEY_ENV } from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";
import { buildPhysicsQuestionCandidatePack } from "../dist/physics-teacher/question-bank-candidates.js";
import { evaluateTeacherExamBusinessResult } from "./teacher-exam-business-rubric.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(repositoryRoot, ".magi-reports", "teacher-live-exam-eval.json");
const modelAlias = process.env.MAGI_TEACHER_EXAM_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";
const timeoutMs = Number(process.env.MAGI_TEACHER_EXAM_EVAL_TIMEOUT_MS) || 240_000;

const scoreCsv = [
  "student_id,Q1,Q2,Q3,Q4,Q5",
  "S01,3,3,4,5,5",
  "S02,3,3,4,5,5",
  "S03,3,3,4,4,5",
  "S04,3,3,4,4,4",
  "S05,3,3,4,3,4",
  "S06,3,3,0,3,4",
  "S07,3,0,0,2,3",
  "S08,3,0,0,1,2",
  "S09,3,0,0,1,2",
  "S10,0,0,0,1,1"
].join("\n");

const paperText = [
  "业务测试用匿名期中试卷（仅含字段说明）",
  "Q1 满分3分：声现象。",
  "Q2 满分3分：平面镜成像。",
  "Q3 满分4分：滑动摩擦力及受力分析。",
  "Q4 满分5分：浮力大小与排开液体体积。",
  "Q5 满分5分：欧姆定律计算。"
].join("\n");

const answerText = [
  "Q1—Q5满分依次为3、3、4、5、5分。",
  "Q3关键步骤：判断相对运动趋势，再确定滑动摩擦力方向。",
  "Q4关键步骤：识别排开液体体积变化并使用阿基米德原理。"
].join("\n");

const prompt = [
  "请使用本次附件中的匿名逐题成绩、试卷说明和答案完成一次业务测试。",
  "先核对字段、人数和各题满分，再用工具计算逐题得分率。",
  "严格列出得分率低于60%的题目；等于60%的题目不能列入。",
  "把数据事实、教学解释和尚待教师确认的内容分开。",
  "然后针对低于60%的知识点，从项目题库中各找至少1道题干完整、答案可核对且不依赖缺失图片的原题，保留来源文件名、地区/年份和原题号。",
  "原题候选表每行必须同时写资料ID与原题号；题干只要出现‘如图/见图/图示’等图片引用，本轮就不得列为候选，不能解释为图片不重要。",
  "找不到可靠原题就明确说明，不得自编后冒充原题。",
  "本轮只在对话中给出分析和原题候选表，不需要写文件。"
].join("\n");

let runtime;
let resultMessage = "";
let selectedProject;
let selectedResourceCount;
let createdSessionId;
let allowedOriginalCandidateCount;
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
    throw new Error("没有包含题库资料的教学项目可用于业务测试");
  }
  selectedProject = selected.project.name;
  selectedResourceCount = selected.resourceCount;
  const resourceQuery = "滑动摩擦力 浮力 原题 真题 试卷 答案 解析";
  const allowedOriginalCandidates = buildPhysicsQuestionCandidatePack({
    resources: runtime.service.listResources(selected.project.id),
    query: `${prompt}\n${resourceQuery}`,
    limit: 36
  });
  if (allowedOriginalCandidates.length < 2) {
    throw new Error("后端完整题候选包不足两题，无法验证两个薄弱知识点的原题筛选");
  }
  allowedOriginalCandidateCount = allowedOriginalCandidates.length;

  reportStage(`选择项目“${selected.project.name}”，题库资料 ${selected.resourceCount} 份`);
  const session = runtime.service.createSession({
    projectId: selected.project.id,
    title: `考试分析业务测试 · ${new Date().toLocaleString("zh-CN")}`,
    kind: "exam-analysis"
  });
  createdSessionId = session.sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("考试分析业务测试超时"), timeoutMs);
  timer.unref?.();
  try {
    reportStage(`调用模型 ${modelAlias}`);
    const result = await runtime.service.sendMessage({
      sessionId: session.sessionId,
      prompt,
      modelAlias,
      resourceQuery,
      permissionScope: "project-write",
      signal: controller.signal,
      attachments: [
        {
          filename: "业务测试-匿名逐题成绩.csv",
          mimeType: "text/csv",
          body: Buffer.from(scoreCsv)
        },
        {
          filename: "业务测试-试卷说明.txt",
          mimeType: "text/plain",
          body: Buffer.from(paperText)
        },
        {
          filename: "业务测试-参考答案.txt",
          mimeType: "text/plain",
          body: Buffer.from(answerText)
        }
      ]
    });
    resultMessage = result.message;
  } finally {
    clearTimeout(timer);
  }

  const assertions = evaluateTeacherExamBusinessResult(resultMessage, {
    allowedOriginalCandidates,
    scriptExecutionEvidence: hasSuccessfulExamScriptRun(
      runtime.service.getSession(session.sessionId).session.messages
    )
  });
  await writeReport({
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    project: selected.project.name,
    resourceCount: selected.resourceCount,
    allowedOriginalCandidateCount: allowedOriginalCandidates.length,
    modelAlias,
    assertions,
    message: resultMessage
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        project: selected.project.name,
        resourceCount: selected.resourceCount,
        modelAlias,
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
    project: selectedProject,
    resourceCount: selectedResourceCount,
    sessionId: createdSessionId,
    allowedOriginalCandidateCount,
    error: error instanceof Error ? error.stack || error.message : String(error),
    message: resultMessage
  });
  process.stderr.write(
    `[考试分析业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
  app.exit(process.exitCode || 0);
}

function hasSuccessfulExamScriptRun(messages) {
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.metadata?.toolName === "Bash" &&
      message.metadata?.isError !== true &&
      /Command exited 0/.test(message.content) &&
      /逐题得分率/.test(message.content) &&
      /Q3[^\n]{0,100}50\.0%/.test(message.content) &&
      /Q4[^\n]{0,100}58\.0%/.test(message.content)
  );
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

function reportStage(message) {
  process.stderr.write(`[考试分析业务测试] ${message}\n`);
}
