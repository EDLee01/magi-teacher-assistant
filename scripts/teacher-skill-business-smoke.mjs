import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { PHYSICS_TEACHER_MODEL_ALIAS } from "../dist/physics-teacher/model-settings.js";
import { createPhysicsTeacherRuntime } from "../dist/physics-teacher/runtime.js";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "magi-teacher-skill-business-"));
const requests = [];
const provider = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests.push(body);
  const context = JSON.stringify(body.messages);
  assert.match(context, /EXAM_ANALYSIS_BUSINESS_MARKER/);
  assert.match(context, /QUESTION_DESIGN_BUSINESS_MARKER/);
  assert.match(context, /期中答题明细\.csv/);
  assert.match(context, /期中试卷\.txt/);
  assert.match(context, /参考答案\.txt/);

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "已同时加载考试分析和原题筛选流程。COMBINED_SKILLS_PRELOADED_OK"
          },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 40, completion_tokens: 8 }
    })
  );
});

await new Promise((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", () => {
    provider.off("error", reject);
    resolve();
  });
});

const providerAddress = provider.address();
const env = {
  ...process.env,
  MAGI_CONFIG_DIR: path.join(temporaryRoot, "magi"),
  MAGI_TEACHER_CONFIG_DIR: path.join(temporaryRoot, "physics-teacher"),
  MAGI_TEACHER_SKILL_TEST_KEY: "local-business-test-key"
};
let runtime;

try {
  runtime = createPhysicsTeacherRuntime(env);
  const skillFile = path.join(runtime.magiPaths.skillsRoot, "physics-exam-analysis", "SKILL.md");
  await assert.doesNotReject(() => access(skillFile));

  const config = loadConfig(runtime.magiPaths, env);
  config.providers["teacher-skill-business"] = {
    type: "openai",
    apiKeyEnv: "MAGI_TEACHER_SKILL_TEST_KEY",
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    defaultModel: "skill-business-model",
    endpoint: "chat"
  };
  config.models.aliases[PHYSICS_TEACHER_MODEL_ALIAS] =
    "teacher-skill-business:skill-business-model";
  runtime.service.updateConfig(config);

  const project = runtime.service.createProject({
    name: "高一三班期中考试",
    grade: "高一",
    className: "3班",
    textbookVersion: "人教版必修第一册"
  });
  const session = runtime.service.createSession({
    projectId: project.id,
    title: "期中考试学情诊断",
    kind: "exam-analysis"
  });
  runtime.service.uploadResource({
    projectId: project.id,
    filename: "期中答题明细.csv",
    mimeType: "text/csv",
    body: Buffer.from("student,question,score,max_score\nS01,12,1,5\nS02,12,2,5\n")
  });
  runtime.service.uploadResource({
    projectId: project.id,
    filename: "期中试卷.txt",
    mimeType: "text/plain",
    body: Buffer.from("第12题考查滑动摩擦力，第13题考查浮力。")
  });
  runtime.service.uploadResource({
    projectId: project.id,
    filename: "参考答案.txt",
    mimeType: "text/plain",
    body: Buffer.from("第12题：2N；第13题：增大。")
  });
  runtime.service.uploadResource({
    projectId: project.id,
    filename: "同知识点原题库.txt",
    mimeType: "text/plain",
    body: Buffer.from("2024广州一模第6题：滑动摩擦力；2023广州中考第7题：浮力。")
  });

  const prompt =
    "请检查期中考试答题明细，按逐题得分率完成考试分析，找出低于60%的知识点，再从题库检索相同知识点的原题作为训练。";
  assert.equal(prompt.includes("physics-exam-analysis"), false);
  assert.equal(prompt.toLowerCase().includes("skill"), false);

  const result = await runtime.service.sendMessage({
    sessionId: session.sessionId,
    prompt,
    resourceQuery: "期中 答题 明细 得分率"
  });

  assert.match(result.message, /COMBINED_SKILLS_PRELOADED_OK/);
  assert.equal(requests.length, 1);
  assert.ok(
    requests[0].tools.some((tool) => tool.function?.name === "Skill"),
    "Skill must be visible on the first teacher-model turn"
  );
  const firstContext = JSON.stringify(requests[0].messages);
  assert.match(firstContext, /\[本次已隐式采用的业务 Skill\]/);
  assert.match(firstContext, /physics-exam-analysis/);
  assert.match(firstContext, /physics-question-design/);
  assert.match(firstContext, /EXAM_ANALYSIS_BUSINESS_MARKER/);
  assert.match(firstContext, /QUESTION_DESIGN_BUSINESS_MARKER/);
  assert.match(firstContext, /期中答题明细\.csv/);
  assert.equal(
    requests[0].messages.some((message) => message.role === "tool"),
    false
  );

  process.stdout.write(
    "Teacher skill business smoke passed: a combined exam-analysis and original-question request preloaded both workflows before answering.\n"
  );
} finally {
  runtime?.close();
  await new Promise((resolve) => provider.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
