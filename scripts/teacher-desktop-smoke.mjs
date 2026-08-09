import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

import { collectTeachingMaterialFiles } from "../desktop/material-import.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "magi-teacher-desktop-smoke-"));
const providerRequests = [];
const markdownResponse = [
  "## 模型接口联调成功",
  "",
  "**1. 长期记忆（跨会话）**",
  "",
  "- 教师偏好",
  "- 已确认的教学结论",
  "",
  "| 记忆层级 | 用途 |",
  "| --- | --- |",
  "| 长期记忆 | 跨会话调用 |",
  "",
  "`config.yaml` 不保存 API Key。",
  "",
  "交付文件：`artifacts/课堂练习.md`",
  "",
  "<img src=x onerror=alert(1)>"
].join("\n");
const providerServer = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  providerRequests.push({
    url: request.url,
    authorization: request.headers.authorization,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: markdownResponse } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 }
    })
  );
});
await new Promise((resolve, reject) => {
  providerServer.once("error", reject);
  providerServer.listen(0, "127.0.0.1", () => {
    providerServer.off("error", reject);
    resolve();
  });
});
const providerAddress = providerServer.address();
const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
let electronApp;
let page;
const pageErrors = [];
const consoleMessages = [];

try {
  const folderFixture = path.join(temporaryRoot, "folder-fixture");
  await mkdir(path.join(folderFixture, "教材", "章节"), { recursive: true });
  await writeFile(path.join(folderFixture, "教材", "章节", "牛顿定律.md"), "# 牛顿定律");
  await writeFile(path.join(folderFixture, "教材", "忽略.tmp"), "ignored");
  await writeFile(path.join(folderFixture, ".hidden.csv"), "hidden");
  const folderSelection = await collectTeachingMaterialFiles([folderFixture], "folder");
  assert.equal(folderSelection.files.length, 1);
  assert.match(folderSelection.files[0].importPath, /folder-fixture\/教材\/章节\/牛顿定律\.md/);
  assert.equal(folderSelection.skippedUnsupported, 1);

  electronApp = await electron.launch({
    args: [path.join(repositoryRoot, "desktop/main.mjs")],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: path.join(temporaryRoot, "magi"),
      MAGI_TEACHER_CONFIG_DIR: path.join(temporaryRoot, "physics-teacher")
    }
  });

  page = await electronApp.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  await page.locator("#connection-label").waitFor({ state: "visible" });
  await page.locator("#permission-scope-button").waitFor({ state: "visible" });
  assert.equal(await page.locator("#permission-scope-label").textContent(), "项目内读写");
  assert.match(
    (await page.locator("#permission-scope-button").getAttribute("title")) || "",
    /artifacts/
  );
  await page.locator("#project-dialog[open]").waitFor();
  await page.locator('#project-form input[name="name"]').fill("高一三班物理");
  await page.locator('#project-form input[name="grade"]').fill("高一");
  await page.locator('#project-form input[name="className"]').fill("3班");
  await page.locator('#project-form input[name="textbookVersion"]').fill("人教版必修第一册");
  await page.locator('#project-form button[type="submit"]').click();
  await waitForSelectedProject(page, "高一三班物理");
  assert.equal(await page.locator("#connection-label").textContent(), "本地服务已连接");
  await page.locator("#close-inspector-button").click();
  await page.waitForFunction(
    () => !document.querySelector("#app")?.classList.contains("inspector-open")
  );
  assert.equal(await page.locator("#inspector").isHidden(), true);
  await page.locator("#toggle-inspector-button").click();
  await page.locator("#inspector.open").waitFor({ state: "visible" });
  await page.locator("#permission-scope-button").click();
  await page.locator("#permission-scope-menu").waitFor({ state: "visible" });
  assert.equal(await page.locator(".permission-menu-item").count(), 3);
  await page.locator('[data-permission-scope="approval"]').click();
  assert.equal(await page.locator("#permission-scope-label").textContent(), "操作前询问");
  await page.locator("#permission-scope-button").click();
  await page.locator('[data-permission-scope="project-write"]').click();
  assert.equal(await page.locator("#permission-scope-label").textContent(), "项目内读写");
  await page.locator("#resource-onboarding").waitFor({ state: "visible" });
  await page.locator("#quick-folder-upload-button").waitFor({ state: "visible" });
  assert.equal(await page.locator("#resource-count-badge").textContent(), "0");
  assert.match((await page.locator("#resource-onboarding").textContent()) || "", /基础资料/);
  if (process.env.MAGI_TEACHER_DESKTOP_ONBOARDING_SCREENSHOT) {
    await page.screenshot({
      path: process.env.MAGI_TEACHER_DESKTOP_ONBOARDING_SCREENSHOT,
      fullPage: true
    });
  }

  await page.locator("#new-session-button").click();
  await page.locator('#session-form input[name="title"]').fill("期中考试分析");
  await page.locator('#session-form select[name="kind"]').selectOption("exam-analysis");
  await page.locator('#session-form button[type="submit"]').click();
  await page.locator("#session-title").filter({ hasText: "期中考试分析" }).waitFor();
  await page.locator("#attach-message-button").waitFor({ state: "visible" });
  assert.match(
    (await page.locator("#attach-message-button").getAttribute("aria-label")) || "",
    /仅用于本次对话/
  );

  await page.locator("#composer-input").fill("先帮我梳理这次考试分析需要哪些材料");
  await page.locator("#send-button").click();
  const noProviderMessage = page
    .locator(".message.assistant")
    .filter({ hasText: "No provider is configured" });
  await noProviderMessage.waitFor();
  assert.match((await noProviderMessage.textContent()) || "", /No provider is configured/);

  await page.locator("#model-settings-button").click();
  await page.locator("#model-settings-dialog[open]").waitFor();
  await page.locator('#model-settings-form input[name="baseUrl"]').fill(providerBaseUrl);
  await page.locator('#model-settings-form input[name="apiKey"]').fill("desktop-test-key");
  await page.locator('#model-settings-form input[name="model"]').fill("physics-test-model");
  await page.locator('#model-settings-form button[type="submit"]').click();
  await page
    .locator("#model-settings-status")
    .filter({ hasText: "已配置 · physics-test-model" })
    .waitFor();
  const modelSettings = await page.evaluate(() => window.physicsTeacherDesktop.getModelSettings());
  assert.deepEqual(modelSettings, {
    baseUrl: providerBaseUrl,
    model: "physics-test-model",
    hasApiKey: true
  });
  assert.equal(Object.hasOwn(modelSettings, "apiKey"), false);

  const previewProjectId = await page.evaluate(async () => {
    const projects = await window.physicsTeacherDesktop.request({
      method: "GET",
      path: "/api/projects"
    });
    return projects.data.projects[0].id;
  });
  const previewArtifactDirectory = path.join(
    temporaryRoot,
    "physics-teacher",
    "projects",
    previewProjectId,
    "artifacts"
  );
  await mkdir(previewArtifactDirectory, { recursive: true });
  await writeFile(
    path.join(previewArtifactDirectory, "课堂练习.md"),
    "# 课堂练习\n\n这是可在 Magi 内直接预览的交付文件。\n"
  );

  await page.locator("#composer-input").fill("请回复模型接口联调成功，**教师原文保持文本**");
  await page.locator("#send-button").click();
  const markdownMessage = page
    .locator(".message.assistant")
    .filter({ hasText: "模型接口联调成功" });
  await markdownMessage.waitFor();
  assert.equal(await markdownMessage.locator("h2").textContent(), "模型接口联调成功");
  assert.equal(
    await markdownMessage.locator(".markdown-body p strong").first().textContent(),
    "1. 长期记忆（跨会话）"
  );
  assert.equal(await markdownMessage.locator("ul li").count(), 2);
  assert.equal(await markdownMessage.locator("table tbody tr").count(), 1);
  assert.equal(await markdownMessage.locator("code").first().textContent(), "config.yaml");
  assert.equal(await markdownMessage.locator(".markdown-body img").count(), 0);
  assert.equal((await markdownMessage.textContent()).includes("**1."), false);
  const artifactCard = markdownMessage.locator(".artifact-card").filter({ hasText: "课堂练习.md" });
  await artifactCard.waitFor();
  await artifactCard.getByRole("button", { name: "预览" }).click();
  await page.locator("#artifact-preview-dialog[open]").waitFor();
  assert.equal(await page.locator("#artifact-preview-body h1").textContent(), "课堂练习");
  await page.locator("#artifact-preview-close-button").click();
  await page.locator("#artifact-preview-dialog").waitFor({ state: "hidden" });
  const userBody = page.locator(".message.user .message-body").last();
  assert.equal(await userBody.locator("strong").count(), 0);
  assert.match((await userBody.textContent()) || "", /\*\*教师原文保持文本\*\*/);
  const userMessageBox = await page.locator(".message.user").last().boundingBox();
  const assistantMessageBox = await page.locator(".message.assistant").last().boundingBox();
  assert.ok(userMessageBox.x > assistantMessageBox.x, "teacher messages should align right");
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].url, "/v1/chat/completions");
  assert.equal(providerRequests[0].authorization, "Bearer desktop-test-key");
  assert.equal(providerRequests[0].body.model, "physics-test-model");
  assert.match(JSON.stringify(providerRequests[0].body), /项目内读写/);

  const oneTurnAttachment = await page.evaluate(async () => {
    const projects = await window.physicsTeacherDesktop.request({
      method: "GET",
      path: "/api/projects"
    });
    const projectId = projects.data.projects[0].id;
    const sessions = await window.physicsTeacherDesktop.request({
      method: "GET",
      path: `/api/projects/${projectId}/sessions`
    });
    const response = await window.physicsTeacherDesktop.sendMessageWithAttachments({
      sessionId: sessions.data.sessions[0].sessionId,
      prompt: "只处理这次随堂测验",
      files: [
        {
          name: "随堂测验.csv",
          contentType: "text/csv",
          bytes: Array.from(new TextEncoder().encode("student,score\n李同学,76\n"))
        }
      ]
    });
    const resources = await window.physicsTeacherDesktop.request({
      method: "GET",
      path: `/api/projects/${projectId}/resources`
    });
    return { response, resources: resources.data.resources };
  });
  assert.equal(oneTurnAttachment.response.result.message, markdownResponse);
  assert.equal(oneTurnAttachment.resources.length, 0);
  assert.equal(providerRequests.length, 2);
  assert.match(JSON.stringify(providerRequests[1].body), /本次对话临时资料/);
  assert.match(JSON.stringify(providerRequests[1].body), /随堂测验\.csv/);

  const connectedData = await page.evaluate(async () => {
    const projects = await window.physicsTeacherDesktop.request({
      method: "GET",
      path: "/api/projects"
    });
    const projectId = projects.data.projects[0].id;
    const upload = await window.physicsTeacherDesktop.request({
      method: "POST",
      path: `/api/projects/${projectId}/resources/upload?filename=${encodeURIComponent("期中成绩.csv")}`,
      bytes: Array.from(new TextEncoder().encode("student,score\n张同学,82\n")),
      contentType: "text/csv"
    });
    const memory = await window.physicsTeacherDesktop.request({
      method: "POST",
      path: `/api/projects/${projectId}/memory/drafts`,
      json: {
        category: "project",
        content: "本班受力分析需要重点复习。",
        reason: "桌面端联调"
      }
    });
    return { projectId, upload, memory };
  });
  assert.equal(connectedData.upload.status, 201);
  assert.equal(connectedData.memory.status, 201);

  await page.reload();
  await waitForSelectedProject(page, "高一三班物理");
  await page.locator(".resource-card").filter({ hasText: "期中成绩.csv" }).waitFor();
  assert.equal(await page.locator("#resource-count-badge").textContent(), "1");
  assert.equal(await page.locator("#resource-onboarding").isHidden(), true);
  assert.match((await page.locator("#wiki-summary").textContent()) || "", /已整理 1 份资料/);
  assert.match((await page.locator("#wiki-category-list").textContent()) || "", /成绩与学情 1/);
  const uploadedResourceCard = page.locator(".resource-card").filter({ hasText: "期中成绩.csv" });
  await uploadedResourceCard.getByRole("button", { name: "预览" }).click();
  await page.locator("#artifact-preview-dialog[open]").waitFor();
  assert.match((await page.locator("#artifact-preview-body").textContent()) || "", /张同学,82/);
  await page.locator("#artifact-preview-close-button").click();
  await page.locator('.inspector-tab[data-tab="memory"]').click();
  await page.locator(".memory-card").filter({ hasText: "受力分析需要重点复习" }).waitFor();
  await page.locator(".memory-card .approve").click();
  await page.locator("#memory-draft-list").filter({ hasText: "当前没有待确认的记忆" }).waitFor();
  await page.locator('.inspector-tab[data-tab="resources"]').click();

  assert.deepEqual(pageErrors, []);
  if (process.env.MAGI_TEACHER_DESKTOP_SCREENSHOT) {
    await page.locator("#permission-scope-button").click();
    await page.locator("#permission-scope-menu").waitFor({ state: "visible" });
    await page.screenshot({ path: process.env.MAGI_TEACHER_DESKTOP_SCREENSHOT, fullPage: true });
  }
  process.stdout.write(
    "Desktop smoke passed: inspector close, generated-file previews, uploaded-resource previews, folder scanning, project Wiki, chat attachments, model settings, resources, and memory review are connected.\n"
  );
} catch (error) {
  if (page && !page.isClosed()) {
    process.stderr.write(`Desktop text at failure:\n${await page.locator("body").innerText()}\n`);
  }
  if (pageErrors.length > 0) {
    process.stderr.write(`Page errors:\n${pageErrors.map(String).join("\n")}\n`);
  }
  if (consoleMessages.length > 0) {
    process.stderr.write(`Console messages:\n${consoleMessages.join("\n")}\n`);
  }
  throw error;
} finally {
  await electronApp?.close();
  await new Promise((resolve) => providerServer.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function waitForSelectedProject(page, name) {
  await page.waitForFunction(
    (expectedName) =>
      document.querySelector("#project-select")?.selectedOptions[0]?.textContent === expectedName,
    name
  );
}
