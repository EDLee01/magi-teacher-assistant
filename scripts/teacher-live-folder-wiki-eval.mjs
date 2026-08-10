import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, safeStorage } from "electron";

import { collectTeachingMaterialFiles } from "../desktop/material-import.mjs";
import { PHYSICS_TEACHER_OPENAI_KEY_ENV } from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.MAGI_SQLITE_DRIVER = "builtin";
const reportPath = path.join(repositoryRoot, ".magi-reports", "teacher-live-folder-wiki-eval.json");
const folderPath = path.resolve(requireEnvironment("MAGI_TEACHER_WIKI_EVAL_FOLDER"));
const modelAlias = process.env.MAGI_TEACHER_WIKI_EVAL_MODEL_ALIAS?.trim() || "physics-teacher";
const timeoutMs = Number(process.env.MAGI_TEACHER_WIKI_EVAL_TIMEOUT_MS) || 240_000;
const startedAt = new Date().toISOString();
let runtime;
let selectedProject;
let importSummary;
let sessionId;
let answer = "";

try {
  assert.equal((await stat(folderPath)).isDirectory(), true, "测试路径不是文件夹");
  const magiRoot = process.env.MAGI_CONFIG_DIR
    ? path.resolve(process.env.MAGI_CONFIG_DIR)
    : path.join(os.homedir(), ".magi-next");
  const runtimeEnv = {
    ...(await readPrivateProviderEnv(path.join(magiRoot, "provider.env"))),
    ...process.env,
    MAGI_SQLITE_DRIVER: "builtin"
  };
  if (modelAlias === "physics-teacher") {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
    const encryptedKey = await readFile(path.join(magiRoot, "desktop", "openai-api-key.enc"));
    const apiKey = safeStorage.decryptString(encryptedKey).trim();
    if (!apiKey) throw new Error("已保存的模型密钥为空");
    runtimeEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV] = apiKey;
  }

  runtime = createPhysicsTeacherRuntime(runtimeEnv);
  const selected = runtime.service
    .listProjects()
    .map((project) => ({ project, resources: runtime.service.listResources(project.id) }))
    .sort((left, right) => right.resources.length - left.resources.length)[0];
  if (!selected) throw new Error("没有可用于文件夹导入测试的教学项目");
  selectedProject = selected.project.name;
  const beforeCount = selected.resources.length;
  reportStage(`扫描真实资料文件夹，项目“${selectedProject}”当前有 ${beforeCount} 份资料`);
  const selection = await collectTeachingMaterialFiles([folderPath], "folder");
  assert.ok(selection.files.length >= 20, "真实文件夹样本过少，不能作为批量业务测试");
  assert.ok(selection.skippedTemporary > 0, "真实文件夹没有覆盖 Office 临时文件过滤场景");
  assert.ok(
    selection.files.every((file) => !file.filename.startsWith("~$")),
    "Office 临时文件仍进入了待导入队列"
  );

  const importStartedAt = Date.now();
  const imported = await runtime.service.uploadResources({
    projectId: selected.project.id,
    resources: readMaterialUploads(selection.files)
  });
  const afterResources = runtime.service.listResources(selected.project.id);
  const wiki = runtime.service.getKnowledgeWiki(selected.project.id);
  const importDurationMs = Date.now() - importStartedAt;
  assert.equal(
    imported.added.length + imported.duplicateCount,
    selection.files.length,
    "批量导入没有逐个登记新增或重复结果"
  );
  assert.ok(imported.duplicateCount > 0, "未验证到重复资料去重");
  assert.equal(afterResources.length, beforeCount + imported.added.length, "增量资料数量不一致");
  assert.equal(wiki.resourceCount, afterResources.length, "Wiki 资料数与项目资料数不一致");
  assert.equal(
    wiki.categories.reduce((sum, category) => sum + category.count, 0),
    wiki.resourceCount,
    "Wiki 分类数量之和不等于资料总数"
  );

  const projectPaths = runtime.service.projectPathsForExisting(selected.project.id);
  const indexText = await readFile(path.join(projectPaths.wiki, "INDEX.md"), "utf8");
  assert.match(indexText, new RegExp(`资料总数：${wiki.resourceCount}`));
  assert.match(indexText, /课标与教材/);
  assert.match(indexText, /年报与质量分析/);
  assert.match(indexText, /试卷与答案/);
  assert.match(indexText, /成绩与学情/);
  const sourceFiles = await readdir(path.join(projectPaths.wiki, "sources"));
  assert.equal(sourceFiles.length, wiki.resourceCount, "Wiki 来源页没有逐份覆盖项目资料");
  const privateMode = (await stat(path.join(projectPaths.wiki, "INDEX.md"))).mode & 0o777;
  assert.equal(privateMode & 0o077, 0, "Wiki 文件没有保持项目私有权限");

  const searchable = afterResources.filter((resource) => Boolean(resource.excerpt));
  assert.ok(searchable.length / afterResources.length >= 0.7, "可检索正文覆盖率低于70%");
  assert.ok(
    afterResources.some(
      (resource) =>
        resource.title.toLowerCase().endsWith(".pptx") &&
        /课程标准|核心素养/.test(resource.excerpt ?? "")
    ),
    "PPTX 课标课件没有进入可检索正文"
  );
  assert.ok(
    afterResources.some(
      (resource) => resource.title.toLowerCase().endsWith(".xlsx") && Boolean(resource.excerpt)
    ),
    "XLSX 成绩或统计表没有进入可检索正文"
  );

  const evidence = afterResources.find((resource) => resource.title === "负面知识清单.docx");
  assert.ok(evidence?.excerpt, "没有找到可用于问答核验的《负面知识清单》正文");
  const resourceQuery = "负面知识清单 滑动摩擦力 计算公式 牛顿第三定律 简单机械 浮力 压强 综合问题";
  const searchResult = await runtime.service.searchResources({
    projectId: selected.project.id,
    query: resourceQuery,
    limit: 8
  });
  assert.ok(
    searchResult.items.some((item) => item.id === evidence.id),
    "项目检索没有命中核验资料"
  );
  assert.ok(
    searchResult.items.every((item) => !item.title.startsWith("~$")),
    "项目检索仍返回 Office 临时文件"
  );

  const session = runtime.service.createSession({
    projectId: selected.project.id,
    title: `文件夹知识库业务测试 · ${new Date().toLocaleString("zh-CN")}`,
    kind: "lesson-planning"
  });
  sessionId = session.sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("文件夹知识库业务测试超时"), timeoutMs);
  timer.unref?.();
  try {
    const result = await runtime.service.sendMessage({
      sessionId,
      modelAlias,
      permissionScope: "read-only",
      resourceQuery,
      signal: controller.signal,
      prompt: [
        "请只根据项目基础资料《负面知识清单》回答：初中物理教学中，下面三项是否被材料列为超标内容？",
        "1. 滑动摩擦力的计算公式；2. 牛顿第三定律；3. 简单机械与浮力、压强的综合问题。",
        "逐项给出材料结论，不要补充材料外的政策解释。最后单独写出来源文件名和资料ID。"
      ].join("\n")
    });
    assert.equal(result.status, "completed", "新 Session 的知识库问答没有正常完成");
    answer = result.message;
  } finally {
    clearTimeout(timer);
  }
  assert.match(answer, /滑动摩擦力/);
  assert.match(answer, /牛顿第三定律/);
  assert.match(answer, /简单机械/);
  assert.match(answer, /浮力/);
  assert.match(answer, /压强/);
  assert.match(answer, /超标|列为|是/);
  assert.match(answer, /负面知识清单\.docx/);
  assert.match(answer, new RegExp(escapeRegExp(evidence.id)));

  const persisted = runtime.service.getSession(sessionId).session;
  assert.ok(
    persisted.messages.some(
      (message) =>
        message.role === "system" &&
        message.content.includes(evidence.id) &&
        message.content.includes("滑动摩擦力的计算公式")
    ),
    "新 Session 没有注入命中的项目资料正文"
  );
  assert.equal(
    persisted.messages.filter((message) => message.role === "assistant").at(-1)?.content,
    answer,
    "知识库回答没有持久化到当前 Session"
  );

  importSummary = {
    scannedCount: selection.files.length,
    addedCount: imported.added.length,
    duplicateCount: imported.duplicateCount,
    skippedUnsupported: selection.skippedUnsupported,
    skippedTemporary: selection.skippedTemporary,
    skippedOversized: selection.skippedOversized,
    beforeCount,
    afterCount: afterResources.length,
    searchableCount: searchable.length,
    importDurationMs
  };
  const report = {
    status: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    project: selectedProject,
    folder: path.basename(folderPath),
    sessionId,
    import: importSummary,
    wiki,
    evidence: { id: evidence.id, title: evidence.title },
    answer,
    assertions: [
      "真实文件夹批量扫描并过滤Office临时文件",
      "已有资料去重且新增资料增量导入",
      "Wiki分类目录与逐份来源页完整重建",
      "Wiki文件保持项目私有权限",
      "PPTX和XLSX进入可检索正文",
      "新Session检索到指定资料与正文证据",
      "模型回答逐项引用文件名和资料ID",
      "知识库回答持久化到项目Session"
    ]
  };
  await writeReport(report);
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
} catch (error) {
  await writeReport({
    status: "failed",
    startedAt,
    completedAt: new Date().toISOString(),
    project: selectedProject,
    folder: path.basename(folderPath),
    sessionId,
    import: importSummary,
    answer,
    error: error instanceof Error ? error.stack || error.message : String(error)
  });
  process.stderr.write(
    `[文件夹知识库业务测试] 失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  process.exitCode = 1;
} finally {
  runtime?.close();
  app.exit(process.exitCode || 0);
}

async function* readMaterialUploads(files) {
  for (const [index, file] of files.entries()) {
    if (index === 0 || (index + 1) % 25 === 0 || index + 1 === files.length) {
      reportStage(`导入 ${index + 1}/${files.length}：${file.filename}`);
    }
    yield {
      filename: file.filename,
      body: await readFile(file.filePath),
      mimeType: contentTypeFor(file.filePath),
      metadata: { importPath: file.importPath, importedFrom: "folder" }
    };
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  }[extension];
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

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeReport(report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function reportStage(message) {
  process.stderr.write(`[文件夹知识库业务测试] ${message}\n`);
}
