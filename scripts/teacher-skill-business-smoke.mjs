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
  const toolResult = body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === "implicit-exam-skill"
  );

  response.writeHead(200, { "content-type": "application/json" });
  if (!toolResult) {
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "implicit-exam-skill",
                  type: "function",
                  function: {
                    name: "Skill",
                    arguments: JSON.stringify({ skill: "physics-exam-analysis" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 6 }
      })
    );
    return;
  }

  assert.match(toolResult.content, /EXAM_ANALYSIS_BUSINESS_MARKER/);
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "已按考试分析流程完成字段检查。SKILL_IMPLICIT_OK"
          },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 30, completion_tokens: 8 }
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
  const skillFile = path.join(
    runtime.magiPaths.skillsRoot,
    "physics-exam-analysis",
    "SKILL.md"
  );
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
    body: Buffer.from("student,question,score,max_score\n张同学,12,1,5\n李同学,12,2,5\n")
  });

  const prompt =
    "我上传了期中考试答题明细。请先检查数据字段，再按题目得分率找出全班最需要补讲的知识点。";
  assert.equal(prompt.includes("physics-exam-analysis"), false);
  assert.equal(prompt.toLowerCase().includes("skill"), false);

  const result = await runtime.service.sendMessage({
    sessionId: session.sessionId,
    prompt,
    resourceQuery: "期中 答题 明细 得分率"
  });

  assert.match(result.message, /SKILL_IMPLICIT_OK/);
  assert.equal(requests.length, 2);
  assert.ok(
    requests[0].tools.some((tool) => tool.function?.name === "Skill"),
    "Skill must be visible on the first teacher-model turn"
  );
  const firstContext = JSON.stringify(requests[0].messages);
  assert.match(firstContext, /\[Available Skills\]/);
  assert.match(firstContext, /physics-exam-analysis/);
  assert.match(firstContext, /期中答题明细\.csv/);
  assert.ok(
    requests[1].messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === "implicit-exam-skill" &&
        message.content.includes("EXAM_ANALYSIS_BUSINESS_MARKER")
    )
  );

  process.stdout.write(
    "Teacher skill business smoke passed: a natural exam-analysis request implicitly loaded physics-exam-analysis before answering.\n"
  );
} finally {
  runtime?.close();
  await new Promise((resolve) => provider.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
