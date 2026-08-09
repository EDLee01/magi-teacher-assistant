import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PhysicsTeacherProjectStore } from "./project-store.js";
import { PhysicsTeacherProjectPaths } from "./paths.js";
import {
  TeachingResource,
  TeachingResourceSearchItem,
  TeachingResourceSearchResult,
  TeachingResourceSource
} from "./types.js";

const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 2 * 1024 * 1024;
const TEXT_EXCERPT_BYTES = 64 * 1024;
const EXTRACTOR_MAX_BUFFER_BYTES = 512 * 1024;

export interface RemoteTeachingResourceConfig extends Record<string, unknown> {
  baseUrl: string;
  apiKeyEnv?: string;
  searchPath?: string;
}

export class TeachingResourceGateway {
  constructor(
    private readonly store: PhysicsTeacherProjectStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  ensureUploadSource(projectId: string): TeachingResourceSource {
    const existing = this.store
      .listResourceSources(projectId)
      .find((source) => source.kind === "upload");
    if (existing) return existing;
    return this.store.addResourceSource({
      projectId,
      name: "教师上传资料",
      kind: "upload",
      config: {}
    });
  }

  addRemoteSource(input: {
    projectId: string;
    name: string;
    baseUrl: string;
    apiKeyEnv?: string;
    searchPath?: string;
  }): TeachingResourceSource {
    const config = validateRemoteConfig(input, this.env);
    return this.store.addResourceSource({
      projectId: input.projectId,
      name: input.name,
      kind: "remote-api",
      config
    });
  }

  upload(input: {
    projectId: string;
    projectPaths: PhysicsTeacherProjectPaths;
    filename: string;
    body: Buffer;
    mimeType?: string;
    kind?: string;
    metadata?: Record<string, unknown>;
  }): TeachingResource {
    const maxBytes = readPositiveInteger(
      this.env.MAGI_TEACHER_MAX_UPLOAD_BYTES,
      DEFAULT_MAX_UPLOAD_BYTES
    );
    if (input.body.length === 0) throw new Error("上传文件不能为空");
    if (input.body.length > maxBytes) {
      throw new Error(`上传文件超过大小限制（${maxBytes} bytes）`);
    }

    const originalFilename = safeDisplayFilename(input.filename);
    const extension = safeExtension(originalFilename);
    const checksumSha256 = createHash("sha256").update(input.body).digest("hex");
    const existing = this.store.findResourceByChecksum(input.projectId, checksumSha256);
    if (existing) return existing;
    const storageFilename = `${randomUUID()}${extension}`;
    const storagePath = path.join(input.projectPaths.uploads, storageFilename);
    assertInsideDirectory(input.projectPaths.uploads, storagePath);
    writeFileSync(storagePath, input.body, { flag: "wx", mode: 0o600 });
    try {
      chmodSync(storagePath, 0o600);
    } catch {
      // Best effort for mounted or shared development filesystems.
    }

    const mimeType = optionalText(input.mimeType) ?? inferMimeType(extension);
    try {
      const excerpt = extractTextExcerpt(input.body, extension, mimeType, storagePath, this.env);
      return this.store.addResource({
        projectId: input.projectId,
        sourceId: this.ensureUploadSource(input.projectId).id,
        title: originalFilename,
        kind: optionalText(input.kind) ?? inferResourceKind(extension),
        mimeType,
        originalFilename,
        storagePath,
        sizeBytes: input.body.length,
        checksumSha256,
        excerpt,
        metadata: {
          ...(input.metadata ?? {}),
          wikiTextStatus: excerpt ? "ready" : "source-only"
        }
      });
    } catch (error) {
      try {
        unlinkSync(storagePath);
      } catch {
        // The database error is more useful than a best-effort cleanup error.
      }
      throw error;
    }
  }

  async search(input: {
    projectId: string;
    query: string;
    limit?: number;
    filters?: Record<string, unknown>;
  }): Promise<TeachingResourceSearchResult> {
    const query = input.query.trim();
    if (!query) throw new Error("query must not be empty");
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const local = rankLocalResources({
      exact: this.store.searchLocalResources(input.projectId, query, limit),
      all: this.store.listResources(input.projectId),
      query,
      limit
    }).map((resource) => toSearchItem(resource, query));
    const remoteSources = this.store
      .listResourceSources(input.projectId)
      .filter((source) => source.kind === "remote-api" && source.enabled);

    const remoteResults = await Promise.allSettled(
      remoteSources.map((source) =>
        this.searchRemoteSource(source, query, limit, input.filters ?? {})
      )
    );
    const remote = remoteResults.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []
    );
    const warnings = remoteResults.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${remoteSources[index].name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          ]
        : []
    );

    return {
      query,
      items: [...local, ...remote].slice(0, limit),
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  private async searchRemoteSource(
    source: TeachingResourceSource,
    query: string,
    limit: number,
    filters: Record<string, unknown>
  ): Promise<TeachingResourceSearchItem[]> {
    const config = validateRemoteConfig(source.config, this.env);
    const url = new URL(config.searchPath ?? "/v1/search", ensureTrailingSlash(config.baseUrl));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKeyEnv) {
      const apiKey = this.env[config.apiKeyEnv]?.trim();
      if (!apiKey) throw new Error(`缺少资料接口密钥环境变量：${config.apiKeyEnv}`);
      headers.authorization = `Bearer ${apiKey}`;
    }

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, filters, limit }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`资料接口请求失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_REMOTE_RESPONSE_BYTES) throw new Error("资料接口响应过大");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_REMOTE_RESPONSE_BYTES) throw new Error("资料接口响应过大");
    const payload = JSON.parse(text) as unknown;
    return parseRemoteItems(payload, source, limit);
  }
}

function validateRemoteConfig(
  input: Record<string, unknown> | RemoteTeachingResourceConfig,
  env: NodeJS.ProcessEnv
): RemoteTeachingResourceConfig {
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) throw new Error("baseUrl must not be empty");
  const parsed = new URL(baseUrl);
  const allowHttp = env.MAGI_TEACHER_ALLOW_HTTP_RESOURCES === "1";
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error("教学资料 API 默认必须使用 HTTPS");
  }
  if (parsed.username || parsed.password) throw new Error("baseUrl 不得包含账号或密钥");

  const apiKeyEnv = typeof input.apiKeyEnv === "string" ? input.apiKeyEnv.trim() : undefined;
  if (apiKeyEnv && !/^[A-Z][A-Z0-9_]{1,127}$/.test(apiKeyEnv)) {
    throw new Error("apiKeyEnv 必须是合法的环境变量名");
  }
  const searchPath = typeof input.searchPath === "string" ? input.searchPath.trim() : undefined;
  if (searchPath && (!searchPath.startsWith("/") || searchPath.startsWith("//"))) {
    throw new Error("searchPath 必须是以 / 开头的站内路径");
  }
  return { baseUrl: parsed.toString(), apiKeyEnv, searchPath };
}

function parseRemoteItems(
  payload: unknown,
  source: TeachingResourceSource,
  limit: number
): TeachingResourceSearchItem[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("资料接口返回格式错误");
  }
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error("资料接口返回格式错误：缺少 items");
  return items.slice(0, limit).flatMap((value): TeachingResourceSearchItem[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const id = optionalText(item.id);
    const title = optionalText(item.title);
    if (!id || !title) return [];
    return [
      {
        id,
        title,
        kind: optionalText(item.kind) ?? "reference",
        snippet: optionalText(item.snippet),
        source: optionalText(item.source) ?? source.name,
        sourceId: source.id,
        metadata:
          item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
            ? (item.metadata as Record<string, unknown>)
            : {}
      }
    ];
  });
}

function toSearchItem(resource: TeachingResource, query: string): TeachingResourceSearchItem {
  return {
    id: resource.id,
    title: resource.title,
    kind: resource.kind,
    snippet: contextualSnippet(resource.excerpt, query),
    source: "教师上传资料",
    sourceId: resource.sourceId,
    metadata: resource.metadata
  };
}

function contextualSnippet(excerpt: string | undefined, query: string): string | undefined {
  if (!excerpt) return undefined;
  const terms = searchTerms(query).filter(
    (term) => term.length >= 2 && !GENERIC_RESOURCE_QUERY_TERMS.has(term)
  );
  if (terms.length === 0) return excerpt.slice(0, 1_500);

  const normalized = excerpt.normalize("NFKC").toLowerCase();
  const candidates = terms
    .flatMap((term) => {
      const positions: number[] = [];
      let index = normalized.indexOf(term);
      while (index >= 0 && positions.length < 12) {
        positions.push(index);
        index = normalized.indexOf(term, index + term.length);
      }
      return positions;
    })
    .map((position) => {
      const start = Math.max(0, position - 500);
      const end = Math.min(excerpt.length, start + 1_500);
      const window = normalized.slice(start, end);
      const score = terms.reduce((sum, term) => sum + (window.includes(term) ? term.length : 0), 0);
      return { start, end, score };
    })
    .sort((left, right) => right.score - left.score || left.start - right.start);
  const best = candidates[0];
  if (!best) return excerpt.slice(0, 1_500);
  return `${best.start > 0 ? "…" : ""}${excerpt.slice(best.start, best.end).trim()}${
    best.end < excerpt.length ? "…" : ""
  }`;
}

function rankLocalResources(input: {
  exact: TeachingResource[];
  all: TeachingResource[];
  query: string;
  limit: number;
}): TeachingResource[] {
  const exactIds = new Set(input.exact.map((resource) => resource.id));
  const ranked = input.all
    .filter((resource) => !exactIds.has(resource.id))
    .map((resource) => ({ resource, score: localResourceScore(resource, input.query) }))
    // A single shared Chinese bigram (for example “一定”) is too weak and
    // creates noisy question-bank matches as the project grows.
    .filter((item) => item.score >= 2)
    .sort(
      (left, right) =>
        right.score - left.score || right.resource.createdAt.localeCompare(left.resource.createdAt)
    )
    .map((item) => item.resource);
  const selected = [...input.exact, ...ranked].slice(0, input.limit);
  if (selected.length > 0) return selected;
  // A teacher often says “根据我上传的资料” without repeating a filename.
  // Keep a small recent-project fallback only for that explicit intent; unrelated
  // searches should not be polluted by every recent upload.
  return shouldUseRecentResourceFallback(input.query)
    ? input.all.slice(0, Math.min(input.limit, 6))
    : [];
}

function localResourceScore(resource: TeachingResource, query: string): number {
  const queryTerms = new Set(searchTerms(query));
  if (queryTerms.size === 0) return 0;
  const titleTerms = searchTerms(resource.title);
  const excerptTerms = searchTerms(resource.excerpt ?? "");
  const kindTerms = searchTerms(resource.kind);
  return (
    titleTerms.reduce((score, term) => score + (queryTerms.has(term) ? 5 : 0), 0) +
    excerptTerms.reduce((score, term) => score + (queryTerms.has(term) ? 1 : 0), 0) +
    kindTerms.reduce((score, term) => score + (queryTerms.has(term) ? 2 : 0), 0)
  );
}

function searchTerms(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (word.length >= 2) terms.add(word);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (const width of [2, 3]) {
      for (let index = 0; index <= run.length - width; index += 1) {
        terms.add(run.slice(index, index + width));
      }
    }
  }
  return [...terms];
}

const GENERIC_RESOURCE_QUERY_TERMS = new Set(
  searchTerms(
    "请根据参考帮我我们当前这次已有上传资料文件材料题库出题命题组卷生成设计题目试题试卷模拟练习答案解析要求按照部分一个一套"
  )
);

function shouldUseRecentResourceFallback(query: string): boolean {
  return /(?:上传|资料|文件|材料|当前项目|已有|刚才|刚刚)|\b(?:upload(?:ed)?|materials?|files?|documents?)\b/i.test(
    query
  );
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

function assertInsideDirectory(directory: string, candidate: string): void {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("上传文件路径越界");
  }
}

function extractTextExcerpt(
  body: Buffer,
  extension: string,
  mimeType: string | undefined,
  storagePath: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const textExtensions = new Set([".txt", ".md", ".csv", ".json", ".yaml", ".yml"]);
  if (textExtensions.has(extension) || mimeType?.startsWith("text/")) {
    return normalizeExtractedText(body.subarray(0, TEXT_EXCERPT_BYTES).toString("utf8"));
  }
  if ([".doc", ".docx"].includes(extension)) {
    return runTextExtractor(process.platform === "darwin" ? "/usr/bin/textutil" : "textutil", [
      "-convert",
      "txt",
      "-stdout",
      storagePath
    ]);
  }
  if (extension === ".pdf") {
    const configured = env.MAGI_PDFTOTEXT_PATH?.trim();
    const candidates = [
      configured,
      "pdftotext",
      process.platform === "darwin" ? "/opt/homebrew/bin/pdftotext" : undefined,
      process.platform === "darwin" ? "/usr/local/bin/pdftotext" : undefined
    ].filter((value): value is string => Boolean(value));
    for (const command of new Set(candidates)) {
      const extracted = runTextExtractor(command, [
        "-layout",
        "-f",
        "1",
        "-l",
        "20",
        storagePath,
        "-"
      ]);
      if (extracted) return extracted;
    }
    if (process.platform === "darwin") {
      const spotlightText = runTextExtractor("/usr/bin/mdls", [
        "-raw",
        "-name",
        "kMDItemTextContent",
        storagePath
      ]);
      return spotlightText === "(null)" ? undefined : spotlightText;
    }
  }
  return undefined;
}

function runTextExtractor(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: EXTRACTOR_MAX_BUFFER_BYTES,
    windowsHide: true
  });
  if (result.error || result.status !== 0 || !result.stdout) return undefined;
  return normalizeExtractedText(result.stdout);
}

function normalizeExtractedText(value: string): string | undefined {
  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!normalized) return undefined;
  return Buffer.from(normalized, "utf8").subarray(0, TEXT_EXCERPT_BYTES).toString("utf8").trim();
}

function inferMimeType(extension: string): string | undefined {
  const values: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".csv": "text/csv",
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  };
  return values[extension];
}

function inferResourceKind(extension: string): string {
  if ([".xlsx", ".xls", ".csv"].includes(extension)) return "exam-results";
  if ([".pdf", ".docx", ".doc"].includes(extension)) return "document";
  if ([".png", ".jpg", ".jpeg"].includes(extension)) return "image";
  return "reference";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result || undefined;
}
