import { randomUUID } from "node:crypto";
import path from "node:path";

import { MagiConfig } from "../config.js";
import { HeadlessApprovalResolver, HeadlessResult, runHeadlessPrompt } from "../headless.js";
import {
  applyDraft,
  listDrafts,
  MemoryDraft,
  proposeMemoryDraft,
  rejectDraft,
  showDraft
} from "../memory-draft.js";
import { appendMemoryFile, initMemory, listMemoryFiles, readMemoryFile } from "../memory-files.js";
import { MagiPaths } from "../paths.js";
import { SessionRecord, SessionStore } from "../session-store.js";
import { ensurePhysicsTeacherHarness, ensurePhysicsTeacherProjectGit } from "./harness.js";
import {
  PhysicsTeacherKnowledgeWikiSummary,
  rebuildPhysicsTeacherKnowledgeWiki
} from "./knowledge-wiki.js";
import {
  PhysicsTeacherMessageAttachmentInput,
  preparePhysicsTeacherMessageAttachments,
  PreparedPhysicsTeacherMessageAttachment
} from "./message-attachments.js";
import { PHYSICS_TEACHER_MODEL_ALIAS } from "./model-settings.js";
import {
  ensurePhysicsTeacherProjectPaths,
  getPhysicsTeacherProjectPaths,
  PhysicsTeacherPaths,
  PhysicsTeacherProjectPaths
} from "./paths.js";
import { PhysicsTeacherProjectStore } from "./project-store.js";
import { TeachingResourceGateway } from "./resources.js";
import {
  physicsTeacherSkillInstructions,
  PhysicsTeacherSkill,
  resolvePhysicsTeacherSkill
} from "./skills.js";
import {
  buildPhysicsTeacherRuntimeEnv,
  buildPhysicsTeacherToolRules,
  PhysicsTeacherPermissionScope
} from "./tool-profile.js";
import {
  CreatePhysicsTeacherProjectInput,
  PhysicsTeacherProject,
  PhysicsTeacherProjectSession,
  PhysicsTeacherSessionKind,
  TeachingResource,
  TeachingResourceSearchResult
} from "./types.js";

export type PhysicsTeacherMemoryCategory = "project" | "preference" | "decision" | "session";

export interface PhysicsTeacherResourceUploadInput {
  filename: string;
  body: Buffer;
  mimeType?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}

export interface PhysicsTeacherServiceOptions {
  magiPaths: MagiPaths;
  paths: PhysicsTeacherPaths;
  config: MagiConfig;
  projectStore: PhysicsTeacherProjectStore;
  sessionStore: SessionStore;
  resources?: TeachingResourceGateway;
  env?: NodeJS.ProcessEnv;
  promptRunner?: typeof runHeadlessPrompt;
  approvalResolver?: HeadlessApprovalResolver;
}

export class PhysicsTeacherService {
  readonly resources: TeachingResourceGateway;
  private readonly env: NodeJS.ProcessEnv;
  private readonly promptRunner: typeof runHeadlessPrompt;
  private approvalResolver?: HeadlessApprovalResolver;
  private config: MagiConfig;

  constructor(private readonly options: PhysicsTeacherServiceOptions) {
    this.env = options.env ?? process.env;
    this.config = options.config;
    this.resources =
      options.resources ?? new TeachingResourceGateway(options.projectStore, this.env);
    this.promptRunner = options.promptRunner ?? runHeadlessPrompt;
    this.approvalResolver = options.approvalResolver;
  }

  updateConfig(config: MagiConfig): void {
    this.config = config;
  }

  setApprovalResolver(resolver: HeadlessApprovalResolver | undefined): void {
    this.approvalResolver = resolver;
  }

  listProjects(): PhysicsTeacherProject[] {
    return this.options.projectStore.listProjects();
  }

  getProject(projectId: string): PhysicsTeacherProject {
    return requireValue(this.options.projectStore.getProject(projectId), "项目不存在");
  }

  createProject(input: CreatePhysicsTeacherProjectInput): PhysicsTeacherProject {
    const normalizedInput: CreatePhysicsTeacherProjectInput = {
      name: requireMetadataText(input.name, "name"),
      grade: requireMetadataText(input.grade, "grade"),
      className: requireMetadataText(input.className, "className"),
      textbookVersion: optionalMetadataText(input.textbookVersion, "textbookVersion"),
      teacherName: optionalMetadataText(input.teacherName, "teacherName")
    };
    const id = randomUUID();
    const projectPaths = getPhysicsTeacherProjectPaths(this.options.paths, id);
    ensurePhysicsTeacherProjectPaths(projectPaths);
    ensurePhysicsTeacherHarness(projectPaths.root);
    ensurePhysicsTeacherProjectGit(projectPaths.root);
    initMemory(this.memoryOptions(projectPaths));

    const project = this.options.projectStore.createProject({
      ...normalizedInput,
      id,
      rootDir: projectPaths.root
    });
    this.resources.ensureUploadSource(id);
    rebuildPhysicsTeacherKnowledgeWiki({ projectPaths, resources: [] });
    appendMemoryFile({
      ...this.memoryOptions(projectPaths),
      filePath: "projects/context.md",
      content: formatInitialProjectMemory(project)
    });
    return project;
  }

  listSessions(projectId: string): PhysicsTeacherProjectSession[] {
    this.getProject(projectId);
    return this.options.projectStore.listSessions(projectId);
  }

  createSession(input: {
    projectId: string;
    title: string;
    kind?: PhysicsTeacherSessionKind;
  }): PhysicsTeacherProjectSession {
    const project = this.getProject(input.projectId);
    const title = requireText(input.title, "title");
    const kind = input.kind ?? "general";
    const sessionId = this.options.sessionStore.createSession({
      title,
      cwd: project.rootDir,
      metadata: {
        source: "physics-teacher",
        physicsProjectId: project.id,
        physicsSessionKind: kind
      }
    });
    return this.options.projectStore.addSession({ projectId: project.id, sessionId, title, kind });
  }

  getSession(sessionId: string): {
    projectSession: PhysicsTeacherProjectSession;
    session: SessionRecord;
  } {
    const projectSession = requireValue(
      this.options.projectStore.getSession(sessionId),
      "Session 不存在"
    );
    const session = requireValue(
      this.options.sessionStore.getSession(sessionId),
      "Magi Session 不存在"
    );
    return { projectSession, session };
  }

  async sendMessage(input: {
    sessionId: string;
    prompt: string;
    modelAlias?: string;
    resourceQuery?: string;
    resourceFilters?: Record<string, unknown>;
    attachments?: PhysicsTeacherMessageAttachmentInput[];
    permissionScope?: PhysicsTeacherPermissionScope;
  }): Promise<HeadlessResult> {
    const { projectSession, session } = this.getSession(input.sessionId);
    const project = this.getProject(projectSession.projectId);
    if (path.resolve(session.cwd) !== path.resolve(project.rootDir)) {
      throw new Error("Session 工作目录与项目不一致");
    }
    const projectPaths = this.projectPaths(project.id);
    const prompt = requireText(input.prompt, "prompt");
    const businessSkill = resolvePhysicsTeacherSkill(prompt);
    const isQuestionDesign = businessSkill?.name === "physics-question-design";
    const resourceContext = input.resourceQuery
      ? await this.resources.search({
          projectId: project.id,
          query: isQuestionDesign
            ? `${input.resourceQuery}\n原题 真题 试卷 题目 练习 答案 解析`
            : input.resourceQuery,
          limit: isQuestionDesign ? 50 : undefined,
          filters: input.resourceFilters
        })
      : undefined;
    const permissionScope = normalizePermissionScope(input.permissionScope);
    const preparedAttachments = preparePhysicsTeacherMessageAttachments({
      projectPaths,
      attachments: input.attachments,
      env: this.env
    });
    const contextMessageId = this.options.sessionStore.appendMessage({
      sessionId: input.sessionId,
      role: "system",
      content: buildTeacherContext(
        project,
        resourceContext,
        preparedAttachments.items,
        permissionScope,
        businessSkill
      ),
      metadata: {
        source: "physics-teacher-context",
        temporaryAttachments: preparedAttachments.items.map((attachment) => attachment.filename)
      }
    });
    const config: MagiConfig = {
      ...this.config,
      memory: {
        ...this.config.memory,
        enabled: true,
        root: projectPaths.memory,
        autoWrite: "explicit",
        scopes: ["project", "session"]
      }
    };
    const runtimeEnv = buildPhysicsTeacherRuntimeEnv(this.env, project.rootDir);
    try {
      return await this.promptRunner({
        prompt: appendTemporaryAttachmentManifest(prompt, preparedAttachments.items),
        cwd: project.rootDir,
        sessionId: input.sessionId,
        store: this.options.sessionStore,
        config,
        env: runtimeEnv,
        paths: this.options.magiPaths,
        stateRoot: this.options.magiPaths.stateRoot,
        modelAlias:
          input.modelAlias?.trim() ||
          (config.models.aliases[PHYSICS_TEACHER_MODEL_ALIAS]
            ? PHYSICS_TEACHER_MODEL_ALIAS
            : "auto"),
        permissionMode: permissionScope === "approval" ? "default" : "dontAsk",
        approvalResolver: permissionScope === "approval" ? this.approvalResolver : undefined,
        toolRules: buildPhysicsTeacherToolRules(permissionScope)
      });
    } finally {
      preparedAttachments.cleanup();
      if (preparedAttachments.items.length > 0) {
        this.options.sessionStore.deleteMessage({
          sessionId: input.sessionId,
          messageId: contextMessageId
        });
      }
    }
  }

  listResourceSources(projectId: string) {
    this.getProject(projectId);
    return this.options.projectStore.listResourceSources(projectId);
  }

  addRemoteResourceSource(input: {
    projectId: string;
    name: string;
    baseUrl: string;
    apiKeyEnv?: string;
    searchPath?: string;
  }) {
    this.getProject(input.projectId);
    return this.resources.addRemoteSource(input);
  }

  listResources(projectId: string): TeachingResource[] {
    this.getProject(projectId);
    return this.options.projectStore.listResources(projectId);
  }

  uploadResource(input: {
    projectId: string;
    filename: string;
    body: Buffer;
    mimeType?: string;
    kind?: string;
    metadata?: Record<string, unknown>;
  }): TeachingResource {
    const resource = this.resources.upload({
      ...input,
      projectPaths: this.projectPathsForExisting(input.projectId)
    });
    this.refreshKnowledgeWiki(input.projectId);
    return resource;
  }

  async uploadResources(input: {
    projectId: string;
    resources:
      | Iterable<PhysicsTeacherResourceUploadInput>
      | AsyncIterable<PhysicsTeacherResourceUploadInput>;
  }): Promise<{
    added: TeachingResource[];
    duplicateCount: number;
    wiki: PhysicsTeacherKnowledgeWikiSummary;
  }> {
    const projectPaths = this.projectPathsForExisting(input.projectId);
    const knownIds = new Set(
      this.options.projectStore.listResources(input.projectId).map((item) => item.id)
    );
    const added: TeachingResource[] = [];
    let duplicateCount = 0;
    for await (const upload of input.resources) {
      const resource = this.resources.upload({
        ...upload,
        projectId: input.projectId,
        projectPaths
      });
      if (knownIds.has(resource.id)) {
        duplicateCount += 1;
      } else {
        knownIds.add(resource.id);
        added.push(resource);
      }
    }
    return { added, duplicateCount, wiki: this.refreshKnowledgeWiki(input.projectId) };
  }

  getKnowledgeWiki(projectId: string): PhysicsTeacherKnowledgeWikiSummary {
    return this.refreshKnowledgeWiki(projectId);
  }

  private refreshKnowledgeWiki(projectId: string): PhysicsTeacherKnowledgeWikiSummary {
    const projectPaths = this.projectPathsForExisting(projectId);
    return rebuildPhysicsTeacherKnowledgeWiki({
      projectPaths,
      resources: this.options.projectStore.listResources(projectId)
    });
  }

  searchResources(input: {
    projectId: string;
    query: string;
    limit?: number;
    filters?: Record<string, unknown>;
  }): Promise<TeachingResourceSearchResult> {
    this.getProject(input.projectId);
    return this.resources.search(input);
  }

  listMemory(projectId: string) {
    return listMemoryFiles(this.memoryOptions(this.projectPathsForExisting(projectId)));
  }

  readMemory(projectId: string, filePath: string): string {
    return readMemoryFile({
      ...this.memoryOptions(this.projectPathsForExisting(projectId)),
      filePath
    });
  }

  listMemoryDrafts(projectId: string): MemoryDraft[] {
    const options = this.memoryOptions(this.projectPathsForExisting(projectId));
    return listDrafts(options).map((draft) => showDraft({ ...options, id: draft.id }));
  }

  proposeMemory(input: {
    projectId: string;
    category: PhysicsTeacherMemoryCategory;
    content: string;
    reason: string;
    sourceSession?: string;
    confidence?: number;
  }): MemoryDraft {
    const projectPaths = this.projectPathsForExisting(input.projectId);
    if (input.sourceSession) {
      const session = this.getSession(input.sourceSession).projectSession;
      if (session.projectId !== input.projectId) throw new Error("Session 不属于当前项目");
    }
    return proposeMemoryDraft({
      ...this.memoryOptions(projectPaths),
      targetFile: memoryTarget(input.category, input.sourceSession),
      content: requireText(input.content, "content"),
      reason: requireText(input.reason, "reason"),
      sourceSession: input.sourceSession,
      confidence: validateConfidence(input.confidence)
    });
  }

  applyMemoryDraft(projectId: string, draftId: string): MemoryDraft {
    return applyDraft({
      ...this.memoryOptions(this.projectPathsForExisting(projectId)),
      id: draftId
    });
  }

  rejectMemoryDraft(projectId: string, draftId: string): MemoryDraft {
    return rejectDraft({
      ...this.memoryOptions(this.projectPathsForExisting(projectId)),
      id: draftId
    });
  }

  projectPathsForExisting(projectId: string): PhysicsTeacherProjectPaths {
    this.getProject(projectId);
    return this.projectPaths(projectId);
  }

  private projectPaths(projectId: string): PhysicsTeacherProjectPaths {
    return getPhysicsTeacherProjectPaths(this.options.paths, projectId);
  }

  private memoryOptions(projectPaths: PhysicsTeacherProjectPaths) {
    return { appRoot: this.options.magiPaths.root, root: projectPaths.memory };
  }
}

function formatInitialProjectMemory(project: PhysicsTeacherProject): string {
  return [
    "# 物理教研项目",
    "",
    `- 项目：${project.name}`,
    `- 学段/年级：${project.grade}`,
    `- 班级：${project.className}`,
    project.textbookVersion ? `- 教材版本：${project.textbookVersion}` : undefined,
    project.teacherName ? `- 任课教师：${project.teacherName}` : undefined,
    "- 以上信息由教师在创建项目时确认。"
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function buildTeacherContext(
  project: PhysicsTeacherProject,
  resources?: TeachingResourceSearchResult,
  temporaryAttachments: PreparedPhysicsTeacherMessageAttachment[] = [],
  permissionScope: PhysicsTeacherPermissionScope = "project-write",
  businessSkill?: PhysicsTeacherSkill
): string {
  const resourceLines = resources?.items.length
    ? resources.items.flatMap((item) => [
        `- [${item.id}] ${item.title}（${item.source} / ${item.kind}）`,
        item.snippet ? `  摘要：${item.snippet.slice(0, 1_500)}` : undefined
      ])
    : ["- 本次未指定资料检索；如依据不足，请向教师说明需要哪一类资料。"];
  const warningLines = resources?.warnings?.length
    ? ["", "[资料检索警告]", ...resources.warnings.map((warning) => `- ${warning}`)]
    : [];
  const attachmentLines = temporaryAttachments.length
    ? [
        "",
        "[本次对话临时资料]",
        "以下资料仅用于回答当前消息，不属于项目基础资料；回答完成后临时文件会被删除。",
        ...temporaryAttachments.flatMap((attachment) => [
          `- ${attachment.filename}（${attachment.sizeBytes} bytes）`,
          `  临时读取路径：${attachment.relativePath}`,
          attachment.preview ? `  内容预览：${attachment.preview.slice(0, 4_000)}` : undefined
        ])
      ]
    : [];
  const businessSkillLines = businessSkill
    ? [
        "",
        "[本次已隐式采用的业务 Skill]",
        `Skill：${businessSkill.name}`,
        "以下工作法已直接加载，不要再次调用 Skill 工具加载同一工作法。",
        physicsTeacherSkillInstructions(businessSkill)
      ]
    : [];
  const questionBankLines =
    businessSkill?.name === "physics-question-design"
      ? [
          "",
          "[本次选题要求]",
          "优先从项目题库逐个知识点检索并直接选用原题。只要存在合适原题，就不能用 AI 自编题替代。",
          "每道选中题必须核对来源、原题号、题干、选项、答案以及所依赖的原图；题库缺口才允许补充新题并明确标注。"
        ]
      : [];
  return [
    "[当前物理教研项目]",
    `项目：${project.name}`,
    `年级：${project.grade}`,
    `班级：${project.className}`,
    project.textbookVersion ? `教材版本：${project.textbookVersion}` : undefined,
    "",
    "[本次可引用的教学资料]",
    ...resourceLines,
    ...warningLines,
    "",
    "[项目知识库]",
    "知识库目录：workspace/wiki/INDEX.md。需要跨资料梳理时，先读取目录和分类页，再核对来源页与原文件。",
    ...questionBankLines,
    "",
    "[当前权限范围]",
    permissionScopeDescription(permissionScope),
    ...businessSkillLines,
    ...attachmentLines
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function normalizePermissionScope(
  value: PhysicsTeacherPermissionScope | undefined
): PhysicsTeacherPermissionScope {
  if (value === "read-only" || value === "approval" || value === "project-write") return value;
  return "project-write";
}

function permissionScopeDescription(scope: PhysicsTeacherPermissionScope): string {
  if (scope === "read-only") return "只读：可以检索和分析，但不能写入文件或运行修改性命令。";
  if (scope === "approval") return "操作前询问：写文件、编辑文件或运行命令前必须由教师审批。";
  return "项目内读写：可直接写入 workspace/ 和 artifacts/；uploads/、memory/ 和项目外路径不可写。";
}

function appendTemporaryAttachmentManifest(
  prompt: string,
  attachments: PreparedPhysicsTeacherMessageAttachment[]
): string {
  if (attachments.length === 0) return prompt;
  return [
    prompt,
    "",
    "[本次附件]",
    ...attachments.map((attachment) => `- ${attachment.filename}`)
  ].join("\n");
}

function memoryTarget(category: PhysicsTeacherMemoryCategory, sourceSession?: string): string {
  switch (category) {
    case "project":
      return "projects/context.md";
    case "preference":
      return "preferences.md";
    case "decision":
      return "decisions/teaching.md";
    case "session":
      if (!sourceSession) throw new Error("session 类记忆必须提供 sourceSession");
      return `sessions/${sourceSession}.md`;
  }
}

function validateConfidence(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence 必须在 0 到 1 之间");
  }
  return value;
}

function requireText(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} must not be empty`);
  return result;
}

function requireMetadataText(value: string, field: string): string {
  const result = requireText(value, field);
  if (result.length > 300) throw new Error(`${field} is too long`);
  return result;
}

function optionalMetadataText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > 300) throw new Error(`${field} is too long`);
  return result;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
