import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PREVIEW_BYTES = 48 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const PREVIEW_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".pdf",
  ".docx",
  ".doc",
  ".txt",
  ".csv",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);

export function canPreviewFilename(filename) {
  return PREVIEW_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export async function listArtifactFiles(artifactsRoot) {
  const root = path.resolve(artifactsRoot);
  const items = [];
  await walk(root, root, items, 0);
  return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function resolveArtifactFile(artifactsRoot, relativePath) {
  const root = path.resolve(artifactsRoot);
  const normalized = String(relativePath || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || !part)) {
    throw new Error("交付文件路径无效");
  }
  const filePath = path.resolve(root, normalized);
  assertInside(root, filePath);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("交付文件不存在");
  return filePath;
}

export async function loadFilePreview(filePath, displayName = path.basename(filePath)) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("文件不存在");
  if (fileStat.size > MAX_PREVIEW_BYTES) {
    throw new Error("文件超过 48 MB，请使用默认应用打开");
  }
  const extension = path.extname(displayName || filePath).toLowerCase();
  if (!canPreviewFilename(displayName || filePath)) {
    throw new Error("暂不支持预览这种文件，可使用默认应用打开");
  }
  const base = {
    name: displayName,
    extension,
    sizeBytes: fileStat.size,
    updatedAt: fileStat.mtime.toISOString()
  };

  if ([".md", ".markdown"].includes(extension)) {
    return { ...base, kind: "markdown", content: await readText(filePath, fileStat.size) };
  }
  if ([".html", ".htm"].includes(extension)) {
    return { ...base, kind: "html", content: await readText(filePath, fileStat.size) };
  }
  if ([".txt", ".csv", ".json"].includes(extension)) {
    return { ...base, kind: "text", content: await readText(filePath, fileStat.size) };
  }
  if (extension === ".pdf") {
    return {
      ...base,
      kind: "pdf",
      mimeType: "application/pdf",
      dataBase64: (await readFile(filePath)).toString("base64")
    };
  }
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    return {
      ...base,
      kind: "image",
      mimeType:
        extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg",
      dataBase64: (await readFile(filePath)).toString("base64")
    };
  }
  if ([".docx", ".doc"].includes(extension)) {
    if (process.platform !== "darwin") {
      throw new Error("当前系统暂不支持 Word 内嵌预览，请使用默认应用打开");
    }
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/textutil",
        ["-convert", "html", "-stdout", filePath],
        { encoding: "utf8", maxBuffer: 12 * 1024 * 1024, timeout: 20_000 }
      );
      return { ...base, kind: "html", content: stdout };
    } catch {
      throw new Error("Word 预览转换失败，请使用默认应用打开");
    }
  }
  throw new Error("暂不支持预览这种文件，可使用默认应用打开");
}

async function walk(root, directory, items, depth) {
  if (depth > 5) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const filePath = path.join(directory, entry.name);
    assertInside(root, filePath);
    if (entry.isDirectory()) {
      await walk(root, filePath, items, depth + 1);
      continue;
    }
    if (!entry.isFile() || !canPreviewFilename(entry.name)) continue;
    const fileStat = await stat(filePath);
    items.push({
      name: entry.name,
      relativePath: path.relative(root, filePath).split(path.sep).join("/"),
      extension: path.extname(entry.name).toLowerCase(),
      sizeBytes: fileStat.size,
      updatedAt: fileStat.mtime.toISOString()
    });
  }
}

async function readText(filePath, sizeBytes) {
  if (sizeBytes > MAX_TEXT_BYTES) throw new Error("文本超过 4 MB，请使用默认应用打开");
  return (await readFile(filePath, "utf8")).replace(/\u0000/g, "");
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("文件路径超出当前教学项目");
  }
}
