import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPhysicsQuestionCandidatePack } from "../dist/physics-teacher/question-bank-candidates.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";
import { evaluateTeacherExamBusinessResult } from "./teacher-exam-business-rubric.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveReportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-exam-eval.json"
);
const recheckReportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-exam-recheck.json"
);
const resourceQuery = "滑动摩擦力 浮力 原题 真题 试卷 答案 解析";
let runtime;

try {
  const liveReport = JSON.parse(await readFile(liveReportPath, "utf8"));
  const message = String(liveReport.message ?? "");
  if (!message) throw new Error("最近一次考试分析报告缺少模型回答");

  process.env.MAGI_SQLITE_DRIVER = "builtin";
  runtime = createPhysicsTeacherRuntime({ ...process.env, MAGI_SQLITE_DRIVER: "builtin" });
  const selected = runtime.service
    .listProjects()
    .map((project) => ({ project, resources: runtime.service.listResources(project.id) }))
    .sort((left, right) => right.resources.length - left.resources.length)[0];
  if (!selected || selected.resources.length === 0) throw new Error("没有可复核的题库项目");

  const sessionInfo = selectExamSession({
    sessions: runtime.service.listSessions(selected.project.id),
    requestedSessionId: liveReport.sessionId
  });
  const session = runtime.service.getSession(sessionInfo.sessionId).session;
  const assistantMessage = [...session.messages]
    .reverse()
    .find((item) => item.role === "assistant");
  assert.equal(assistantMessage?.content, message, "真实报告与待复核 Session 的回答不一致");
  const userMessage = session.messages.find((item) => item.role === "user");
  if (!userMessage) throw new Error("待复核 Session 缺少教师要求");
  const prompt = userMessage.content.split("\n\n[本次附件]")[0];
  const candidates = buildPhysicsQuestionCandidatePack({
    resources: selected.resources,
    query: `${prompt}\n${resourceQuery}`,
    limit: 36
  });
  const scriptExecutionEvidence = hasSuccessfulExamScriptRun(session.messages);
  const assertions = evaluateTeacherExamBusinessResult(message, {
    allowedOriginalCandidates: candidates,
    scriptExecutionEvidence
  });
  const report = {
    status: "passed",
    recheckedAt: new Date().toISOString(),
    sourceReport: liveReportPath,
    project: selected.project.name,
    sessionId: sessionInfo.sessionId,
    candidateCount: candidates.length,
    scriptExecutionEvidence,
    assertions
  };
  await mkdir(path.dirname(recheckReportPath), { recursive: true });
  await writeFile(recheckReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath: recheckReportPath }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(
    `[考试分析离线复核] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
}

function selectExamSession({ sessions, requestedSessionId }) {
  const requested = requestedSessionId
    ? sessions.find((session) => session.sessionId === requestedSessionId)
    : undefined;
  if (requested) return requested;
  const latest = sessions.find((session) => session.title.includes("考试分析业务测试"));
  if (!latest) throw new Error("没有找到可复核的考试分析业务测试 Session");
  return latest;
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
