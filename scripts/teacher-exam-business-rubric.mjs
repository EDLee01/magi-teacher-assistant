import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateTeacherExamBusinessResult(message) {
  assert.equal(typeof message, "string");
  assert.ok(message.length > 500, "业务分析内容过短");
  assert.match(message, /(第\s*3\s*题|Q3)/i, "没有识别第3题");
  assert.match(message, /50(?:\.0+)?\s*%/, "第3题得分率应为50%");
  assert.match(message, /(第\s*4\s*题|Q4)/i, "没有识别第4题");
  assert.match(message, /58(?:\.0+)?\s*%/, "第4题得分率应为58%");
  assert.match(message, /滑动摩擦力|摩擦力/, "没有对应第3题知识点");
  assert.match(message, /浮力|阿基米德/, "没有对应第4题知识点");
  assert.match(message, /Python|脚本计算|工具计算/, "逐题统计没有留下脚本计算证据");
  const calculationDescription = message.replace(
    /(?:非|不是|无需|不依靠|未使用)(?:手工复核|手工计算|手算|心算)/g,
    ""
  );
  assert.doesNotMatch(
    calculationDescription,
    /手工复核|手工计算|手算|依靠心算|使用心算/,
    "考试统计不应依赖手工计算"
  );
  assert.match(message, /数据事实|事实/, "没有区分数据事实");
  assert.match(message, /教学解释|教学判断|可能原因/, "没有区分教学解释");
  assert.match(message, /尚待.*确认|需要教师确认|待核实/, "没有列出待确认内容");
  assert.doesNotMatch(
    message,
    /Q4[\s\S]{0,300}(两极形态|两极分化)/,
    "Q4覆盖连续得分档位，不应判断为两极分化"
  );
  assert.match(message, /Q4[\s\S]{0,300}(连续|梯度|分散)/, "没有正确描述Q4的连续分布");
  assert.match(message, /来源|来源文件/, "没有给出原题来源");
  assert.match(message, /原题号|题号|第\s*\d+\s*题/, "没有给出原题号");
  assert.match(
    message,
    /Q2[^。\n]{0,100}(?:等于|恰好)[^。\n]{0,20}60(?:\.0+)?\s*%[^。\n]{0,40}不列入/i,
    "没有明确说明第2题恰好60%且不列入"
  );
  const belowThresholdList = /得分率低于\s*60\s*%的题目[：:]([^。\n]+)/.exec(message)?.[1];
  assert.ok(belowThresholdList, "没有给出低于60%的明确题目清单");
  assert.doesNotMatch(belowThresholdList, /Q2|第\s*2\s*题/i, "第2题恰好60%，不应列入低于60%的题目");
  return [
    "正确识别Q3=50%",
    "正确识别Q4=58%",
    "未把Q2=60%误判为低于60%",
    "逐题统计由脚本计算而非手工完成",
    "没有把Q4连续梯度误判为两极分化",
    "区分数据事实、教学解释和待确认内容",
    "原题候选包含来源与题号"
  ];
}

async function replayReport(reportFile) {
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const assertions = evaluateTeacherExamBusinessResult(report.message);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", mode: "replay", reportFile, assertions }, null, 2)}\n`
  );
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const reportFile = path.resolve(
    process.argv[2] ||
      path.join(path.dirname(currentFile), "..", ".magi-reports", "teacher-live-exam-eval.json")
  );
  replayReport(reportFile).catch((error) => {
    process.stderr.write(
      `[考试分析离线复核] 失败：${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
