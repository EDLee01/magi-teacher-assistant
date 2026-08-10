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
import { buildPhysicsQuestionCandidatePack } from "../dist/physics-teacher/question-bank-candidates.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";
import { SessionStore } from "../dist/session-store.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(
  repositoryRoot,
  ".magi-reports",
  "teacher-live-followup-paper-eval.json"
);
const modelAlias = process.env.MAGI_TEACHER_PAPER_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";
const timeoutMs = Number(process.env.MAGI_TEACHER_PAPER_EVAL_TIMEOUT_MS) || 360_000;
const artifactStem = `业务测试-摩擦力浮力专项训练-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")}`;
const prompt = [
  "继续上一轮考试分析，针对已经确认薄弱的滑动摩擦力和浮力，整理一份10题专项训练卷。",
  "题型必须是5道选择题、2道填空题、3道综合题；范围只限本项目年级和这两个知识点。",
  "优先逐题从项目题库选用题干完整、答案可核对且不依赖缺失图片的原题，不要自行编题替代可用原题。",
  "当前文档渲染不自动搬运来源图片：凡题干引用如图、图示装置，或原卷选项配甲乙丙丁图片，都必须换用纯文字原题，不能省略图片后仍标为原题。",
  "必须附学生卷、答案与解析、选题来源表；来源表逐题写明来源文件、地区/年份、原题号、资料ID和原题/补充题属性。",
  `请把完整成果写成 artifacts/${artifactStem}.docx 和 artifacts/${artifactStem}.pdf，两个文件内容一致。`,
  "聊天中只简要说明题型数量、原题占比和文件名，不要粘贴整份试卷。"
].join("\n");
const seedExamPrompt = "请分析这次匿名逐题成绩，严格找出低于60%的题目，并从题库检索同知识点原题。";
const seedExamAnswer = [
  "数据事实：Q3（滑动摩擦力及受力分析）得分率50%，Q4（浮力大小与排开液体体积）得分率58%；Q2恰好60%，不列入低于60%的题目。",
  "教学解释：Q3需重点检查摩擦力方向判断，Q4需检查阿基米德原理和排开液体体积变化。以上原因仍需教师结合答卷确认。",
  "题库检索已找到滑动摩擦力与浮力原题候选，后续可以继续追问并整理专项训练。"
].join("\n");

async function runLivePaperEval() {
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
      throw new Error("没有包含题库资料的教学项目可用于追问组卷测试");
    }
    const analysisSession = runtime.service.createSession({
      projectId: selected.project.id,
      title: `追问组卷业务测试 · ${new Date().toLocaleString("zh-CN")}`,
      kind: "exam-analysis"
    });
    const seedStore = SessionStore.open(runtime.magiPaths);
    try {
      seedStore.appendMessage({
        sessionId: analysisSession.sessionId,
        role: "user",
        content: seedExamPrompt,
        metadata: { source: "teacher-live-followup-paper-seed" }
      });
      seedStore.appendMessage({
        sessionId: analysisSession.sessionId,
        role: "assistant",
        content: seedExamAnswer,
        metadata: { source: "teacher-live-followup-paper-seed" }
      });
    } finally {
      seedStore.close();
    }
    const projectPaths = runtime.service.projectPathsForExisting(selected.project.id);
    const allowedOriginalCandidates = buildPhysicsQuestionCandidatePack({
      resources: runtime.service.listResources(selected.project.id),
      query: `${prompt}\n滑动摩擦力 浮力 原题 真题 试卷 答案 解析 选择题 填空题 综合题`,
      limit: 36
    });
    const artifactsBefore = new Map(
      (await listArtifactFiles(projectPaths.artifacts)).map((file) => [
        file.relativePath,
        `${file.sizeBytes}:${file.updatedAt}`
      ])
    );

    reportStage(
      `继续项目“${selected.project.name}”的 Session“${analysisSession.title}”，题库资料 ${selected.resourceCount} 份`
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("追问组卷业务测试超时"), timeoutMs);
    timer.unref?.();
    try {
      const result = await runtime.service.sendMessage({
        sessionId: analysisSession.sessionId,
        prompt,
        modelAlias,
        resourceQuery: "滑动摩擦力 浮力 原题 真题 试卷 答案 解析 选择题 填空题 综合题",
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
    const docxContainsMedia = await docxHasEmbeddedMedia(docxPath);
    const pdfText = await extractPdfText(pdfPath);
    const pdfHeader = (await readFile(pdfPath)).subarray(0, 5).toString("ascii");
    assert.equal(pdfHeader, "%PDF-", "生成的 PDF 文件格式无效");
    assert.match(pdfText, /摩擦/, "PDF 中没有可读取的中文“摩擦”");
    assert.match(pdfText, /浮/, "PDF 中没有可读取的中文“浮力”");

    const assertions = evaluatePaperResult({
      message: resultMessage,
      docxText,
      docxContainsMedia,
      allowedOriginalCandidates,
      artifactStem
    });
    await writeReport({
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      project: selected.project.name,
      sessionId: analysisSession.sessionId,
      resourceCount: selected.resourceCount,
      artifactStem,
      allowedOriginalCandidateCount: allowedOriginalCandidates.length,
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
          session: analysisSession.title,
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
      `[追问组卷业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    runtime?.close();
    app.exit(process.exitCode || 0);
  }
}

if (process.env.MAGI_TEACHER_PAPER_ASSERTIONS_ONLY !== "1") {
  await runLivePaperEval();
}

export function evaluatePaperResult({
  message,
  docxText,
  docxContainsMedia,
  allowedOriginalCandidates,
  artifactStem: expectedStem
}) {
  assert.match(
    message,
    new RegExp(escapeRegExp(`${expectedStem}.docx`)),
    "聊天中没有给出 DOCX 文件名"
  );
  assert.match(
    message,
    /原题(?:占比)?[^\n]{0,60}(?:5\s*\/\s*10|5\s*题|50(?:\.0+)?\s*%)/,
    "聊天中没有说明5/10原题或50%原题占比"
  );
  assert.ok(
    new RegExp(escapeRegExp(`${expectedStem}.pdf`)).test(message) ||
      (new RegExp(escapeRegExp(`${expectedStem}.docx`)).test(message) &&
        /同名\s*\.pdf/i.test(message)),
    "聊天中没有明确给出 PDF 文件或同名 PDF"
  );
  assert.match(message, /5\s*道?选择|选择题?\s*5\s*道/, "聊天中没有确认5道选择题");
  assert.match(message, /2\s*道?填空|填空题?\s*2\s*道/, "聊天中没有确认2道填空题");
  assert.match(
    message,
    /3\s*道?(综合|计算|解答)|(综合|计算|解答)题?\s*3\s*道/,
    "聊天中没有确认3道综合题"
  );
  assert.ok(message.length < 1_500, "聊天回复过长，疑似把整份试卷粘贴进对话");

  assert.match(docxText, /学生卷|专项训练(?:卷)?|一、选择题/, "DOCX 缺少学生卷");
  assert.match(docxText, /答案与解析|参考答案/, "DOCX 缺少答案与解析");
  assert.match(docxText, /选题来源表|题目来源表/, "DOCX 缺少选题来源表");
  assert.match(docxText, /选择题/, "DOCX 缺少选择题部分");
  assert.match(docxText, /填空题/, "DOCX 缺少填空题部分");
  assert.match(docxText, /综合题|计算题|解答题/, "DOCX 缺少综合题部分");
  assert.match(docxText, /滑动摩擦力|摩擦力/, "DOCX 未覆盖滑动摩擦力");
  assert.match(docxText, /浮力|阿基米德/, "DOCX 未覆盖浮力");
  assert.match(docxText, /来源文件|资料ID|资料 ID/, "来源表缺少来源文件或资料 ID");
  assert.match(docxText, /原题号|题号/, "来源表缺少原题号");
  const hasDeletedOriginalContent =
    /(?:学生卷|题干|原题|图示|图片)[^\n]{0,80}(?:已删去|删除了?|删掉)|(?:已删去|删除了?|删掉)[^\n]{0,80}(?:如图|图示|图片|题干)/.test(
      docxText
    );
  assert.ok(
    !(hasDeletedOriginalContent && /无改编题|改编题\s*0\s*道/.test(docxText)),
    "试卷删改了原题内容，却仍统计为无改编题"
  );
  assert.doesNotMatch(
    docxText,
    /改编题[^\n]{0,120}(?:删除|删去)[^\n]{0,80}(?:如图|图引用|图片|图示)/,
    "本轮不允许通过删除图片引用把图片原题改成纯文字题"
  );
  const studentPaperText = docxText.split(/\n(?:第二部分\s*)?(?:答案与解析|参考答案)\s*\n/)[0];
  const referencesRequiredFigure = /如图|见图|下图|图中|图示|示意图|装置图|电路图/.test(
    studentPaperText
  );
  assert.ok(
    !referencesRequiredFigure || docxContainsMedia,
    "试卷正文引用了图示，但 DOCX 中没有嵌入任何图片"
  );
  const sourceTableText = docxText.split(/选题来源表|题目来源表/).at(-1) ?? "";
  const sourceRows = sourceTableText.split(/\r?\n/).map(parseSourceRow).filter(Boolean);
  const sourceQuestionNumbers = new Set(sourceRows.map((row) => row.paperNumber));
  assert.equal(sourceRows.length, 10, "选题来源表没有逐题覆盖10道题");
  for (let number = 1; number <= 10; number += 1) {
    assert.ok(sourceQuestionNumbers.has(number), `选题来源表缺少第${number}题`);
  }
  const originalRows = sourceRows.filter((row) => row.attribute === "original");
  assert.equal(
    originalRows.length,
    allowedOriginalCandidates.length,
    `没有尽量使用候选包原题：应使用${allowedOriginalCandidates.length}题，实际${originalRows.length}题`
  );
  const allowedOriginalPairs = new Set(
    allowedOriginalCandidates.map(
      (candidate) => `${candidate.sourceId}:${normalizeQuestionNumber(candidate.questionNumber)}`
    )
  );
  const usedOriginalPairs = new Set();
  for (const row of originalRows) {
    assert.ok(
      row.sourceId && row.originalQuestionNumber,
      `原题来源行缺少可核对的资料ID或原题号：${row.raw}`
    );
    const pair = `${row.sourceId}:${normalizeQuestionNumber(row.originalQuestionNumber)}`;
    assert.ok(allowedOriginalPairs.has(pair), `来源表使用了候选包之外的原题：${pair}`);
    usedOriginalPairs.add(pair);
  }
  assert.equal(
    usedOriginalPairs.size,
    allowedOriginalPairs.size,
    "候选包原题没有全部使用或出现重复冒充"
  );
  const questionNumbers = new Set(
    [...docxText.matchAll(/(?:^|\n)\s*(\d{1,2})\s*[.、．)]/g)].map((match) => Number(match[1]))
  );
  for (let number = 1; number <= 10; number += 1) {
    assert.ok(questionNumbers.has(number), `DOCX 中没有识别到第${number}题`);
  }
  const answerText = docxText.split(/\n(?:第二部分\s*)?(?:答案与解析|参考答案)\s*\n/)[1] ?? "";
  const answerQuestionNumbers = new Set(
    [...answerText.matchAll(/(?:^|\n)\s*(?:第\s*)?(\d{1,2})(?:\s*题)?\s*[.、．)]/g)].map((match) =>
      Number(match[1])
    )
  );
  for (let number = 1; number <= 10; number += 1) {
    assert.ok(answerQuestionNumbers.has(number), `答案解析缺少第${number}题答案`);
  }
  assert.deepEqual(
    questionNumbersInSection(studentPaperText, /一、?选择题/, /二、?填空题/),
    [1, 2, 3, 4, 5]
  );
  assert.deepEqual(
    questionNumbersInSection(studentPaperText, /二、?填空题/, /三、?(?:综合题|计算题|解答题)/),
    [6, 7]
  );
  assert.deepEqual(
    questionNumbersInSection(studentPaperText, /三、?(?:综合题|计算题|解答题)/, /$/),
    [8, 9, 10]
  );
  return [
    "追问延续上一轮Q3/Q4薄弱知识点",
    "题型为5选择、2填空、3综合",
    "生成可解析的DOCX和有效PDF",
    "PDF中文可正常提取与显示",
    "桌面端可内嵌预览DOCX和PDF",
    "包含学生卷、答案解析和选题来源表",
    "来源表保留资料ID和原题号",
    "删改过的题目不会被标为原题",
    "题干引用图示时DOCX必须包含图片",
    "原题来源限定在后端完整题候选包",
    "候选包5道原题全部使用且来源题号成对匹配",
    "聊天仅返回摘要与文件名"
  ];
}

function questionNumbersInSection(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  assert.ok(start >= 0, `学生卷缺少题型章节：${startPattern}`);
  const body = text.slice(start + text.slice(start).match(startPattern)[0].length);
  const end = body.search(endPattern);
  const section = end >= 0 ? body.slice(0, end) : body;
  return [...section.matchAll(/(?:^|\n)\s*(\d{1,2})\s*[.、．)]/g)].map((match) => Number(match[1]));
}

function normalizeQuestionNumber(value) {
  return String(Number.parseInt(String(value), 10));
}

function parseSourceRow(line) {
  const raw = line.trim();
  if (!raw) return undefined;
  const labeledNumber = /^第\s*(\d{1,2})\s*题\s+属性[：:]/.exec(raw)?.[1];
  if (labeledNumber) {
    const attribute = /属性[：:]\s*原题/.test(raw)
      ? "original"
      : /属性[：:]\s*(?:题库缺口)?补充题/.test(raw)
        ? "supplement"
        : undefined;
    if (!attribute) return undefined;
    return {
      raw,
      paperNumber: Number(labeledNumber),
      attribute,
      sourceId: raw.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0],
      originalQuestionNumber: raw.match(/原题号[：:]\s*(?:第\s*)?(\d{1,2})/)?.[1]
    };
  }
  const columns = raw.split(/\t+|\s{2,}/).map((value) => value.trim());
  if (!/^\d{1,2}$/.test(columns[0] ?? "")) return undefined;
  const attribute =
    columns[3] === "原题" ? "original" : /补充题/.test(columns[3] ?? "") ? "supplement" : undefined;
  if (!attribute) return undefined;
  return {
    raw,
    paperNumber: Number(columns[0]),
    attribute,
    sourceId: columns.find((value) => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)),
    originalQuestionNumber: attribute === "original" ? columns[6] : undefined
  };
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
  const candidates = [
    process.env.MAGI_PDFTOTEXT_PATH,
    "pdftotext",
    "/opt/homebrew/bin/pdftotext",
    "/usr/local/bin/pdftotext"
  ].filter(Boolean);
  for (const command of new Set(candidates)) {
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

async function docxHasEmbeddedMedia(filePath) {
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
  process.stderr.write(`[追问组卷业务测试] ${message}\n`);
}
