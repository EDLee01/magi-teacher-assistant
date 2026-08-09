import { timingSafeEqual } from "node:crypto";
import http, { IncomingMessage, ServerResponse } from "node:http";

import { PhysicsTeacherService } from "./service.js";
import { PhysicsTeacherSessionKind, TeachingResource } from "./types.js";

const DEFAULT_BIND = "127.0.0.1";
const DEFAULT_PORT = 8877;
const DEFAULT_JSON_LIMIT = 1024 * 1024;
const DEFAULT_UPLOAD_LIMIT = 64 * 1024 * 1024;

export interface PhysicsTeacherHttpOptions {
  env?: NodeJS.ProcessEnv;
  bind?: string;
  port?: number;
}

export function createPhysicsTeacherHttpServer(
  service: PhysicsTeacherService,
  options: PhysicsTeacherHttpOptions = {}
): http.Server {
  const env = options.env ?? process.env;
  return http.createServer((request, response) => {
    void handleRequest(service, request, response, env).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const message = error instanceof Error ? error.message : "Internal server error";
      const status = statusForError(message);
      sendJson(response, status, { error: message }, env, request);
    });
  });
}

export async function startPhysicsTeacherHttpServer(
  service: PhysicsTeacherService,
  options: PhysicsTeacherHttpOptions = {}
): Promise<{ server: http.Server; bind: string; port: number }> {
  const env = options.env ?? process.env;
  const bind = options.bind?.trim() || env.MAGI_TEACHER_BIND?.trim() || DEFAULT_BIND;
  const port = options.port ?? parsePort(env.MAGI_TEACHER_PORT, DEFAULT_PORT);
  if (!isLoopback(bind) && !env.MAGI_TEACHER_API_TOKEN?.trim()) {
    throw new Error("非本机监听必须设置 MAGI_TEACHER_API_TOKEN");
  }
  const server = createPhysicsTeacherHttpServer(service, { ...options, env });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  return { server, bind, port: actualPort };
}

async function handleRequest(
  service: PhysicsTeacherService,
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  setCorsHeaders(response, request, env);
  if (method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "magi-teacher-assistant" }, env, request);
    return;
  }
  requireAuthorization(request, env.MAGI_TEACHER_API_TOKEN);

  if (url.pathname === "/api/projects" && method === "GET") {
    sendJson(response, 200, { projects: service.listProjects().map(publicProject) }, env, request);
    return;
  }
  if (url.pathname === "/api/projects" && method === "POST") {
    const body = await readJson(request);
    const project = service.createProject({
      name: readString(body, "name"),
      grade: readString(body, "grade"),
      className: readString(body, "className"),
      textbookVersion: readOptionalString(body, "textbookVersion"),
      teacherName: readOptionalString(body, "teacherName")
    });
    sendJson(response, 201, { project: publicProject(project) }, env, request);
    return;
  }

  const projectMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    sendJson(
      response,
      200,
      { project: publicProject(service.getProject(projectMatch[0])) },
      env,
      request
    );
    return;
  }

  const wikiMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/wiki$/);
  if (wikiMatch && method === "GET") {
    sendJson(response, 200, { wiki: service.getKnowledgeWiki(wikiMatch[0]) }, env, request);
    return;
  }

  const sessionsMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/sessions$/);
  if (sessionsMatch && method === "GET") {
    sendJson(response, 200, { sessions: service.listSessions(sessionsMatch[0]) }, env, request);
    return;
  }
  if (sessionsMatch && method === "POST") {
    const body = await readJson(request);
    const session = service.createSession({
      projectId: sessionsMatch[0],
      title: readString(body, "title"),
      kind: readSessionKind(body.kind)
    });
    sendJson(response, 201, { session }, env, request);
    return;
  }

  const sessionMatch = matchPath(url.pathname, /^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "GET") {
    const value = service.getSession(sessionMatch[0]);
    const { cwd: _privateCwd, ...session } = value.session;
    sendJson(response, 200, { ...value, session }, env, request);
    return;
  }
  const messagesMatch = matchPath(url.pathname, /^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch && method === "POST") {
    const body = await readJson(request);
    const result = await service.sendMessage({
      sessionId: messagesMatch[0],
      prompt: readString(body, "prompt"),
      modelAlias: readOptionalString(body, "modelAlias"),
      resourceQuery: readOptionalString(body, "resourceQuery"),
      resourceFilters: readOptionalRecord(body, "resourceFilters"),
      permissionScope: readPermissionScope(body.permissionScope)
    });
    sendJson(response, 200, { result }, env, request);
    return;
  }

  const sourcesMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/resource-sources$/);
  if (sourcesMatch && method === "GET") {
    sendJson(
      response,
      200,
      { sources: service.listResourceSources(sourcesMatch[0]) },
      env,
      request
    );
    return;
  }
  if (sourcesMatch && method === "POST") {
    const body = await readJson(request);
    const source = service.addRemoteResourceSource({
      projectId: sourcesMatch[0],
      name: readString(body, "name"),
      baseUrl: readString(body, "baseUrl"),
      apiKeyEnv: readOptionalString(body, "apiKeyEnv"),
      searchPath: readOptionalString(body, "searchPath")
    });
    sendJson(response, 201, { source }, env, request);
    return;
  }

  const resourcesMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/resources$/);
  if (resourcesMatch && method === "GET") {
    sendJson(
      response,
      200,
      { resources: service.listResources(resourcesMatch[0]).map(publicResource) },
      env,
      request
    );
    return;
  }
  const uploadMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/resources\/upload$/);
  if (uploadMatch && method === "POST") {
    const filename = url.searchParams.get("filename")?.trim();
    if (!filename) throw new Error("filename is required");
    const limit = readPositiveInteger(env.MAGI_TEACHER_MAX_UPLOAD_BYTES, DEFAULT_UPLOAD_LIMIT);
    const body = await readBody(request, limit);
    const resource = service.uploadResource({
      projectId: uploadMatch[0],
      filename,
      body,
      mimeType: request.headers["content-type"],
      kind: url.searchParams.get("kind") ?? undefined
    });
    sendJson(response, 201, { resource: publicResource(resource) }, env, request);
    return;
  }
  const searchMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/resources\/search$/);
  if (searchMatch && method === "POST") {
    const body = await readJson(request);
    const result = await service.searchResources({
      projectId: searchMatch[0],
      query: readString(body, "query"),
      limit: readOptionalNumber(body, "limit"),
      filters: readOptionalRecord(body, "filters")
    });
    sendJson(response, 200, result, env, request);
    return;
  }

  const memoryMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/memory$/);
  if (memoryMatch && method === "GET") {
    const filePath = url.searchParams.get("file")?.trim();
    if (filePath) {
      sendJson(
        response,
        200,
        { file: filePath, content: service.readMemory(memoryMatch[0], filePath) },
        env,
        request
      );
    } else {
      sendJson(
        response,
        200,
        {
          files: service
            .listMemory(memoryMatch[0])
            .map(({ absolutePath: _privatePath, ...file }) => file)
        },
        env,
        request
      );
    }
    return;
  }
  const draftsMatch = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/memory\/drafts$/);
  if (draftsMatch && method === "GET") {
    sendJson(response, 200, { drafts: service.listMemoryDrafts(draftsMatch[0]) }, env, request);
    return;
  }
  if (draftsMatch && method === "POST") {
    const body = await readJson(request);
    const draft = service.proposeMemory({
      projectId: draftsMatch[0],
      category: readMemoryCategory(body.category),
      content: readString(body, "content"),
      reason: readString(body, "reason"),
      sourceSession: readOptionalString(body, "sourceSession"),
      confidence: readOptionalNumber(body, "confidence")
    });
    sendJson(response, 201, { draft }, env, request);
    return;
  }
  const draftActionMatch = matchPath(
    url.pathname,
    /^\/api\/projects\/([^/]+)\/memory\/drafts\/([^/]+)\/(apply|reject)$/
  );
  if (draftActionMatch && method === "POST") {
    const [projectId, draftId, action] = draftActionMatch;
    const draft =
      action === "apply"
        ? service.applyMemoryDraft(projectId, draftId)
        : service.rejectMemoryDraft(projectId, draftId);
    sendJson(response, 200, { draft }, env, request);
    return;
  }

  sendJson(response, 404, { error: "Not found" }, env, request);
}

function requireAuthorization(request: IncomingMessage, expectedToken: string | undefined): void {
  const expected = expectedToken?.trim();
  if (!expected) return;
  const header = request.headers.authorization;
  const actual = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new UnauthorizedError();
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, DEFAULT_JSON_LIMIT);
  if (body.length === 0) return {};
  const value = JSON.parse(body.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > limit) throw new Error("Request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  env: NodeJS.ProcessEnv,
  request: IncomingMessage
): void {
  setCorsHeaders(response, request, env);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function setCorsHeaders(
  response: ServerResponse,
  request: IncomingMessage,
  env: NodeJS.ProcessEnv
): void {
  const allowedOrigin = env.MAGI_TEACHER_CORS_ORIGIN?.trim();
  const requestOrigin = request.headers.origin;
  if (allowedOrigin && requestOrigin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  }
}

function publicResource(resource: TeachingResource): Omit<TeachingResource, "storagePath"> {
  const { storagePath: _privatePath, ...result } = resource;
  return result;
}

function publicProject<T extends { rootDir: string }>(project: T): Omit<T, "rootDir"> {
  const { rootDir: _privatePath, ...result } = project;
  return result;
}

function matchPath(pathname: string, expression: RegExp): string[] | undefined {
  const match = expression.exec(pathname);
  if (!match) return undefined;
  return match.slice(1).map((value) => decodeURIComponent(value));
}

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim() || undefined;
}

function readOptionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function readOptionalRecord(
  body: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readSessionKind(value: unknown): PhysicsTeacherSessionKind | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "exam-analysis" ||
    value === "lesson-planning" ||
    value === "practice-adjustment" ||
    value === "retest-review" ||
    value === "general"
  ) {
    return value;
  }
  throw new Error("kind 无效");
}

function readPermissionScope(
  value: unknown
): "read-only" | "project-write" | "approval" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "read-only" || value === "project-write" || value === "approval") return value;
  throw new Error("permissionScope 无效");
}

function readMemoryCategory(value: unknown): "project" | "preference" | "decision" | "session" {
  if (
    value === "project" ||
    value === "preference" ||
    value === "decision" ||
    value === "session"
  ) {
    return value;
  }
  throw new Error("category 无效");
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MAGI_TEACHER_PORT 必须是 1 到 65535 的整数");
  }
  return port;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function statusForError(message: string): number {
  if (message === "Unauthorized") return 401;
  if (message.includes("不存在") || message.includes("not found")) return 404;
  if (message.includes("too large") || message.includes("超过大小限制")) return 413;
  return 400;
}

class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
  }
}
