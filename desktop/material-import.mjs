import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const TEACHING_MATERIAL_EXTENSIONS = new Set([
  ".xlsx",
  ".xls",
  ".csv",
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".txt",
  ".md",
  ".json",
  ".png",
  ".jpg",
  ".jpeg"
]);

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "__MACOSX"]);
const MAX_FILES = 2_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function collectTeachingMaterialFiles(selectedPaths, mode) {
  const files = [];
  let skippedUnsupported = 0;
  let skippedOversized = 0;

  async function visit(candidate, importPath) {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      const entries = await readdir(candidate, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue;
        await visit(path.join(candidate, entry.name), path.join(importPath, entry.name));
      }
      return;
    }
    if (!info.isFile()) return;
    if (!TEACHING_MATERIAL_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
      skippedUnsupported += 1;
      return;
    }
    if (info.size > MAX_FILE_BYTES) {
      skippedOversized += 1;
      return;
    }
    files.push({
      filePath: candidate,
      filename: path.basename(candidate),
      importPath: importPath.replaceAll(path.sep, "/"),
      sizeBytes: info.size
    });
    if (files.length > MAX_FILES) throw new Error(`单次最多导入 ${MAX_FILES} 份资料`);
  }

  for (const selectedPath of selectedPaths) {
    const importPath =
      mode === "folder" ? path.basename(selectedPath) : path.basename(selectedPath);
    await visit(selectedPath, importPath);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("单次导入资料总大小不能超过 2 GB");
  return { files, skippedUnsupported, skippedOversized, totalBytes };
}
