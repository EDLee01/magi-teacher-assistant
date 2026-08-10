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
  "teacher-live-followup-personalized-eval.json"
);
const modelAlias =
  process.env.MAGI_TEACHER_PERSONALIZED_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";
const timeoutMs = Number(process.env.MAGI_TEACHER_PERSONALIZED_EVAL_TIMEOUT_MS) || 420_000;
const artifactStem = `业务测试-三名匿名学生一周学习路径-${new Date()
  .toISOString()
  .replace(/[-:TZ.]/g, "")}`;
const resourceQuery = "滑动摩擦力 浮力 原题 真题 实验 密度 受力分析 答案 解析";
const prompt = [
  "继续上一轮匿名学情记录，为S01、S02、S03分别制定7天个性化学习路径。三人的路径必须由各自证据决定，不能只是换名字后发同一套任务。",
  "每人最多2个近期目标。每人的7天路径按第1天至第7天逐日列出：活动、材料或原题、预计用时（每天不超过20分钟）、学生产出、教师观察信号、完成标准。已掌握内容不机械重做。",
  "S01只优先解决摩擦力受力分析和过程表达；S02不重做基础巩固，只处理浮力实验与密度表达式迁移；S03因缺交和缺测，先补齐证据再决定补弱，不得作确定性能力判断。",
  "从系统候选包选用5道纯文字原题作为任务库，候选题没有同源答案时可独立复核；原题可按目标跨学生复用，但要逐题保留来源文件、原题号、资料ID和分配理由，不得删除原图后改写。其他日程可用讲解、订正、口述、实验步骤整理和复测，不要为了填满7天自编大量题目。",
  "每人都要有2题短复测，并写清达到、部分达到、未达到的下一步；新证据与原判断冲突时必须调整目标。",
  "全文只使用S01、S02、S03匿名编号，不出现真实姓名，不使用学困生、差生、优秀生、后进生等固定标签。",
  "文末列教师确认项和待教师确认的记忆草稿：只有S01的连续证据可以形成候选，S02的单次表达式错误和S03的缺测都明确暂不进入长期记忆；不要实际写入memory。",
  `完整成果写入 artifacts/${artifactStem}.docx 和 artifacts/${artifactStem}.pdf，两份内容一致。`,
  "聊天中只报告3名匿名学生、7天周期、5道原题占比、未自动写入长期记忆以及两个文件名，不要粘贴完整路径。"
].join("\n");
const seedPrompt = "请先整理这三名匿名学生的连续作答数据，供下一步制定学习路径。";
const seedAnswer = [
  "S01：当堂检测2/3；第1题公式计算正确，第2题过程依据不完整，第3题迁移判断错误。分层作业基础巩固3/3、针对纠错1/3。短复测中浮力题正确、摩擦力题错误。",
  "S02：当堂检测3/3；迁移挑战1/2，牛奶密度表达式把分子分母写反；短复测2/2。除此之外没有证据表明基础概念需要重学。",
  "S03：当堂检测2/3；第1题正确、第2题过程完整、第3题错误。基础作业只提交2/3，短复测未完成；缺少的数据不能按错误处理。",
  "数据仅使用匿名编号。以上是作答事实；错因解释和长期结论仍需教师确认。"
].join("\n");

async function runLivePersonalizedEval() {
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
        resources: runtime.service.listResources(project.id)
      }))
      .sort((left, right) => right.resources.length - left.resources.length)[0];
    if (!selected || selected.resources.length === 0) throw new Error("没有包含题库资料的项目");

    const session = runtime.service.createSession({
      projectId: selected.project.id,
      title: `个性化学习业务测试 · ${new Date().toLocaleString("zh-CN")}`,
      kind: "practice-adjustment"
    });
    const seedStore = SessionStore.open(runtime.magiPaths);
    try {
      seedStore.appendMessage({
        sessionId: session.sessionId,
        role: "user",
        content: seedPrompt,
        metadata: { source: "teacher-live-personalized-seed" }
      });
      seedStore.appendMessage({
        sessionId: session.sessionId,
        role: "assistant",
        content: seedAnswer,
        metadata: { source: "teacher-live-personalized-seed" }
      });
    } finally {
      seedStore.close();
    }

    const projectPaths = runtime.service.projectPathsForExisting(selected.project.id);
    const candidates = buildPhysicsQuestionCandidatePack({
      resources: selected.resources,
      query: `${prompt}\n${resourceQuery}`,
      limit: 36
    });
    const allowedSourceIds = new Set(candidates.map((candidate) => candidate.sourceId));
    const memoryBefore = runtime.service
      .listMemoryDrafts(selected.project.id)
      .map((draft) => `${draft.id}:${draft.status}`)
      .sort();
    const artifactsBefore = new Map(
      (await listArtifactFiles(projectPaths.artifacts)).map((file) => [
        file.relativePath,
        `${file.sizeBytes}:${file.updatedAt}`
      ])
    );

    reportStage(
      `继续项目“${selected.project.name}”的Session“${session.title}”，题库资料${selected.resources.length}份`
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("个性化学习业务测试超时"), timeoutMs);
    timer.unref?.();
    try {
      const result = await runtime.service.sendMessage({
        sessionId: session.sessionId,
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
    const docx = changedArtifacts.find((file) => file.name === `${artifactStem}.docx`);
    const pdf = changedArtifacts.find((file) => file.name === `${artifactStem}.pdf`);
    assert.ok(docx, `没有生成指定DOCX：${artifactStem}.docx`);
    assert.ok(pdf, `没有生成指定PDF：${artifactStem}.pdf`);

    const docxPath = await resolveArtifactFile(projectPaths.artifacts, docx.relativePath);
    const pdfPath = await resolveArtifactFile(projectPaths.artifacts, pdf.relativePath);
    const docxPreview = await loadFilePreview(docxPath, docx.name);
    const pdfPreview = await loadFilePreview(pdfPath, pdf.name);
    assert.equal(docxPreview.kind, "html", "DOCX没有通过桌面端预览转换");
    assert.equal(pdfPreview.kind, "pdf", "PDF没有通过桌面端预览加载");
    const docxText = await extractDocxText(docxPath);
    const docxContainsMedia = await docxHasEmbeddedMedia(docxPath);
    const pdfText = await extractPdfText(pdfPath);
    assert.equal((await readFile(pdfPath)).subarray(0, 5).toString("ascii"), "%PDF-");
    assert.match(pdfText, /S01/, "PDF中没有可读取的匿名编号S01");
    assert.match(pdfText, /学习路径/, "PDF中没有可读取的中文学习路径");

    const memoryAfter = runtime.service
      .listMemoryDrafts(selected.project.id)
      .map((draft) => `${draft.id}:${draft.status}`)
      .sort();
    assert.deepEqual(memoryAfter, memoryBefore, "模型未经教师确认就创建或改写了长期记忆草稿");
    const assertions = evaluatePersonalizedResult({
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
      sessionId: session.sessionId,
      resourceCount: selected.resources.length,
      candidateCount: candidates.length,
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
          session: session.title,
          resourceCount: selected.resources.length,
          candidateCount: candidates.length,
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
      `[个性化学习业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    runtime?.close();
    app.exit(process.exitCode || 0);
  }
}

if (process.env.MAGI_TEACHER_PERSONALIZED_ASSERTIONS_ONLY !== "1") {
  await runLivePersonalizedEval();
}

export function evaluatePersonalizedResult({
  message,
  docxText,
  docxContainsMedia,
  allowedSourceIds,
  artifactStem: expectedStem
}) {
  assert.match(message, new RegExp(escapeRegExp(`${expectedStem}.docx`)), "聊天缺少DOCX文件名");
  assert.match(message, new RegExp(escapeRegExp(`${expectedStem}.pdf`)), "聊天缺少PDF文件名");
  assert.match(
    message,
    /3\s*名匿名|三\s*名匿名|S01[^\n]{0,40}S02[^\n]{0,40}S03/,
    "聊天未确认3名匿名对象"
  );
  assert.match(message, /7\s*天|一周/, "聊天未确认7天周期");
  assert.match(
    message,
    /5\s*(?:道|题)[^\n]{0,20}原题|原题[^\n]{0,20}5\s*(?:道|题)|5\s*\/\s*5/,
    "聊天未说明5道原题"
  );
  assert.match(
    message,
    /未(?:自动|直接)?写入[^\n]{0,20}(?:长期)?记忆|不写入[^\n]{0,20}(?:长期)?记忆/,
    "聊天未说明记忆未自动写入"
  );
  assert.ok(message.length < 1_600, "聊天回复过长，疑似粘贴完整学习路径");

  assert.match(docxText, /数据范围|隐私边界|证据表|数据事实/, "缺少数据与隐私边界");
  for (const id of ["S01", "S02", "S03"]) assert.match(docxText, new RegExp(id), `缺少${id}`);
  assert.match(
    docxText,
    /S01[\s\S]{0,1200}2\s*\/\s*3[\s\S]{0,1200}3\s*\/\s*3[\s\S]{0,1200}1\s*\/\s*3/,
    "S01证据不完整"
  );
  assert.match(
    docxText,
    /S02[\s\S]{0,1200}3\s*\/\s*3[\s\S]{0,1200}1\s*\/\s*2[\s\S]{0,1200}(?:分子分母|分母)[^\n]{0,30}(?:写反|颠倒)[\s\S]{0,1200}2\s*\/\s*2/,
    "S02证据不完整"
  );
  assert.match(
    docxText,
    /S03[\s\S]{0,1200}2\s*\/\s*3[\s\S]{0,1200}(?:只提交|完成)\s*2\s*\/\s*3[\s\S]{0,1200}(?:复测未完成|缺测|未参加复测)/,
    "S03缺交缺测证据不完整"
  );
  assert.doesNotMatch(
    docxText,
    /S0[123][^\n]{0,40}(?:是|属于|归为|列为|标签[：:]?)[^\n]{0,20}(?:学困生|差生|优秀生|后进生|能力差|低能力)/,
    "出现固定能力标签"
  );
  assert.doesNotMatch(docxText, /姓名[：:]|联系电话|家长电话|身份证/, "成果扩散了不必要的个人信息");

  const s01 = personalizedSection(docxText, "S01", "S02");
  const s02 = personalizedSection(docxText, "S02", "S03");
  const s03 = personalizedSection(docxText, "S03", undefined);
  for (const [id, section] of [
    ["S01", s01],
    ["S02", s02],
    ["S03", s03]
  ]) {
    assert.ok(section.length > 400, `${id}缺少独立学习路径`);
    for (let day = 1; day <= 7; day += 1) {
      assert.match(
        section,
        new RegExp(`第\\s*${day}\\s*天|Day\\s*${day}`, "i"),
        `${id}缺少第${day}天`
      );
    }
    assert.match(section, /分钟|预计用时|用时/, `${id}缺少每日用时`);
    assert.match(section, /学生产出|产出/, `${id}缺少学生产出`);
    assert.match(section, /教师观察|观察信号/, `${id}缺少教师观察信号`);
    assert.match(section, /完成标准/, `${id}缺少完成标准`);
    assert.doesNotMatch(section, /目标\s*3|近期目标[^\n]{0,20}3\s*个/, `${id}超过2个近期目标`);
  }
  assert.match(s01, /摩擦力|受力分析|过程表达/, "S01没有针对摩擦力过程表达");
  assert.match(s02, /实验|牛奶密度|密度表达式/, "S02没有针对浮力实验迁移");
  const s02Schedule = s02.match(/7\s*天逐日安排[\s\S]*?(?=短复测与调整规则)/)?.[0] ?? s02;
  assert.doesNotMatch(
    s02Schedule,
    /重做(?:全部|整套)?基础|基础巩固[^\n]{0,30}(?:全套|全部|3题)/,
    "S02被机械安排重做基础"
  );
  assert.match(
    s03,
    /先[^\n]{0,30}(?:补交|补测|补齐证据|收集证据)|证据不足|暂不判断/,
    "S03没有先补证据"
  );

  assert.match(docxText, /原题任务|原题[^\n]{0,20}来源表|任务来源表/, "缺少原题任务来源表");
  const sourceIds = new Set(
    [...docxText.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi)].map((match) => match[0])
  );
  assert.ok(
    sourceIds.size >= Math.min(5, allowedSourceIds.size),
    `只识别到${sourceIds.size}个原题资料ID`
  );
  for (const sourceId of sourceIds) {
    assert.ok(allowedSourceIds.has(sourceId), `使用了候选包之外的资料ID：${sourceId}`);
  }
  assert.match(docxText, /分配理由|匹配理由|适用目标/, "原题来源表缺少分配理由");
  const referencesFigure =
    /(?:如|见|根据|观察|分析)(?:下|右|左|上)?(?:图|图示|示意图)|(?:下|右|左)图|图中|装置图(?:所示)?|电路图(?:所示)?/.test(
      docxText
    );
  assert.ok(!referencesFigure || docxContainsMedia, "任务引用图示但DOCX没有图片");

  assert.match(docxText, /达到[\s\S]{0,300}部分达到[\s\S]{0,300}未达到/, "缺少三档调整规则");
  assert.match(docxText, /教师跟踪|跟踪记录|观察记录|教师观察信号/, "缺少教师跟踪记录");
  assert.match(docxText, /待教师确认/, "缺少教师确认项");
  assert.match(docxText, /待教师确认的记忆草稿|记忆草稿/, "缺少可审核的记忆草稿");
  const memoryDraft = docxText.match(/待教师确认的记忆草稿[\s\S]*$/)?.[0] ?? "";
  assert.match(
    memoryDraft,
    /S01[\s\S]{0,1000}(?:连续|多次|三次)[\s\S]{0,1000}(?:教师确认|待确认|待[^\n]{0,30}再定稿)/,
    "S01记忆候选缺少连续证据或确认边界"
  );
  assert.match(
    memoryDraft,
    /S02[\s\S]{0,1200}暂不[^\n]{0,30}(?:长期记忆|进入记忆|写入记忆)/,
    "S02单次错误被过早写入记忆"
  );
  assert.match(
    memoryDraft,
    /S03[\s\S]{0,1200}暂不[^\n]{0,30}(?:长期记忆|进入记忆|写入记忆)/,
    "S03缺测被过早写入记忆"
  );

  return [
    "三名匿名学生的连续证据逐项保留",
    "每人最多两个目标并形成独立7天路径",
    "S01、S02、S03按不同证据采取不同下一步",
    "候选包5道纯文字原题全部可追溯",
    "每日任务含用时、产出、观察信号和完成标准",
    "短复测包含达到、部分达到、未达到调整规则",
    "长期记忆只生成待教师确认草稿且未自动写入",
    "生成可预览DOCX与中文可读PDF"
  ];
}

function personalizedSection(text, id, nextId) {
  const heading = new RegExp(`${id}[^\\n]{0,40}(?:7\\s*天|一周|学习路径)`, "i");
  const start = text.search(heading);
  if (start < 0) return "";
  if (!nextId) return text.slice(start);
  const nextHeading = new RegExp(`${nextId}[^\\n]{0,40}(?:7\\s*天|一周|学习路径)`, "i");
  const relativeEnd = text.slice(start + 1).search(nextHeading);
  return relativeEnd < 0 ? text.slice(start) : text.slice(start, start + 1 + relativeEnd);
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
  throw new Error("没有可用的pdftotext，无法验证PDF中文内容");
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
  process.stdout.write(`[个性化学习业务测试] ${message}\n`);
}
