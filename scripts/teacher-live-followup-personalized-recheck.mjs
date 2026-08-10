import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { app } from "electron";

import { buildPhysicsQuestionCandidatePack } from "../dist/physics-teacher/question-bank-candidates.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";

process.env.MAGI_TEACHER_PERSONALIZED_ASSERTIONS_ONLY = "1";
const { evaluatePersonalizedResult } =
  await import("./teacher-live-followup-personalized-eval.mjs");
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveReportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-followup-personalized-eval.json"
);
const recheckReportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-followup-personalized-recheck.json"
);
let runtime;

try {
  const liveReport = JSON.parse(await readFile(liveReportPath, "utf8"));
  const artifactStem = String(liveReport.artifactStem ?? "").trim();
  const message = String(liveReport.message ?? "");
  if (!artifactStem || !message) throw new Error("最近一次真实测试报告缺少产物名称或聊天摘要");
  process.env.MAGI_SQLITE_DRIVER = "builtin";
  runtime = createPhysicsTeacherRuntime({ ...process.env, MAGI_SQLITE_DRIVER: "builtin" });
  const selected = runtime.service
    .listProjects()
    .map((project) => ({ project, resources: runtime.service.listResources(project.id) }))
    .sort((left, right) => right.resources.length - left.resources.length)[0];
  if (!selected || selected.resources.length === 0) throw new Error("没有可复核的题库项目");
  const candidates = buildPhysicsQuestionCandidatePack({
    resources: selected.resources,
    query: "滑动摩擦力 浮力 原题 真题 实验 密度 受力分析 答案 解析 7天个性化学习路径",
    limit: 36
  });
  const allowedSourceIds = new Set(candidates.map((candidate) => candidate.sourceId));
  const docxPath = path.join(selected.project.rootDir, "artifacts", `${artifactStem}.docx`);
  const { stdout: docxText } = await execFileAsync(
    "/usr/bin/textutil",
    ["-convert", "txt", "-stdout", docxPath],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }
  );
  const docxContainsMedia = await hasEmbeddedMedia(docxPath);
  const assertions = evaluatePersonalizedResult({
    message,
    docxText,
    docxContainsMedia,
    allowedSourceIds,
    artifactStem
  });
  const report = {
    status: "passed",
    recheckedAt: new Date().toISOString(),
    sourceReport: liveReportPath,
    artifactStem,
    project: selected.project.name,
    candidateCount: candidates.length,
    assertions
  };
  await mkdir(path.dirname(recheckReportPath), { recursive: true });
  await writeFile(recheckReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ ...report, reportPath: recheckReportPath }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(
    `[个性化学习离线复核] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
  app.exit(process.exitCode || 0);
}

async function hasEmbeddedMedia(filePath) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", filePath], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000
    });
    return stdout.split(/\r?\n/).some((entry) => entry.startsWith("word/media/"));
  } catch {
    return false;
  }
}
