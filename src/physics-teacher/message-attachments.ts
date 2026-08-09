import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PhysicsTeacherProjectPaths } from "./paths.js";

const DEFAULT_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const TEXT_PREVIEW_BYTES = 16 * 1024;

export interface PhysicsTeacherMessageAttachmentInput {
  filename: string;
  body: Buffer;
  mimeType?: string;
}

export interface PreparedPhysicsTeacherMessageAttachment {
  filename: string;
  relativePath: string;
  mimeType?: string;
  sizeBytes: number;
  preview?: string;
}

export interface PreparedPhysicsTeacherMessageAttachments {
  items: PreparedPhysicsTeacherMessageAttachment[];
  cleanup(): void;
}

export function preparePhysicsTeacherMessageAttachments(input: {
  projectPaths: PhysicsTeacherProjectPaths;
  attachments?: PhysicsTeacherMessageAttachmentInput[];
  env?: NodeJS.ProcessEnv;
}): PreparedPhysicsTeacherMessageAttachments {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return { items: [], cleanup() {} };
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`每次对话最多添加 ${MAX_ATTACHMENTS_PER_MESSAGE} 份临时资料`);
  }

  const maxBytes = readPositiveInteger(
    input.env?.MAGI_TEACHER_MAX_MESSAGE_ATTACHMENT_BYTES,
    DEFAULT_MAX_ATTACHMENT_BYTES
  );
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.body.length, 0);
  if (totalBytes > maxBytes) {
    throw new Error(`本次对话资料总大小超过限制（${maxBytes} bytes）`);
  }

  const attachmentRoot = path.join(input.projectPaths.artifacts, ".message-attachments");
  const turnDirectory = path.join(attachmentRoot, `turn-${randomUUID()}`);
  assertInsideDirectory(attachmentRoot, turnDirectory);
  mkdirSync(turnDirectory, { recursive: true, mode: 0o700 });

  try {
    const items = attachments.map((attachment, index) => {
      if (attachment.body.length === 0) throw new Error("临时资料不能为空");
      const filename = safeDisplayFilename(attachment.filename);
      const extension = safeExtension(filename);
      const storagePath = path.join(turnDirectory, `${index + 1}-${randomUUID()}${extension}`);
      assertInsideDirectory(turnDirectory, storagePath);
      writeFileSync(storagePath, attachment.body, { flag: "wx", mode: 0o600 });
      try {
        chmodSync(storagePath, 0o600);
      } catch {
        // Best effort for mounted or shared development filesystems.
      }
      return {
        filename,
        relativePath: path.relative(input.projectPaths.root, storagePath).replaceAll(path.sep, "/"),
        mimeType: optionalText(attachment.mimeType) ?? inferMimeType(extension),
        sizeBytes: attachment.body.length,
        preview: extractTextPreview(attachment.body, extension, attachment.mimeType)
      };
    });
    return {
      items,
      cleanup() {
        rmSync(turnDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    rmSync(turnDirectory, { recursive: true, force: true });
    throw error;
  }
}

function safeDisplayFilename(value: string): string {
  const filename = path
    .basename(value.trim().replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "_");
  if (!filename || filename === "." || filename === "..") throw new Error("filename 无效");
  return filename.slice(0, 240);
}

function safeExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

function extractTextPreview(
  body: Buffer,
  extension: string,
  mimeType?: string
): string | undefined {
  const textExtensions = new Set([".txt", ".md", ".csv", ".json", ".yaml", ".yml"]);
  if (!textExtensions.has(extension) && !mimeType?.startsWith("text/")) return undefined;
  return body
    .subarray(0, TEXT_PREVIEW_BYTES)
    .toString("utf8")
    .replace(/\u0000/g, "")
    .trim();
}

function inferMimeType(extension: string): string | undefined {
  return {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  }[extension];
}

function assertInsideDirectory(directory: string, candidate: string): void {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("临时资料路径越界");
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
