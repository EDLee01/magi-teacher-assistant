import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { HeadlessResult, runHeadlessPrompt } from "../src/headless.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import {
  ensurePhysicsTeacherPaths,
  getPhysicsTeacherPaths,
  PhysicsTeacherPaths
} from "../src/physics-teacher/paths.js";
import {
  normalizePhysicsTeacherModelSettings,
  PHYSICS_TEACHER_MODEL_ALIAS,
  PHYSICS_TEACHER_OPENAI_KEY_ENV,
  readPhysicsTeacherModelSettings,
  writePhysicsTeacherModelSettings
} from "../src/physics-teacher/model-settings.js";
import { PhysicsTeacherProjectStore } from "../src/physics-teacher/project-store.js";
import { TeachingResourceGateway } from "../src/physics-teacher/resources.js";
import { startPhysicsTeacherHttpServer } from "../src/physics-teacher/server.js";
import { PhysicsTeacherService } from "../src/physics-teacher/service.js";
import {
  physicsTeacherSkillInstructions,
  resolvePhysicsTeacherSkill,
  resolvePhysicsTeacherSkills
} from "../src/physics-teacher/skills.js";
import {
  createPhysicsTeacherRuntime,
  PhysicsTeacherRuntime
} from "../src/physics-teacher/runtime.js";
import {
  buildPhysicsTeacherRuntimeEnv,
  buildPhysicsTeacherToolRules,
  PHYSICS_TEACHER_ALWAYS_TOOLS,
  PHYSICS_TEACHER_ON_DEMAND_TOOLS
} from "../src/physics-teacher/tool-profile.js";
import { SessionStore } from "../src/session-store.js";
import { filterToolDefinitionsByRules } from "../src/tool-policy.js";
import {
  checkToolPermission,
  executeRegisteredTool,
  getBuiltinToolDefinitions
} from "../src/tools/registry.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;
let projectStore: PhysicsTeacherProjectStore | undefined;
let sessionStore: SessionStore | undefined;
let server: http.Server | undefined;
let runtime: PhysicsTeacherRuntime | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
  sessionStore?.close();
  sessionStore = undefined;
  projectStore?.close();
  projectStore = undefined;
  runtime?.close();
  runtime = undefined;
  temp?.cleanup();
  temp = undefined;
});

describe("Magi 教师助手 backend", () => {
  it("stores OpenAI-compatible URL and model without writing the API key", () => {
    temp = makeTempRoot("magi-physics-teacher-model-settings-");
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    temp.env[PHYSICS_TEACHER_OPENAI_KEY_ENV] = "desktop-test-key";

    const settings = writePhysicsTeacherModelSettings({
      paths,
      baseUrl: "https://models.example.test/v1/",
      model: "physics-model",
      env: temp.env
    });
    const configText = readFileSync(paths.configFile, "utf8");
    const config = loadConfig(paths, temp.env);

    expect(settings).toEqual({
      baseUrl: "https://models.example.test/v1",
      model: "physics-model"
    });
    expect(readPhysicsTeacherModelSettings(paths, temp.env)).toEqual(settings);
    expect(config.providers["physics-teacher-openai"]).toMatchObject({
      type: "openai",
      apiKeyEnv: PHYSICS_TEACHER_OPENAI_KEY_ENV,
      endpoint: "chat"
    });
    expect(config.models.aliases[PHYSICS_TEACHER_MODEL_ALIAS]).toBe(
      "physics-teacher-openai:physics-model"
    );
    expect(configText).not.toContain("desktop-test-key");
    expect(() =>
      normalizePhysicsTeacherModelSettings({
        baseUrl: "http://models.example.test/v1",
        model: "physics-model"
      })
    ).toThrow("远程接口必须使用 HTTPS");
    expect(
      normalizePhysicsTeacherModelSettings({
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "local-model"
      })
    ).toEqual({ baseUrl: "http://127.0.0.1:8000/v1", model: "local-model" });
  });

  it("shares one reusable runtime between the CLI and desktop app", () => {
    temp = makeTempRoot("magi-physics-teacher-runtime-test-");
    runtime = createPhysicsTeacherRuntime(temp.env);

    const project = runtime.service.createProject({
      name: "高一物理",
      grade: "高一",
      className: "3班"
    });

    expect(runtime.service.listProjects()).toEqual([
      expect.objectContaining({ id: project.id, name: "高一物理" })
    ]);
    expect(runtime.paths.projectsRoot).toContain("physics-teacher");
    expect(existsSync(`${runtime.magiPaths.skillsRoot}/physics-exam-analysis/SKILL.md`)).toBe(true);
    const questionSkillPath = `${runtime.magiPaths.skillsRoot}/physics-question-design/SKILL.md`;
    expect(existsSync(questionSkillPath)).toBe(true);
    runtime.close();
    writeFileSync(
      questionSkillPath,
      "---\nname: physics-question-design\n---\n旧版规则\nQUESTION_DESIGN_BUSINESS_MARKER\n",
      "utf8"
    );
    runtime = createPhysicsTeacherRuntime(temp.env);
    expect(readFileSync(questionSkillPath, "utf8")).toContain("原题优先原则");
    expect(readFileSync(questionSkillPath, "utf8")).toContain("render_teacher_document.py");
    expect(() => runtime!.close()).not.toThrow();
  });

  it("implicitly loads the question-design workflow for natural teacher requests", async () => {
    let captured: Parameters<typeof runHeadlessPrompt>[0] | undefined;
    const promptRunner: typeof runHeadlessPrompt = async (input) => {
      captured = input;
      return {
        sessionId: input.sessionId!,
        jobId: "question-design-skill-test",
        status: "completed",
        message: "已完成十道题"
      };
    };
    const { service } = setup({}, undefined, promptRunner);
    const project = service.createProject({
      name: "初二物理",
      grade: "初二",
      className: "1班"
    });
    const session = service.createSession({
      projectId: project.id,
      title: "小卷命题",
      kind: "practice-adjustment"
    });

    await service.sendMessage({
      sessionId: session.sessionId,
      prompt: "参考广州中考题库出10道题，5道选择、2道填空、3道大题"
    });

    const context = sessionStore!
      .getSession(session.sessionId)!
      .messages.find((message) => message.role === "system")!.content;
    expect(context).toContain("[本次已隐式采用的业务 Skill]");
    expect(context).toContain("physics-question-design");
    expect(context).toContain("QUESTION_DESIGN_BUSINESS_MARKER");
    expect(context).toContain("目标是可用原题占 100%");
    expect(context).toContain("只要存在合适原题，就不能用 AI 自编题替代");
    expect(context).toContain("删除“如图”");
    expect(context).toContain("不得把删改后的题目统计为原题");
    expect(context).toContain("不会自动搬运来源文件中的图片");
    expect(context).toContain("不能以“文字信息足够作答”为理由省略原图");
    expect(context).toContain("[DOCX/PDF 交付方式]");
    expect(context).toContain("render_teacher_document.py");
    expect(context).toContain("本轮最多执行 8 次 FileRead/Grep/Glob 核对");
    expect(context).toContain("原题只能从本候选包选择");
    expect(context).toContain("不能用于新增候选");
    expect(context).toContain("交付时同时给出：学生用试卷、答案与解析、选题来源表");
    expect(context).toContain("可预览、可打开的文件卡片");
    expect(
      existsSync(`${project.rootDir}/workspace/analysis-scripts/render_teacher_document.py`)
    ).toBe(true);
    expect(captured?.toolExecutionGuard).toBeTypeOf("function");
    for (let index = 0; index < 8; index += 1) {
      expect(
        captured!.toolExecutionGuard!({
          toolUse: { type: "tool-use", id: `lookup-${index}`, name: "Grep", input: {} }
        })
      ).toBeUndefined();
    }
    expect(
      captured!.toolExecutionGuard!({
        toolUse: { type: "tool-use", id: "lookup-over-budget", name: "FileRead", input: {} }
      })
    ).toMatchObject({ isError: true, retryable: false });
    const match = resolvePhysicsTeacherSkill("请参考题库生成一套物理模拟题");
    expect(match?.name).toBe("physics-question-design");
    expect(physicsTeacherSkillInstructions(match!)).not.toContain("description:");
  });

  it("loads exam analysis and original-question selection together for a combined task", async () => {
    const promptRunner: typeof runHeadlessPrompt = async (input) => ({
      sessionId: input.sessionId!,
      jobId: "combined-business-skill-test",
      status: "completed",
      message: "已完成分析并从题库筛选原题"
    });
    const { service } = setup({}, undefined, promptRunner);
    const project = service.createProject({
      name: "九年级期中分析",
      grade: "九年级",
      className: "2班"
    });
    const session = service.createSession({
      projectId: project.id,
      title: "分析后配题",
      kind: "exam-analysis"
    });
    const prompt =
      "请按逐题得分率完成考试分析，找出低于60%的知识点，再从题库检索相同知识点的原题作为训练。";

    await service.sendMessage({ sessionId: session.sessionId, prompt });

    const context = sessionStore!
      .getSession(session.sessionId)!
      .messages.find((message) => message.role === "system")!.content;
    expect(context).toContain("Skill：physics-exam-analysis");
    expect(context).toContain("EXAM_ANALYSIS_BUSINESS_MARKER");
    expect(context).toContain("连续档位时");
    expect(context).toContain("不能称为两极分化");
    expect(context).toContain("Skill：physics-question-design");
    expect(context).toContain("QUESTION_DESIGN_BUSINESS_MARKER");
    expect(context).toContain("目标是可用原题占 100%");
    expect(context).toContain("[按知识点与题型预筛的题库候选包]");
    expect(context).toContain("不要再逐文件漫游搜索");
    expect(resolvePhysicsTeacherSkills(prompt).map((skill) => skill.name)).toEqual([
      "physics-exam-analysis",
      "physics-question-design"
    ]);
  });

  it("isolates projects while sharing Magi memory across sessions in one project", () => {
    const { service, teacherPaths } = setup();
    const project = service.createProject({
      name: "高一力学教研",
      grade: "高一",
      className: "3班",
      textbookVersion: "人教版"
    });
    const first = service.createSession({
      projectId: project.id,
      title: "期中考试分析",
      kind: "exam-analysis"
    });
    const second = service.createSession({
      projectId: project.id,
      title: "牛顿第二定律备课",
      kind: "lesson-planning"
    });

    expect(sessionStore!.getSession(first.sessionId)?.cwd).toBe(project.rootDir);
    expect(sessionStore!.getSession(second.sessionId)?.cwd).toBe(project.rootDir);
    expect(readFileSync(`${project.rootDir}/AGENTS.md`, "utf8")).toContain("Magi 教师助手");
    expect(readFileSync(`${project.rootDir}/.gitignore`, "utf8")).toContain("uploads/");
    expect(existsSync(`${project.rootDir}/.git`)).toBe(true);
    expect(service.readMemory(project.id, "projects/context.md")).toContain("高一力学教研");

    const other = service.createProject({
      name: "初二光学教研",
      grade: "初二",
      className: "1班"
    });
    expect(other.rootDir).not.toBe(project.rootDir);
    expect(service.readMemory(other.id, "projects/context.md")).not.toContain("高一力学教研");
    expect(project.rootDir.startsWith(teacherPaths.projectsRoot)).toBe(true);
  });

  it("only adds session findings to formal memory after teacher review", () => {
    const { service } = setup();
    const project = service.createProject({
      name: "八年级物理",
      grade: "八年级",
      className: "2班"
    });
    const session = service.createSession({
      projectId: project.id,
      title: "月考分析",
      kind: "exam-analysis"
    });
    const draft = service.proposeMemory({
      projectId: project.id,
      category: "session",
      sourceSession: session.sessionId,
      content: "学生对速度图像斜率的意义容易混淆。",
      reason: "月考错题统计",
      confidence: 0.9
    });

    expect(draft.status).toBe("pending");
    expect(service.listMemoryDrafts(project.id)).toEqual([
      expect.objectContaining({ id: draft.id, status: "pending" })
    ]);
    expect(() => service.readMemory(project.id, `sessions/${session.sessionId}.md`)).toThrow();

    service.applyMemoryDraft(project.id, draft.id);
    expect(service.readMemory(project.id, `sessions/${session.sessionId}.md`)).toContain(
      "速度图像斜率"
    );
  });

  it("stores uploads privately and keeps remote API secrets out of source metadata", async () => {
    const calls: Array<{ authorization?: string; body?: string }> = [];
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        authorization: headers.get("authorization") ?? undefined,
        body: typeof init?.body === "string" ? init.body : undefined
      });
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "curriculum-8-3",
              title: "课标：运动和力",
              kind: "curriculum",
              snippet: "能用牛顿第一定律解释生活中的有关现象。",
              source: "校本资料库"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const env = { MATERIALS_API_KEY: "private-secret" };
    const { service } = setup(env, fakeFetch);
    const project = service.createProject({
      name: "八年级物理",
      grade: "八年级",
      className: "2班"
    });
    const resource = service.uploadResource({
      projectId: project.id,
      filename: "../../学生成绩.csv",
      body: Buffer.from("name,score\n张同学,82\n"),
      mimeType: "text/csv"
    });

    expect(resource.originalFilename).toBe("学生成绩.csv");
    expect(resource.storagePath).toBeTruthy();
    expect(existsSync(resource.storagePath!)).toBe(true);
    expect(resource.storagePath!.startsWith(project.rootDir)).toBe(true);
    expect(statSync(resource.storagePath!).mode & 0o777).toBe(0o600);
    expect(resource.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    const duplicate = service.uploadResource({
      projectId: project.id,
      filename: "学生成绩-重复副本.csv",
      body: Buffer.from("name,score\n张同学,82\n"),
      mimeType: "text/csv"
    });
    expect(duplicate.id).toBe(resource.id);
    expect(service.listResources(project.id)).toHaveLength(1);
    const wiki = service.getKnowledgeWiki(project.id);
    expect(wiki.resourceCount).toBe(1);
    expect(wiki.categories).toContainEqual(
      expect.objectContaining({ id: "student-learning", count: 1 })
    );
    expect(readFileSync(`${project.rootDir}/workspace/wiki/INDEX.md`, "utf8")).toContain(
      "项目教学知识库"
    );
    expect(
      readFileSync(`${project.rootDir}/workspace/wiki/sources/${resource.id}.md`, "utf8")
    ).toContain("张同学,82");

    const naturalLanguageSearch = await service.searchResources({
      projectId: project.id,
      query: "请根据我刚上传的学生成绩文件分析这次考试"
    });
    expect(naturalLanguageSearch.items).toContainEqual(
      expect.objectContaining({ title: "学生成绩.csv", source: "教师上传资料" })
    );

    service.uploadResource({
      projectId: project.id,
      filename: "声学原题库.txt",
      body: Buffer.from(
        `${"资料目录。".repeat(800)}\n（2022天河一模第5题）声音测试仪测得甲为50dB、乙为20dB，关于声音响度的判断正确的是（ ）\nA. 甲的响度更大 B. 乙的音调更高 C. 两者速度不同 D. 两者频率一定相同`
      ),
      mimeType: "text/plain"
    });
    const originalQuestionSearch = await service.searchResources({
      projectId: project.id,
      query: "请从题库找声音响度知识点的原题"
    });
    const originalQuestion = originalQuestionSearch.items.find(
      (item) => item.title === "声学原题库.txt"
    );
    expect(originalQuestion?.snippet).toContain("2022天河一模第5题");
    expect(originalQuestion?.snippet).toContain("甲为50dB、乙为20dB");
    expect(originalQuestion?.snippet?.length).toBeLessThanOrEqual(1_502);

    const source = service.addRemoteResourceSource({
      projectId: project.id,
      name: "校本资料库",
      baseUrl: "https://materials.example.test",
      apiKeyEnv: "MATERIALS_API_KEY"
    });
    expect(source.config).toMatchObject({ apiKeyEnv: "MATERIALS_API_KEY" });
    expect(JSON.stringify(source.config)).not.toContain("private-secret");
    service.addRemoteResourceSource({
      projectId: project.id,
      name: "未配置的资料库",
      baseUrl: "https://missing.example.test",
      apiKeyEnv: "MISSING_MATERIALS_API_KEY"
    });

    const result = await service.searchResources({
      projectId: project.id,
      query: "牛顿第一定律"
    });
    expect(result.items).toEqual([
      expect.objectContaining({ id: "curriculum-8-3", source: "校本资料库" })
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining("缺少资料接口密钥环境变量：MISSING_MATERIALS_API_KEY")
    ]);
    expect(calls[0].authorization).toBe("Bearer private-secret");
    expect(calls[0].body).toContain("牛顿第一定律");
  });

  it("uses message attachments for one turn without adding them to project resources", async () => {
    let temporaryPath = "";
    const promptRunner: typeof runHeadlessPrompt = async (input) => {
      const messages = input.store.getSession(input.sessionId!)!.messages;
      const context = [...messages].reverse().find((message) => message.role === "system")?.content;
      expect(context).toContain("[本次对话临时资料]");
      expect(context).toContain("本轮测验.csv");
      expect(context).toContain("student,score");
      temporaryPath = context!.match(/临时读取路径：([^\n]+)/)?.[1] ?? "";
      expect(temporaryPath).toBeTruthy();
      expect(existsSync(`${input.cwd}/${temporaryPath}`)).toBe(true);
      expect(input.prompt).toContain("[本次附件]\n- 本轮测验.csv");
      return {
        sessionId: input.sessionId!,
        jobId: "message-attachment-test",
        status: "completed",
        message: "已处理本次资料"
      } satisfies HeadlessResult;
    };
    const { service } = setup({}, undefined, promptRunner);
    const project = service.createProject({
      name: "高一物理",
      grade: "高一",
      className: "3班"
    });
    const session = service.createSession({
      projectId: project.id,
      title: "随堂测验分析",
      kind: "exam-analysis"
    });

    const result = await service.sendMessage({
      sessionId: session.sessionId,
      prompt: "看一下这次小测",
      attachments: [
        {
          filename: "本轮测验.csv",
          body: Buffer.from("student,score\n张同学,82\n"),
          mimeType: "text/csv"
        }
      ]
    });

    expect(result.message).toBe("已处理本次资料");
    expect(service.listResources(project.id)).toEqual([]);
    expect(temporaryPath).toBeTruthy();
    expect(existsSync(`${project.rootDir}/${temporaryPath}`)).toBe(false);
    expect(
      sessionStore!
        .getSession(session.sessionId)!
        .messages.some((message) => message.content.includes("[本次对话临时资料]"))
    ).toBe(false);
  });

  it("keeps the prior task when the teacher continues naturally in the same Session", async () => {
    let captured: Parameters<typeof runHeadlessPrompt>[0] | undefined;
    const promptRunner: typeof runHeadlessPrompt = async (input) => {
      captured = input;
      return {
        sessionId: input.sessionId!,
        jobId: input.jobId!,
        status: "completed",
        message: "已按追问继续调整"
      } satisfies HeadlessResult;
    };
    const { service } = setup({}, undefined, promptRunner);
    const project = service.createProject({ name: "追问测试", grade: "九年级", className: "2班" });
    const session = service.createSession({
      projectId: project.id,
      title: "声学原题筛选",
      kind: "practice-adjustment"
    });
    sessionStore!.appendMessage({
      sessionId: session.sessionId,
      role: "user",
      content: "从题库中找三道声音的响度和音调原题"
    });
    sessionStore!.appendMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "已经找到三道广州中考原题，并逐题列出来源。"
    });

    await service.sendMessage({
      sessionId: session.sessionId,
      prompt: "第二道太简单了，换成难一点的",
      resourceQuery: "第二道太简单了，换成难一点的"
    });

    const context = sessionStore!
      .getSession(session.sessionId)!
      .messages.filter((message) => message.role === "system")
      .at(-1)!.content;
    expect(context).toContain("[本次为追问]");
    expect(context).toContain("同一个 Session 中直接继续输入");
    expect(context).toContain("从题库中找三道声音的响度和音调原题");
    expect(context).toContain("已经找到三道广州中考原题");
    expect(context).toContain("physics-question-design");
    expect(captured?.prompt).toBe("第二道太简单了，换成难一点的");
    expect(captured?.jobId).toBeTruthy();
    await expect(
      service.sendMessage({
        sessionId: session.sessionId,
        prompt: "继续",
        followUpToMessageId: 999_999
      })
    ).rejects.toThrow("要追问的回答不存在");
  });

  it("cancels a running teacher response and persists a resumable turn", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const promptRunner: typeof runHeadlessPrompt = async (input) => {
      input.store.appendMessage({
        sessionId: input.sessionId!,
        role: "user",
        content: input.prompt
      });
      started();
      await new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(new DOMException(String(input.signal?.reason ?? "stopped"), "AbortError"));
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener("abort", abort, { once: true });
      });
      throw new Error("unreachable");
    };
    const { service } = setup({}, undefined, promptRunner);
    const project = service.createProject({ name: "打断测试", grade: "八年级", className: "1班" });
    const session = service.createSession({
      projectId: project.id,
      title: "长任务",
      kind: "lesson-planning"
    });
    const controller = new AbortController();
    const pending = service.sendMessage({
      sessionId: session.sessionId,
      prompt: "请整理一份完整的单元教学方案",
      signal: controller.signal
    });
    await didStart;
    const immediateMessage = service.recordCancelledTurn({
      sessionId: session.sessionId,
      turnStartMessageId: 0,
      prompt: "请整理一份完整的单元教学方案",
      jobId: "desktop-cancel-test"
    });
    expect(immediateMessage).toBe("已停止本次生成。你可以修改要求后继续追问。");
    controller.abort("教师停止了本次生成");
    const result = await pending;

    expect(result.status).toBe("cancelled");
    expect(result.message).toContain("继续追问");
    const messages = sessionStore!
      .getSession(session.sessionId)!
      .messages.filter((message) => message.role === "user" || message.role === "assistant");
    expect(messages.at(-2)?.content).toContain("完整的单元教学方案");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "已停止本次生成。你可以修改要求后继续追问。"
    });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("batch imports a folder-shaped resource stream and rebuilds the wiki once", async () => {
    const { service } = setup();
    const project = service.createProject({
      name: "高二电磁学",
      grade: "高二",
      className: "1班"
    });
    async function* uploads() {
      yield {
        filename: "课程标准.md",
        body: Buffer.from("# 电磁学课程要求\n能分析带电粒子在电场中的运动。"),
        mimeType: "text/markdown",
        metadata: { importPath: "高二资料/教材/课程标准.md", importedFrom: "folder" }
      };
      yield {
        filename: "期中答题明细.csv",
        body: Buffer.from("student,q1\n王同学,0\n"),
        mimeType: "text/csv",
        metadata: { importPath: "高二资料/考试/期中答题明细.csv", importedFrom: "folder" }
      };
    }

    const result = await service.uploadResources({ projectId: project.id, resources: uploads() });

    expect(result.added).toHaveLength(2);
    expect(result.duplicateCount).toBe(0);
    expect(result.wiki.resourceCount).toBe(2);
    expect(result.wiki.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "curriculum-textbooks", count: 1 }),
        expect.objectContaining({ id: "student-learning", count: 1 })
      ])
    );
    const categoryPage = readFileSync(
      `${project.rootDir}/workspace/wiki/student-learning.md`,
      "utf8"
    );
    expect(categoryPage).toContain("高二资料/考试/期中答题明细.csv");
  });

  it("runs a session with project-scoped memory and retrieved teaching evidence", async () => {
    let captured: Parameters<typeof runHeadlessPrompt>[0] | undefined;
    const promptRunner: typeof runHeadlessPrompt = async (input) => {
      captured = input;
      return {
        sessionId: input.sessionId!,
        jobId: "job-test",
        status: "completed",
        message: "建议先检查受力分析。"
      } satisfies HeadlessResult;
    };
    const { service } = setup({}, undefined, promptRunner);
    const project = service.createProject({
      name: "高一力学",
      grade: "高一",
      className: "3班"
    });
    const session = service.createSession({
      projectId: project.id,
      title: "期中分析",
      kind: "exam-analysis"
    });
    service.uploadResource({
      projectId: project.id,
      filename: "期中分析.txt",
      body: Buffer.from("第12题得分率较低，主要错误是漏画摩擦力。"),
      mimeType: "text/plain"
    });
    const updatedConfig = loadConfig(getMagiPaths(temp!.env), temp!.env);
    updatedConfig.providers.desktop = {
      type: "openai",
      baseUrl: "https://models.example.test/v1",
      defaultModel: "physics-model"
    };
    updatedConfig.models.aliases[PHYSICS_TEACHER_MODEL_ALIAS] = "desktop:physics-model";
    service.updateConfig(updatedConfig);

    const result = await service.sendMessage({
      sessionId: session.sessionId,
      prompt: "我下一节课先讲什么？",
      resourceQuery: "摩擦力"
    });

    expect(result.message).toContain("受力分析");
    expect(captured?.cwd).toBe(project.rootDir);
    expect(captured?.permissionMode).toBe("dontAsk");
    expect(captured?.config.memory.root).toContain(project.id);
    expect(captured?.config.models.aliases[PHYSICS_TEACHER_MODEL_ALIAS]).toBe(
      "desktop:physics-model"
    );
    expect(captured?.modelAlias).toBe(PHYSICS_TEACHER_MODEL_ALIAS);
    expect(captured?.env?.MAGI_TOOL_LOAD).toBe("minimal");
    expect(captured?.env?.MAGI_BASH_TIMEOUT_MS).toBe("60000");
    expect(captured?.prompt).toBe("我下一节课先讲什么？");
    expect(
      sessionStore!
        .getSession(session.sessionId)
        ?.messages.find((message) => message.role === "system")?.content
    ).toContain("第12题得分率较低");

    service.setApprovalResolver(async () => true);
    await service.sendMessage({
      sessionId: session.sessionId,
      prompt: "把结论整理成文件",
      permissionScope: "approval"
    });
    expect(captured?.permissionMode).toBe("default");
    expect(captured?.approvalResolver).toBeTypeOf("function");
    expect(
      sessionStore!
        .getSession(session.sessionId)!
        .messages.filter((message) => message.role === "system")
        .at(-1)?.content
    ).toContain("操作前询问");
  });

  it("keeps useful Magi tools on demand while restricting writes and shell commands", async () => {
    const rules = buildPhysicsTeacherToolRules();
    const visibleTools = filterToolDefinitionsByRules(getBuiltinToolDefinitions(), rules).map(
      (tool) => tool.name
    );

    expect(PHYSICS_TEACHER_ALWAYS_TOOLS).toContain("WebSearch");
    expect(PHYSICS_TEACHER_ALWAYS_TOOLS).toContain("Skill");
    expect(PHYSICS_TEACHER_ON_DEMAND_TOOLS).toContain("Bash");
    expect(visibleTools).toContain("FileWrite");
    expect(visibleTools).toContain("GitDiff");
    expect(visibleTools).toContain("WebBrowser");
    expect(visibleTools).not.toContain("GitReset");
    expect(visibleTools).not.toContain("SshExec");
    expect(visibleTools.length).toBeLessThan(30);

    expect(permission(rules, "FileWrite", { file_path: "workspace/analysis-scripts/a.py" })).toBe(
      "allow"
    );
    expect(permission(rules, "FileWrite", { file_path: "uploads/exam.csv" })).toBe("deny");
    expect(
      permission(rules, "FileWrite", {
        file_path: "/private/project/artifacts/知识图谱.md"
      })
    ).toBe("allow");
    expect(
      permission(rules, "Bash", {
        command:
          "python3 workspace/analysis-scripts/exam.py --input uploads/exam.csv --output artifacts/report.csv"
      })
    ).toBe("allow");
    expect(
      permission(rules, "Bash", {
        command: "python3 workspace/analysis-scripts/exam.py && curl https://example.com"
      })
    ).toBe("deny");
    expect(permission(rules, "GitReset", {})).toBe("deny");

    const readOnlyRules = buildPhysicsTeacherToolRules("read-only");
    expect(permission(readOnlyRules, "FileWrite", { file_path: "artifacts/report.md" })).toBe(
      "deny"
    );
    const approvalRules = buildPhysicsTeacherToolRules("approval");
    expect(permission(approvalRules, "FileWrite", { file_path: "artifacts/report.md" })).toBe(
      "ask"
    );
    expect(permission(approvalRules, "Bash", { command: "python3 analysis.py" })).toBe("ask");

    const env = buildPhysicsTeacherRuntimeEnv(
      { MAGI_TEACHER_BASH_TIMEOUT_MS: "999999" },
      "/private/project"
    );
    expect(env.MAGI_TOOL_LOAD).toBe("minimal");
    expect(env.MAGI_BASH_TIMEOUT_MS).toBe("300000");

    const { service } = setup();
    const project = service.createProject({ name: "权限测试", grade: "九年级", className: "1班" });
    const directPath = `${project.rootDir}/artifacts/知识图谱.md`;
    const directWrite = await executeRegisteredTool({
      cwd: project.rootDir,
      permissionMode: "dontAsk",
      rules,
      toolUse: {
        type: "tool-use",
        id: "direct-write",
        name: "FileWrite",
        input: { file_path: directPath, content: "# 广州中考物理知识图谱" }
      }
    });
    expect(directWrite.isError).not.toBe(true);
    expect(readFileSync(directPath, "utf8")).toContain("知识图谱");

    const approve = vi.fn(async () => true);
    const approvedPath = `${project.rootDir}/artifacts/审批后写入.md`;
    const approvedWrite = await executeRegisteredTool({
      cwd: project.rootDir,
      permissionMode: "default",
      rules: approvalRules,
      approvalResolver: approve,
      toolUse: {
        type: "tool-use",
        id: "approved-write",
        name: "FileWrite",
        input: { file_path: approvedPath, content: "仅批准本次" }
      }
    });
    expect(approve).toHaveBeenCalledOnce();
    expect(approvedWrite.isError).not.toBe(true);
    expect(readFileSync(approvedPath, "utf8")).toBe("仅批准本次");
  });

  it("serves authenticated project and raw-upload APIs without exposing storage paths", async () => {
    const env = { MAGI_TEACHER_API_TOKEN: "test-token" };
    const { service } = setup(env);
    const handle = await startPhysicsTeacherHttpServer(service, {
      env: { ...temp!.env, ...env },
      bind: "127.0.0.1",
      port: 0
    });
    server = handle.server;
    const baseUrl = `http://${handle.bind}:${handle.port}`;

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/projects`)).status).toBe(401);
    const createdResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "高一物理", grade: "高一", className: "1班" })
    });
    const created = (await createdResponse.json()) as {
      project: { id: string; rootDir?: string };
    };
    expect(createdResponse.status).toBe(201);
    expect(created.project.rootDir).toBeUndefined();

    const uploadResponse = await fetch(
      `${baseUrl}/api/projects/${created.project.id}/resources/upload?filename=exam.csv`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "text/csv" },
        body: "question,correct_rate\n12,0.41\n"
      }
    );
    const upload = (await uploadResponse.json()) as {
      resource: { title: string; storagePath?: string };
    };
    expect(uploadResponse.status).toBe(201);
    expect(upload.resource.title).toBe("exam.csv");
    expect(upload.resource.storagePath).toBeUndefined();
  });
});

function setup(
  extraEnv: NodeJS.ProcessEnv = {},
  fetchImpl?: typeof fetch,
  promptRunner?: typeof runHeadlessPrompt
): {
  service: PhysicsTeacherService;
  teacherPaths: PhysicsTeacherPaths;
} {
  temp = makeTempRoot("magi-physics-teacher-test-");
  const env = { ...temp.env, ...extraEnv };
  const magiPaths = getMagiPaths(env);
  ensureMagiHome(magiPaths);
  const teacherPaths = getPhysicsTeacherPaths(magiPaths, env);
  ensurePhysicsTeacherPaths(teacherPaths);
  projectStore = new PhysicsTeacherProjectStore(teacherPaths.databaseFile);
  sessionStore = SessionStore.open(magiPaths);
  const resources = new TeachingResourceGateway(projectStore, env, fetchImpl ?? fetch);
  return {
    service: new PhysicsTeacherService({
      magiPaths,
      paths: teacherPaths,
      config: loadConfig(magiPaths, env),
      projectStore,
      sessionStore,
      resources,
      env,
      promptRunner
    }),
    teacherPaths
  };
}

function permission(
  rules: ReturnType<typeof buildPhysicsTeacherToolRules>,
  name: string,
  input: Record<string, unknown>
): string {
  return checkToolPermission({
    toolUse: { type: "tool-use", id: "test", name, input },
    mode: "dontAsk",
    rules
  }).decision;
}
