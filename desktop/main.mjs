import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";

import { loadConfig } from "../dist/config.js";
import {
  normalizePhysicsTeacherModelSettings,
  PHYSICS_TEACHER_OPENAI_KEY_ENV,
  readPhysicsTeacherModelSettings,
  writePhysicsTeacherModelSettings
} from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";
import { startPhysicsTeacherHttpServer } from "../dist/physics-teacher/server.js";
import { getPhysicsTeacherProjectPaths } from "../dist/physics-teacher/paths.js";
import { listArtifactFiles, loadFilePreview, resolveArtifactFile } from "./artifact-preview.mjs";
import { collectTeachingMaterialFiles } from "./material-import.mjs";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const appIcon = path.join(desktopRoot, "assets", "app-icon.png");
process.env.MAGI_SQLITE_DRIVER = "builtin";
let mainWindow;
let backend;
let runtime;
let desktopEnv;
let quitting = false;

async function startDesktopBackend() {
  const token = randomBytes(32).toString("base64url");
  desktopEnv = {
    ...process.env,
    MAGI_TEACHER_API_TOKEN: token,
    MAGI_TEACHER_BIND: "127.0.0.1"
  };
  runtime = createPhysicsTeacherRuntime(desktopEnv);
  runtime.service.setApprovalResolver((request) => requestDesktopApproval(request));
  const storedApiKey = await readStoredApiKey(runtime.magiPaths.root);
  if (storedApiKey) desktopEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV] = storedApiKey;
  backend = await startPhysicsTeacherHttpServer(runtime.service, {
    env: desktopEnv,
    bind: "127.0.0.1",
    port: 0
  });
  return {
    baseUrl: `http://${backend.bind}:${backend.port}`,
    token
  };
}

function registerDesktopBridge(connection) {
  ipcMain.handle("physics-teacher:request", async (_event, request) => {
    const method = request?.method === "POST" ? "POST" : "GET";
    const requestPath = typeof request?.path === "string" ? request.path : "";
    const [rawPathname] = requestPath.split("?", 1);
    let decodedPathname;
    try {
      decodedPathname = decodeURIComponent(rawPathname);
    } catch {
      throw new Error("接口路径无效");
    }
    if (
      (!requestPath.startsWith("/api/") && requestPath !== "/health") ||
      decodedPathname.split("/").includes("..")
    ) {
      throw new Error("桌面端拒绝访问非教学接口");
    }
    const url = new URL(requestPath, connection.baseUrl);
    if (url.origin !== connection.baseUrl) {
      throw new Error("接口路径无效");
    }
    const headers = { authorization: `Bearer ${connection.token}` };
    let body;
    if (request?.bytes) {
      body = Buffer.from(request.bytes);
      headers["content-type"] = request.contentType || "application/octet-stream";
    } else if (request?.json !== undefined) {
      body = JSON.stringify(request.json);
      headers["content-type"] = "application/json";
    }
    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text || `HTTP ${response.status}` };
    }
    return { ok: response.ok, status: response.status, data };
  });

  ipcMain.handle("physics-teacher:import-project-materials", async (event, input) => {
    const mode = input?.mode === "folder" ? "folder" : "files";
    const projectId = typeof input?.projectId === "string" ? input.projectId : "";
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mode === "folder" ? "选择教学资料文件夹" : "选择项目基础资料",
      properties: mode === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
      filters: mode === "folder" ? undefined : teachingMaterialFilters()
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const selection = await collectTeachingMaterialFiles(result.filePaths, mode);
    if (selection.files.length === 0) throw new Error("所选位置没有可导入的教学资料");
    const imported = await runtime.service.uploadResources({
      projectId,
      resources: readMaterialUploads(selection.files, mode, (progress) => {
        event.sender.send("physics-teacher:material-import-progress", progress);
      })
    });
    return {
      canceled: false,
      addedCount: imported.added.length,
      duplicateCount: imported.duplicateCount,
      skippedUnsupported: selection.skippedUnsupported,
      skippedOversized: selection.skippedOversized,
      wiki: imported.wiki
    };
  });

  ipcMain.handle("physics-teacher:choose-message-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择本次对话要处理的资料",
      properties: ["openFile", "multiSelections"],
      filters: teachingMaterialFilters()
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    if (result.filePaths.length > 5) throw new Error("每次对话最多选择 5 份资料");
    const sizes = await Promise.all(result.filePaths.map((filePath) => stat(filePath)));
    const totalBytes = sizes.reduce((sum, value) => sum + value.size, 0);
    if (totalBytes > 32 * 1024 * 1024) throw new Error("本次对话资料总大小不能超过 32 MB");
    return await Promise.all(
      result.filePaths.map(async (filePath) => ({
        name: path.basename(filePath),
        contentType: contentTypeFor(filePath),
        sizeBytes: (await stat(filePath)).size,
        bytes: await readFile(filePath)
      }))
    );
  });

  ipcMain.handle("physics-teacher:send-message-with-attachments", async (_event, input) => {
    const files = Array.isArray(input?.files) ? input.files : [];
    const result = await runtime.service.sendMessage({
      sessionId: typeof input?.sessionId === "string" ? input.sessionId : "",
      prompt: typeof input?.prompt === "string" ? input.prompt : "",
      resourceQuery: typeof input?.prompt === "string" ? input.prompt : undefined,
      permissionScope: normalizePermissionScope(input?.permissionScope),
      attachments: files.map((file) => ({
        filename: typeof file?.name === "string" ? file.name : "attachment",
        mimeType: typeof file?.contentType === "string" ? file.contentType : undefined,
        body: Buffer.from(file?.bytes ?? [])
      }))
    });
    return { result };
  });

  ipcMain.handle("physics-teacher:get-model-settings", () => {
    const settings = readPhysicsTeacherModelSettings(runtime.magiPaths, desktopEnv);
    return {
      baseUrl: settings?.baseUrl ?? "https://api.openai.com/v1",
      model: settings?.model ?? "",
      hasApiKey: Boolean(desktopEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV])
    };
  });

  ipcMain.handle("physics-teacher:save-model-settings", async (_event, input) => {
    const settings = normalizePhysicsTeacherModelSettings({
      baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl : "",
      model: typeof input?.model === "string" ? input.model : ""
    });
    const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey && !desktopEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV]) {
      throw new Error("首次配置必须填写 API Key");
    }
    if (apiKey) {
      await writeStoredApiKey(runtime.magiPaths.root, apiKey);
      desktopEnv[PHYSICS_TEACHER_OPENAI_KEY_ENV] = apiKey;
    }
    writePhysicsTeacherModelSettings({
      paths: runtime.magiPaths,
      baseUrl: settings.baseUrl,
      model: settings.model,
      env: desktopEnv
    });
    runtime.service.updateConfig(loadConfig(runtime.magiPaths, desktopEnv));
    return { ...settings, hasApiKey: true };
  });

  ipcMain.handle("physics-teacher:open-external", async (_event, rawUrl) => {
    let url;
    try {
      url = new URL(typeof rawUrl === "string" ? rawUrl : "");
    } catch {
      throw new Error("链接地址无效");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("桌面端只允许打开 HTTP 或 HTTPS 链接");
    }
    await shell.openExternal(url.toString());
    return true;
  });

  ipcMain.handle("physics-teacher:list-artifacts", async (_event, rawProjectId) => {
    const projectId = requireProjectId(rawProjectId);
    runtime.service.getProject(projectId);
    const projectPaths = getPhysicsTeacherProjectPaths(runtime.paths, projectId);
    return listArtifactFiles(projectPaths.artifacts);
  });

  ipcMain.handle("physics-teacher:preview-project-file", async (_event, input) => {
    const file = await resolveProjectFile(input);
    return loadFilePreview(file.filePath, file.displayName);
  });

  ipcMain.handle("physics-teacher:open-project-file", async (_event, input) => {
    const file = await resolveProjectFile(input);
    const error = await shell.openPath(file.filePath);
    if (error) throw new Error(`无法打开文件：${error}`);
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#f4f3ef",
    title: "Magi 教师助手",
    icon: appIcon,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(desktopRoot, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(desktopRoot, "index.html"));
  if (process.platform === "darwin") app.dock?.setIcon(appIcon);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.once("closed", () => {
    mainWindow = undefined;
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

async function shutdown() {
  if (backend?.server.listening) {
    await new Promise((resolve) => backend.server.close(resolve));
  }
  backend = undefined;
  runtime?.close();
  runtime = undefined;
}

app
  .whenReady()
  .then(async () => {
    const connection = await startDesktopBackend();
    registerDesktopBridge(connection);
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox(
      "Magi 教师助手启动失败",
      error instanceof Error ? error.message : String(error)
    );
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting || (!backend && !runtime)) return;
  quitting = true;
  event.preventDefault();
  void shutdown().finally(() => app.exit(0));
});

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".csv": "text/csv",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".ppt": "application/vnd.ms-powerpoint",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg"
    }[extension] || "application/octet-stream"
  );
}

function teachingMaterialFilters() {
  return [
    {
      name: "教学资料",
      extensions: [
        "xlsx",
        "xls",
        "csv",
        "pdf",
        "docx",
        "doc",
        "pptx",
        "ppt",
        "txt",
        "md",
        "json",
        "png",
        "jpg",
        "jpeg"
      ]
    },
    { name: "全部文件", extensions: ["*"] }
  ];
}

async function requestDesktopApproval(request) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const target =
    request.toolUse?.input?.file_path ??
    request.toolUse?.input?.command ??
    request.toolUse?.input?.url ??
    "当前项目";
  const detail = [
    `操作：${approvalToolLabel(request.toolUse?.name)}`,
    `目标：${String(target).slice(0, 500)}`,
    request.reason ? `原因：${request.reason}` : undefined,
    request.diff ? `\n变更预览：\n${request.diff.slice(0, 4_000)}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Magi 请求操作权限",
    message: "允许 Magi 执行这次操作吗？",
    detail,
    buttons: ["允许一次", "拒绝"],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  return result.response === 0;
}

function approvalToolLabel(name) {
  return (
    {
      FileWrite: "写入文件",
      FileEdit: "编辑文件",
      FilePatch: "修改文件",
      NotebookEdit: "编辑笔记本",
      Bash: "运行命令",
      GitStage: "暂存 Git 变更"
    }[name] ||
    name ||
    "项目操作"
  );
}

function normalizePermissionScope(value) {
  return value === "read-only" || value === "approval" ? value : "project-write";
}

async function resolveProjectFile(input) {
  const projectId = requireProjectId(input?.projectId);
  const project = runtime.service.getProject(projectId);
  if (input?.source === "resource") {
    const resourceId = typeof input?.resourceId === "string" ? input.resourceId : "";
    const resource = runtime.service
      .listResources(projectId)
      .find((item) => item.id === resourceId);
    if (!resource?.storagePath) throw new Error("这份资料没有可在本机打开的源文件");
    const filePath = path.resolve(resource.storagePath);
    assertInsideProject(project.rootDir, filePath);
    await stat(filePath);
    return {
      filePath,
      displayName: resource.originalFilename || resource.title || path.basename(filePath)
    };
  }
  const projectPaths = getPhysicsTeacherProjectPaths(runtime.paths, projectId);
  const relativePath = typeof input?.relativePath === "string" ? input.relativePath : "";
  return {
    filePath: await resolveArtifactFile(projectPaths.artifacts, relativePath),
    displayName: path.basename(relativePath)
  };
}

function requireProjectId(value) {
  const projectId = typeof value === "string" ? value.trim() : "";
  if (!projectId) throw new Error("教学项目无效");
  return projectId;
}

function assertInsideProject(projectRoot, candidate) {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("文件路径超出当前教学项目");
  }
}

async function* readMaterialUploads(files, mode, onProgress) {
  for (const [index, file] of files.entries()) {
    onProgress({
      phase: "files",
      current: index + 1,
      total: files.length,
      filename: file.filename
    });
    yield {
      filename: file.filename,
      body: await readFile(file.filePath),
      mimeType: contentTypeFor(file.filePath),
      metadata: {
        importPath: file.importPath,
        importedFrom: mode
      }
    };
  }
  onProgress({ phase: "wiki", current: files.length, total: files.length });
}

function secretFile(root) {
  return path.join(root, "desktop", "openai-api-key.enc");
}

async function readStoredApiKey(root) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const encrypted = await readFile(secretFile(root));
    return safeStorage.decryptString(encrypted).trim() || undefined;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      process.stderr.write(
        `无法读取已保存的模型密钥：${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    return undefined;
  }
}

async function writeStoredApiKey(root, apiKey) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法使用安全密钥存储，请先启用系统钥匙串");
  }
  const file = secretFile(root);
  const temporaryFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporaryFile, safeStorage.encryptString(apiKey), { mode: 0o600 });
  await rename(temporaryFile, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // Best effort on shared or mounted filesystems.
  }
}
