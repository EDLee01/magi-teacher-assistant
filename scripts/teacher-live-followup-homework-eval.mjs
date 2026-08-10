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
  "teacher-live-followup-homework-eval.json"
);
const modelAlias = process.env.MAGI_TEACHER_HOMEWORK_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";
const timeoutMs = Number(process.env.MAGI_TEACHER_HOMEWORK_EVAL_TIMEOUT_MS) || 360_000;
const artifactStem = `业务测试-摩擦力浮力分层作业-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")}`;
const prompt = [
  "继续上一轮当堂检测分析，针对已确认的滑动摩擦力和浮力学习需要，设计一份8题分层作业辅导。",
  "学生用作业统一编号1—8：基础巩固3题、针对纠错3题、迁移挑战2题。逐层写明适用对象、解决的问题和完成标准，不给学生贴固定能力标签。",
  "从项目题库筛选纯文字原题，存在可靠原题时不得自行编题；所有原题必须来自系统候选包并保留来源文件、原题号、资料ID。候选不足才用题库缺口补充题，不得删除原图后改写。",
  "候选题没有附同源答案时，只要题干条件完整、独立作答能得到唯一答案，仍要保留为原题并标注答案独立复核，不能仅因缺参考答案就放弃。",
  "题库缺口补充的摩擦力题必须保证受力条件自洽；不能写用手按住物体保持墙面压力后又松手，却继续沿用松手前的压力条件。",
  "针对纠错层每题提供一级提示和二级提示：一级只问关键判断，二级只给物理关系或建模路径；提示中不要泄露最终数值或选项，完整答案统一放在提示之后。",
  "二级提示必须停在下一步怎样判断或列式，不能替学生完成数值代入、联立或写出最终状态；例如题目给出拉力20N时，只能提示用二力平衡求摩擦力，不能写f=F=20N。",
  "给出答案解析和针对重点错因的教师反馈语，反馈要告诉学生下一步怎么改，不能只写粗心或认真审题。",
  "最后另附2题短复测，并明确：2题全对为通过，1题正确为部分通过，0题正确为未通过；三种结果分别说明下一步。",
  `完整成果写入 artifacts/${artifactStem}.docx 和 artifacts/${artifactStem}.pdf，两份内容一致。`,
  "聊天中只简要说明3/3/2分层结构、原题占比、2题复测和两个文件名，不要粘贴完整作业。"
].join("\n");
const seedPrompt = "请根据这次匿名当堂检测结果做学情诊断，作为后续分层作业依据。";
const seedAnswer = [
  "数据事实：10名学生完成3题检测。第1题公式计算8/10正确，第2题必须写物理过程依据，仅4/10完整正确，第3题迁移判断6/10正确。",
  "教学解释：主要证据表明‘能代公式但过程依据不完整’仍需重点纠正；具体学生的错误来源仍需结合答题纸核实，不能据此贴固定标签。",
  "临时分组只用于本次作业：全体完成基础巩固；过程依据不完整者增加针对纠错；当堂检测3题全对者可进入迁移挑战。完成后用短复测重新调整。"
].join("\n");

async function runLiveHomeworkEval() {
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
      throw new Error("没有包含题库资料的项目可用于追问作业测试");
    }

    const homeworkSession = runtime.service.createSession({
      projectId: selected.project.id,
      title: `追问作业辅导业务测试 · ${new Date().toLocaleString("zh-CN")}`,
      kind: "practice-adjustment"
    });
    const seedStore = SessionStore.open(runtime.magiPaths);
    try {
      seedStore.appendMessage({
        sessionId: homeworkSession.sessionId,
        role: "user",
        content: seedPrompt,
        metadata: { source: "teacher-live-followup-homework-seed" }
      });
      seedStore.appendMessage({
        sessionId: homeworkSession.sessionId,
        role: "assistant",
        content: seedAnswer,
        metadata: { source: "teacher-live-followup-homework-seed" }
      });
    } finally {
      seedStore.close();
    }

    const projectPaths = runtime.service.projectPathsForExisting(selected.project.id);
    const resourceQuery = "滑动摩擦力 浮力 原题 真题 作业 练习 答案 解析 复测";
    const allowedCandidates = buildPhysicsQuestionCandidatePack({
      resources: runtime.service.listResources(selected.project.id),
      query: `${prompt}\n${resourceQuery}`,
      limit: 36
    });
    const allowedSourceIds = new Set(allowedCandidates.map((candidate) => candidate.sourceId));
    const artifactsBefore = new Map(
      (await listArtifactFiles(projectPaths.artifacts)).map((file) => [
        file.relativePath,
        `${file.sizeBytes}:${file.updatedAt}`
      ])
    );

    reportStage(
      `继续项目“${selected.project.name}”的 Session“${homeworkSession.title}”，题库资料 ${selected.resourceCount} 份`
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("追问作业辅导业务测试超时"), timeoutMs);
    timer.unref?.();
    try {
      const result = await runtime.service.sendMessage({
        sessionId: homeworkSession.sessionId,
        prompt,
        modelAlias,
        resourceQuery,
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
    assert.equal((await readFile(pdfPath)).subarray(0, 5).toString("ascii"), "%PDF-");
    assert.match(pdfText, /摩擦/, "PDF 中没有可读取的中文“摩擦”");
    assert.match(pdfText, /浮/, "PDF 中没有可读取的中文“浮力”");

    const assertions = evaluateHomeworkResult({
      message: resultMessage,
      docxText,
      docxContainsMedia,
      allowedSourceIds,
      artifactStem
    });
    await writeReport({
      status: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      project: selected.project.name,
      sessionId: homeworkSession.sessionId,
      resourceCount: selected.resourceCount,
      candidateCount: allowedCandidates.length,
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
          session: homeworkSession.title,
          resourceCount: selected.resourceCount,
          candidateCount: allowedCandidates.length,
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
      `[追问作业辅导业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    runtime?.close();
    app.exit(process.exitCode || 0);
  }
}

if (process.env.MAGI_TEACHER_HOMEWORK_ASSERTIONS_ONLY !== "1") {
  await runLiveHomeworkEval();
}

export function evaluateHomeworkResult({
  message,
  docxText,
  docxContainsMedia,
  allowedSourceIds,
  artifactStem: expectedStem
}) {
  assert.match(message, new RegExp(escapeRegExp(`${expectedStem}.docx`)), "聊天中缺少DOCX文件名");
  assert.match(message, new RegExp(escapeRegExp(`${expectedStem}.pdf`)), "聊天中缺少PDF文件名");
  assert.match(
    message,
    /基础[^\n]{0,40}3[^\n]{0,40}纠错[^\n]{0,80}3[^\n]{0,80}迁移[^\n]{0,40}2|3\s*[\/-]3\s*[\/-]2/,
    "聊天中没有确认3/3/2分层结构"
  );
  assert.match(
    message,
    /(?:另附\s*)?2\s*(?:题|道)[^\n]{0,12}复测|复测[^\n]{0,12}2\s*(?:题|道)/,
    "聊天中没有确认2题复测"
  );
  assert.match(
    message,
    /原题(?:占比)?[^\n]{0,60}(?:[45]\s*\/\s*8|[45]\s*题|(?:50|62\.5)\s*%)/,
    "聊天中没有说明原题占比"
  );
  assert.ok(message.length < 1_400, "聊天回复过长，疑似粘贴了完整作业");

  assert.match(docxText, /学情依据|数据事实|分析边界|诊断结论|数据边界/, "作业缺少学情依据");
  assert.match(docxText, /8\s*\/\s*10|8\s*人|80\s*%/, "作业未引用第1题检测结果");
  assert.match(docxText, /4\s*\/\s*10|4\s*人|40\s*%/, "作业未引用第2题检测结果");
  assert.match(docxText, /6\s*\/\s*10|6\s*人|60\s*%/, "作业未引用第3题检测结果");
  const studentPaper =
    docxText
      .split(/学生用作业/)
      .at(-1)
      ?.split(/答案、解析|答案与解析|参考答案|完整答案/)[0] ?? "";
  const questionPositions = new Map(
    Array.from({ length: 8 }, (_, index) => {
      const number = index + 1;
      const match = new RegExp(
        `(?:^|\\n)\\s*(?:(?:第\\s*)?${number}\\s*题|题\\s*${number}(?=\\s|[（(])|${number}\\s*[.、．])`
      ).exec(studentPaper);
      return [number, match?.index ?? -1];
    })
  );
  const hasStudentLayerMarkers = ["基础巩固", "针对纠错", "迁移挑战"].some((layer) =>
    studentPaper.includes(layer)
  );
  const layerAtQuestion = (number) => {
    const position = questionPositions.get(number) ?? -1;
    if (position < 0) return undefined;
    if (!hasStudentLayerMarkers) {
      if (number <= 3) return "基础巩固";
      if (number <= 6) return "针对纠错";
      return "迁移挑战";
    }
    const headingStart =
      position + (studentPaper.slice(position).match(/^[\r\n \t]*/)?.[0].length ?? 0);
    const lineEnd = studentPaper.indexOf("\n", headingStart + 1);
    const headingLine = studentPaper.slice(headingStart, lineEnd < 0 ? undefined : lineEnd);
    for (const layer of ["基础巩固", "针对纠错", "迁移挑战"]) {
      if (headingLine.includes(layer)) return layer;
    }
    return ["基础巩固", "针对纠错", "迁移挑战"]
      .map((layer) => ({ layer, position: studentPaper.lastIndexOf(layer, position) }))
      .sort((left, right) => right.position - left.position)[0]?.layer;
  };
  for (const number of [1, 2, 3]) {
    assert.equal(layerAtQuestion(number), "基础巩固", `第${number}题不在基础巩固层`);
  }
  for (const number of [4, 5, 6]) {
    assert.equal(layerAtQuestion(number), "针对纠错", `第${number}题不在针对纠错层`);
  }
  for (const number of [7, 8]) {
    assert.equal(layerAtQuestion(number), "迁移挑战", `第${number}题不在迁移挑战层`);
  }
  assert.match(
    docxText,
    /适用对象|适合对象|全体(?:学生)?完成|未完整作答(?:的学生|者)?完成|全对(?:的学生|者)?完成/,
    "分层说明缺少适用对象"
  );
  assert.match(docxText, /完成标准/, "分层说明缺少完成标准");
  assert.match(docxText, /学生用作业|分层作业/, "缺少学生用作业");
  assert.match(docxText, /逐级提示/, "缺少逐级提示区");
  assert.ok((docxText.match(/一级提示/g) ?? []).length >= 3, "针对纠错题没有逐题给一级提示");
  assert.ok((docxText.match(/二级提示/g) ?? []).length >= 3, "针对纠错题没有逐题给二级提示");
  const beforeAnswers = docxText.split(/答案、解析|答案与解析|参考答案|完整答案/)[0];
  const hintSection = beforeAnswers
    .split(/\r?\n/)
    .filter((line) => /一级提示|二级提示/.test(line))
    .join("\n");
  assert.doesNotMatch(hintSection, /G[₀0]\s*=\s*2f|故选\s*A/, "第4题提示泄露了最终答案");
  assert.doesNotMatch(
    hintSection,
    /摩擦力(?:方向)?[^。；\n]{0,18}(?:竖直)?向上|f[₁1２2]?\s*=\s*G/,
    "第5题提示直接填出了方向或比较结果"
  );
  assert.doesNotMatch(
    hintSection,
    /(?:静止后|物体)[^。；\n]{0,12}漂浮|F浮\s*=\s*G\s*=\s*1\.6|160\s*cm/,
    "第6题提示泄露了状态或最终数值"
  );
  assert.doesNotMatch(
    hintSection,
    /f\s*=\s*F\s*=\s*\d|(?:仍为|等于)\s*\d+(?:\.\d+)?\s*N|故(?:选|填)|答案[：:]/i,
    "逐级提示替学生完成了数值代入或直接给出答案"
  );
  assert.match(docxText, /答案(?:、|与)解析|参考答案|完整答案/, "缺少与提示分开的答案解析");
  assert.match(docxText, /教师反馈语|反馈语/, "缺少教师反馈语");
  assert.doesNotMatch(
    docxText,
    /反馈语[^\n]{0,30}(?:粗心|认真审题)[。；]?\s*$/m,
    "反馈语仍是空泛评价"
  );
  assert.match(docxText, /选题来源表|题目来源表/, "缺少选题来源表");
  assert.match(docxText, /资料\s*ID|资料ID/, "选题来源缺少资料ID");
  assert.match(docxText, /复测题|短复测/, "缺少复测题");
  assert.match(docxText, /2\s*题全对[^\n]{0,40}通过|通过[^\n]{0,40}2\s*题全对/, "缺少复测通过标准");
  assert.match(
    docxText,
    /1\s*题(?:正确|对)[^\n]{0,40}部分通过|部分通过[^\n]{0,40}1\s*题(?:正确|对)/,
    "缺少复测部分通过标准"
  );
  assert.match(
    docxText,
    /0\s*题(?:正确|对)[^\n]{0,40}未通过|未通过[^\n]{0,40}0\s*题(?:正确|对)/,
    "缺少复测未通过标准"
  );
  assert.match(docxText, /仍需教师确认|教师确认/, "缺少教师确认项");

  const questionNumbers = new Set(
    [...questionPositions.entries()]
      .filter(([, position]) => position >= 0)
      .map(([number]) => number)
  );
  for (let number = 1; number <= 8; number += 1) {
    assert.ok(questionNumbers.has(number), `学生用作业中没有识别到第${number}题`);
  }
  const referencesFigure = /如图|见图|下图|图中|图示|示意图|装置图|电路图/.test(studentPaper);
  assert.ok(!referencesFigure || docxContainsMedia, "学生作业引用图示但DOCX没有嵌入图片");
  assert.doesNotMatch(
    docxText,
    /改编题[^\n]{0,120}(?:删除|删去)[^\n]{0,80}(?:如图|图引用|图片|图示)/,
    "作业通过删除图片引用使用了图片原题"
  );
  assert.doesNotMatch(
    docxText,
    /匀速上爬[\s\S]{0,700}摩擦力(?:方向)?[^。；\n]{0,18}(?:竖直)?向上/,
    "补充题把接触作用不明的上爬情境直接判成向上摩擦力"
  );
  assert.doesNotMatch(
    studentPaper,
    /用手按住[\s\S]{0,100}(?:保持|压力)[\s\S]{0,80}松手后/,
    "补充题在松手后仍保留了由手提供的墙面压力"
  );

  const originalRows = docxText
    .split(/\r?\n/)
    .filter(
      (line) =>
        /(?:属性[：:]\s*原题|(?:^|[｜|\s（(])原题(?:$|[｜|\s）)]))/.test(line) &&
        /[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(line)
    );
  assert.ok(originalRows.length > 0, "来源表没有可核对的原题");
  assert.ok(
    originalRows.length >= Math.min(4, allowedSourceIds.size),
    `没有尽量使用候选包原题：仅识别到${originalRows.length}题`
  );
  for (const row of originalRows) {
    const sourceId = row.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
    assert.ok(
      sourceId && allowedSourceIds.has(sourceId),
      `来源表使用了候选包之外的原题资料：${sourceId ?? row}`
    );
  }

  return [
    "延续匿名当堂检测的8/10、4/10、6/10证据",
    "8题按基础3、纠错3、迁移2分层",
    "原题来源限定在后端完整题候选包",
    "纠错题提供不泄露答案的两级提示",
    "答案解析与教师反馈语独立呈现",
    "2题复测包含通过、部分通过、未通过后续动作",
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
  process.stdout.write(`[追问作业辅导业务测试] ${message}\n`);
}
