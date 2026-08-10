import { randomUUID } from "node:crypto";
import path from "node:path";

import { MagiConfig } from "../config.js";
import {
  HeadlessApprovalResolver,
  HeadlessResult,
  HeadlessToolExecutionGuard,
  runHeadlessPrompt
} from "../headless.js";
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
import { MessageRecord, SessionRecord, SessionStore } from "../session-store.js";
import {
  ensurePhysicsTeacherDocumentRenderer,
  PHYSICS_TEACHER_DOCUMENT_RENDERER_RELATIVE_PATH
} from "./document-renderer.js";
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
import {
  buildPhysicsQuestionCandidatePack,
  PhysicsQuestionCandidate,
  renderPhysicsQuestionCandidatePack
} from "./question-bank-candidates.js";
import { TeachingResourceGateway } from "./resources.js";
import {
  physicsTeacherSkillInstructions,
  PhysicsTeacherSkill,
  resolvePhysicsTeacherSkills
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

export const PHYSICS_TEACHER_CANCELLED_MESSAGE = "已停止本次生成。你可以修改要求后继续追问。";

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
    ensurePhysicsTeacherDocumentRenderer(projectPaths);
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
    jobId?: string;
    modelAlias?: string;
    resourceQuery?: string;
    resourceFilters?: Record<string, unknown>;
    attachments?: PhysicsTeacherMessageAttachmentInput[];
    permissionScope?: PhysicsTeacherPermissionScope;
    followUpToMessageId?: number;
    signal?: AbortSignal;
  }): Promise<HeadlessResult> {
    const { projectSession, session } = this.getSession(input.sessionId);
    const project = this.getProject(projectSession.projectId);
    if (path.resolve(session.cwd) !== path.resolve(project.rootDir)) {
      throw new Error("Session 工作目录与项目不一致");
    }
    const projectPaths = this.projectPaths(project.id);
    ensurePhysicsTeacherDocumentRenderer(projectPaths);
    const prompt = requireText(input.prompt, "prompt");
    const turnStartMessageId = session.messages.at(-1)?.id ?? 0;
    const followUp = resolveFollowUp(session, input.followUpToMessageId);
    const businessSkills = mergePhysicsTeacherSkills(
      resolvePhysicsTeacherSkills(prompt),
      followUp?.previousUserMessage
        ? resolvePhysicsTeacherSkills(followUp.previousUserMessage.content)
        : []
    );
    const isQuestionDesign = businessSkills.some(
      (skill) => skill.name === "physics-question-design"
    );
    const resourceQuery = buildFollowUpResourceQuery(input.resourceQuery, followUp);
    const jobId = input.jobId?.trim() || randomUUID();
    const permissionScope = normalizePermissionScope(input.permissionScope);
    const preparedAttachments = preparePhysicsTeacherMessageAttachments({
      projectPaths,
      attachments: input.attachments,
      env: this.env
    });
    let contextMessageId: number | undefined;
    try {
      input.signal?.throwIfAborted();
      const resourceContext = resourceQuery
        ? await this.resources.search({
            projectId: project.id,
            query: isQuestionDesign
              ? `${resourceQuery}\n原题 真题 试卷 题目 练习 答案 解析`
              : resourceQuery,
            limit: isQuestionDesign ? 50 : undefined,
            filters: input.resourceFilters,
            signal: input.signal
          })
        : undefined;
      const questionCandidates = isQuestionDesign
        ? buildPhysicsQuestionCandidatePack({
            resources: this.listResources(project.id),
            query: `${prompt}\n${resourceQuery ?? ""}`,
            limit: 36
          })
        : [];
      contextMessageId = this.options.sessionStore.appendMessage({
        sessionId: input.sessionId,
        role: "system",
        content: buildTeacherContext(
          project,
          resourceContext,
          preparedAttachments.items,
          permissionScope,
          businessSkills,
          followUp,
          questionCandidates
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
      return await this.promptRunner({
        prompt: appendTemporaryAttachmentManifest(prompt, preparedAttachments.items),
        cwd: project.rootDir,
        sessionId: input.sessionId,
        jobId,
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
        toolRules: buildPhysicsTeacherToolRules(permissionScope),
        toolExecutionGuard: isQuestionDesign ? createQuestionDesignLookupGuard(8) : undefined,
        signal: input.signal
      });
    } catch (error) {
      if (!isCancelledRequest(error, input.signal)) throw error;
      const message = PHYSICS_TEACHER_CANCELLED_MESSAGE;
      persistCancelledTurn({
        store: this.options.sessionStore,
        sessionId: input.sessionId,
        turnStartMessageId,
        prompt: appendTemporaryAttachmentManifest(prompt, preparedAttachments.items),
        message,
        jobId
      });
      return {
        sessionId: input.sessionId,
        jobId,
        status: "cancelled",
        message
      };
    } finally {
      preparedAttachments.cleanup();
      if (preparedAttachments.items.length > 0 && contextMessageId !== undefined) {
        this.options.sessionStore.deleteMessage({
          sessionId: input.sessionId,
          messageId: contextMessageId
        });
      }
    }
  }

  recordCancelledTurn(input: {
    sessionId: string;
    turnStartMessageId: number;
    prompt: string;
    attachmentFilenames?: string[];
    jobId: string;
  }): string {
    this.getSession(input.sessionId);
    persistCancelledTurn({
      store: this.options.sessionStore,
      sessionId: input.sessionId,
      turnStartMessageId: input.turnStartMessageId,
      prompt: appendTemporaryAttachmentFilenameManifest(
        requireText(input.prompt, "prompt"),
        input.attachmentFilenames ?? []
      ),
      message: PHYSICS_TEACHER_CANCELLED_MESSAGE,
      jobId: requireText(input.jobId, "jobId")
    });
    return PHYSICS_TEACHER_CANCELLED_MESSAGE;
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
  businessSkills: PhysicsTeacherSkill[] = [],
  followUp?: PhysicsTeacherFollowUp,
  questionCandidates: PhysicsQuestionCandidate[] = []
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
  const businessSkillLines = businessSkills.length
    ? [
        "",
        "[本次已隐式采用的业务 Skill]",
        "以下工作法已直接加载，不要再次调用 Skill 工具加载相同工作法。",
        ...businessSkills.flatMap((skill) => [
          "",
          `Skill：${skill.name}`,
          physicsTeacherSkillInstructions(skill)
        ])
      ]
    : [];
  const questionBankLines = businessSkills.some((skill) => skill.name === "physics-question-design")
    ? [
        "",
        "[本次选题要求]",
        "优先从项目题库逐个知识点检索并直接选用原题。只要存在合适原题，就不能用 AI 自编题替代。",
        "每道选中题必须核对来源、原题号、题干、选项、答案以及所依赖的原图；题库缺口才允许补充新题并明确标注。"
      ]
    : [];
  const questionCandidateLines = businessSkills.some(
    (skill) => skill.name === "physics-question-design"
  )
    ? [
        "",
        "[按知识点与题型预筛的题库候选包]",
        "候选包由后端扫描项目内全部已抽取正文生成，不只是标题检索结果。原题只能从本候选包选择；不要再逐文件漫游搜索，也不要把补充检索发现的包外题目加入试卷。",
        "候选已排除答案-only、年报分析段落、残缺题干及文本中明确依赖图片/表格的题。FileRead/Grep/Glob 只能用于核对候选包内题目的原文件与答案，不能用于新增候选。某题型候选不足时直接标为题库缺口并补题，不能通过删除原图或改写包外题目凑原题。",
        "本轮最多执行 8 次 FileRead/Grep/Glob 核对。达到预算后必须停止检索，使用已核对候选完成交付；仍不可靠的题标为题库缺口，不能继续漫游搜索。",
        ...renderPhysicsQuestionCandidatePack(questionCandidates)
      ]
    : [];
  const artifactDeliveryLines = businessSkills.some(
    (skill) => skill.name === "physics-question-design"
  )
    ? [
        "",
        "[DOCX/PDF 交付方式]",
        `项目已安装受控渲染器：${PHYSICS_TEACHER_DOCUMENT_RENDERER_RELATIVE_PATH}。不要自行拼装 DOCX/PDF 二进制文件。`,
        "先用一次 FileWrite 把完整成果写成 artifacts/<文件名>.md，再运行：",
        `python3 ${PHYSICS_TEACHER_DOCUMENT_RENDERER_RELATIVE_PATH} --input artifacts/<文件名>.md --docx artifacts/<文件名>.docx --pdf artifacts/<文件名>.pdf`,
        "渲染成功后在聊天中只报告题型数量、原题占比以及 DOCX/PDF 文件名。"
      ]
    : [];
  const followUpLines = followUp
    ? [
        "",
        "[本次为追问]",
        followUp.explicitlyTargeted
          ? `教师正在针对消息 #${followUp.target.id} 继续追问。`
          : "教师在同一个 Session 中直接继续输入，这是上一轮工作的自然延续。",
        "必须结合本 Session 上一轮的要求和回答继续处理，不要把这条消息当作一个无上下文的新任务。",
        followUp.previousUserMessage
          ? `上一轮教师要求：${followUp.previousUserMessage.content.slice(0, 1_000)}`
          : undefined,
        `被追问回答摘要：${followUp.target.content.slice(0, 1_000)}`
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
    ...questionCandidateLines,
    ...artifactDeliveryLines,
    ...followUpLines,
    "",
    "[当前权限范围]",
    permissionScopeDescription(permissionScope),
    ...businessSkillLines,
    ...attachmentLines
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

interface PhysicsTeacherFollowUp {
  target: MessageRecord;
  previousUserMessage?: MessageRecord;
  explicitlyTargeted: boolean;
}

function mergePhysicsTeacherSkills(
  current: PhysicsTeacherSkill[],
  previous: PhysicsTeacherSkill[]
): PhysicsTeacherSkill[] {
  const merged = new Map<string, PhysicsTeacherSkill>();
  for (const skill of [...current, ...previous]) merged.set(skill.name, skill);
  return [...merged.values()];
}

function createQuestionDesignLookupGuard(limit: number): HeadlessToolExecutionGuard {
  let lookupCount = 0;
  return ({ toolUse }) => {
    if (!new Set(["FileRead", "Grep", "Glob"]).has(toolUse.name)) return undefined;
    lookupCount += 1;
    if (lookupCount <= limit) return undefined;
    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      content:
        "题库核对预算已用完。请立即停止检索，使用候选包和已核对内容完成组卷；不可靠的候选应标为题库缺口。现在写入 artifacts/ 中间稿并调用受控渲染器生成 DOCX/PDF。",
      isError: true,
      retryable: false
    };
  };
}

function resolveFollowUp(
  session: SessionRecord,
  followUpToMessageId: number | undefined
): PhysicsTeacherFollowUp | undefined {
  if (followUpToMessageId === undefined) {
    const target = [...session.messages].reverse().find((message) => message.role === "assistant");
    if (!target) return undefined;
    const previousUserMessage = [...session.messages]
      .reverse()
      .find((message) => message.id < target.id && message.role === "user");
    return { target, previousUserMessage, explicitlyTargeted: false };
  }
  if (!Number.isSafeInteger(followUpToMessageId) || followUpToMessageId < 1) {
    throw new Error("追问目标无效");
  }
  const target = session.messages.find((message) => message.id === followUpToMessageId);
  if (!target || target.role !== "assistant") throw new Error("要追问的回答不存在");
  const previousUserMessage = [...session.messages]
    .reverse()
    .find((message) => message.id < target.id && message.role === "user");
  return { target, previousUserMessage, explicitlyTargeted: true };
}

function buildFollowUpResourceQuery(
  resourceQuery: string | undefined,
  followUp: PhysicsTeacherFollowUp | undefined
): string | undefined {
  const current = resourceQuery?.trim();
  if (!followUp?.previousUserMessage) return current || undefined;
  const previous = followUp.previousUserMessage.content.trim();
  return [previous, current].filter(Boolean).join("\n") || undefined;
}

function isCancelledRequest(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function persistCancelledTurn(input: {
  store: SessionStore;
  sessionId: string;
  turnStartMessageId: number;
  prompt: string;
  message: string;
  jobId: string;
}): void {
  const messages = input.store.getSession(input.sessionId)?.messages ?? [];
  const turnMessages = messages.filter((message) => message.id > input.turnStartMessageId);
  if (!turnMessages.some((message) => message.role === "user")) {
    input.store.appendMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.prompt,
      metadata: { source: "physics-teacher-cancelled-turn", jobId: input.jobId }
    });
  }
  if (!turnMessages.some((message) => message.role === "assistant")) {
    input.store.appendMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: input.message,
      metadata: { source: "physics-teacher-cancelled-turn", jobId: input.jobId }
    });
  }
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
  return appendTemporaryAttachmentFilenameManifest(
    prompt,
    attachments.map((attachment) => attachment.filename)
  );
}

function appendTemporaryAttachmentFilenameManifest(
  prompt: string,
  attachmentFilenames: string[]
): string {
  if (attachmentFilenames.length === 0) return prompt;
  return [
    prompt,
    "",
    "[本次附件]",
    ...attachmentFilenames.map((filename) => `- ${path.basename(filename.replace(/\\/g, "/"))}`)
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
