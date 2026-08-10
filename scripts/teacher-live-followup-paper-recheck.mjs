import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { app } from "electron";

import { loadFilePreview } from "../desktop/artifact-preview.mjs";
import { buildPhysicsQuestionCandidatePack } from "../dist/physics-teacher/question-bank-candidates.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";

process.env.MAGI_TEACHER_PAPER_ASSERTIONS_ONLY = "1";
const { evaluatePaperResult } = await import("./teacher-live-followup-paper-eval.mjs");

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const liveReportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-followup-paper-eval.json"
);
const recheckReportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-followup-paper-recheck.json"
);
const candidateQuery =
  "滑动摩擦力 浮力 原题 真题 试卷 答案 解析 选择题 填空题 综合题 5道选择题 2道填空题 3道综合题";
let runtime;

try {
  const liveReport = JSON.parse(await readFile(liveReportPath, "utf8"));
  const artifactStem = String(liveReport.artifactStem ?? "").trim();
  const message = String(liveReport.message ?? "");
  if (!artifactStem || !message) throw new Error("最近一次组卷报告缺少产物名称或聊天摘要");

  process.env.MAGI_SQLITE_DRIVER = "builtin";
  runtime = createPhysicsTeacherRuntime({ ...process.env, MAGI_SQLITE_DRIVER: "builtin" });
  const selected = runtime.service
    .listProjects()
    .map((project) => ({ project, resources: runtime.service.listResources(project.id) }))
    .sort((left, right) => right.resources.length - left.resources.length)[0];
  if (!selected || selected.resources.length === 0) throw new Error("没有可复核的题库项目");
  const candidates = buildPhysicsQuestionCandidatePack({
    resources: selected.resources,
    query: candidateQuery,
    limit: 36
  });
  const docxPath = path.join(selected.project.rootDir, "artifacts", `${artifactStem}.docx`);
  const pdfPath = path.join(selected.project.rootDir, "artifacts", `${artifactStem}.pdf`);
  const [docxPreview, pdfPreview] = await Promise.all([
    loadFilePreview(docxPath, `${artifactStem}.docx`),
    loadFilePreview(pdfPath, `${artifactStem}.pdf`)
  ]);
  assert.equal(docxPreview.kind, "html", "DOCX 没有通过桌面端内嵌预览转换");
  assert.equal(pdfPreview.kind, "pdf", "PDF 没有通过桌面端内嵌预览加载");
  const { stdout: docxText } = await execFileAsync(
    "/usr/bin/textutil",
    ["-convert", "txt", "-stdout", docxPath],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }
  );
  const pdfHeader = (await readFile(pdfPath)).subarray(0, 5).toString("ascii");
  assert.equal(pdfHeader, "%PDF-", "生成的 PDF 文件格式无效");
  const pdfText = await extractPdfText(pdfPath);
  assert.match(pdfText, /摩擦/);
  assert.match(pdfText, /浮/);
  const docxContainsMedia = await hasEmbeddedMedia(docxPath);
  const assertions = evaluatePaperResult({
    message,
    docxText,
    docxContainsMedia,
    allowedOriginalCandidates: candidates,
    artifactStem
  });
  const report = {
    status: "passed",
    recheckedAt: new Date().toISOString(),
    sourceReport: liveReportPath,
    project: selected.project.name,
    artifactStem,
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
    `[追问组卷离线复核] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
  app.exit(process.exitCode || 0);
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
