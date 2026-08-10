import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateTeacherExamBusinessResult(message, options = {}) {
  assert.equal(typeof message, "string");
  assert.ok(message.length > 500, "业务分析内容过短");
  assert.match(message, /(第\s*3\s*题|Q3)/i, "没有识别第3题");
  assert.match(message, /50(?:\.0+)?\s*%/, "第3题得分率应为50%");
  assert.match(message, /(第\s*4\s*题|Q4)/i, "没有识别第4题");
  assert.match(message, /58(?:\.0+)?\s*%/, "第4题得分率应为58%");
  assert.match(message, /滑动摩擦力|摩擦力/, "没有对应第3题知识点");
  assert.match(message, /浮力|阿基米德/, "没有对应第4题知识点");
  assert.doesNotMatch(
    message,
    /(?:Bash|Python|统计脚本)[^。\n]{0,80}(?:拒绝|不可用|无法使用|没有权限)|(?:无法|未能|没有)[^。\n]{0,40}(?:运行|执行)[^。\n]{0,40}(?:Python|统计脚本|计算脚本)/,
    "统计脚本没有成功执行，不能改用手工求和替代"
  );
  if (options.scriptExecutionEvidence !== undefined) {
    assert.equal(options.scriptExecutionEvidence, true, "Session 中没有统计脚本成功执行的工具记录");
  } else {
    assert.match(
      message,
      /(?:已|使用|通过|由)[^。\n]{0,80}(?:Python|计算脚本|统计脚本)[^。\n]{0,80}(?:计算|运行|执行|输出)|(?:Python|计算脚本|统计脚本)[^。\n]{0,80}(?:已运行|已执行|计算结果|工具输出)|逐题得分率[^\n]{0,30}Python\s*计算/,
      "逐题统计没有留下成功运行脚本的证据"
    );
  }
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
  const distributionDescription = message.replace(
    /(?:不是|并非|不属于|非)(?:典型的?)?两极(?:形态|分布|分化)/g,
    ""
  );
  assert.doesNotMatch(
    distributionDescription,
    /Q4[\s\S]{0,300}(两极形态|两极分化)/,
    "Q4覆盖连续得分档位，不应判断为两极分化"
  );
  assert.match(message, /Q4[\s\S]{0,300}(连续|梯度|分散)/, "没有正确描述Q4的连续分布");
  assert.match(message, /来源|来源文件/, "没有给出原题来源");
  assert.match(message, /原题号|题号|第\s*\d+\s*题/, "没有给出原题号");
  assert.doesNotMatch(
    message,
    /(?:如图|见图|图示|图片)[^。\n|]{0,100}(?:仅为[^。\n|]{0,30}示意|不影响解题|非解题必需|无需[^。\n|]{0,20}图|判断依据[^。\n|]{0,30}文字)/,
    "不能把含图片引用的题目解释为图片不重要后继续列为原题"
  );
  if (options.allowedOriginalCandidates) {
    assertOriginalCandidateRows(message, options.allowedOriginalCandidates);
  }
  assert.match(
    message,
    /Q2[^。\n]{0,100}(?:等于|恰好)[^。\n]{0,20}60(?:\.0+)?\s*%[^。\n]{0,40}不列入/i,
    "没有明确说明第2题恰好60%且不列入"
  );
  const belowThresholdList = extractBelowThresholdList(message);
  assert.ok(belowThresholdList, "没有给出低于60%的明确题目清单");
  assert.match(belowThresholdList, /Q3|第\s*3\s*题/i, "低于60%的清单没有列出第3题");
  assert.match(belowThresholdList, /Q4|第\s*4\s*题/i, "低于60%的清单没有列出第4题");
  assert.doesNotMatch(belowThresholdList, /Q2|第\s*2\s*题/i, "第2题恰好60%，不应列入低于60%的题目");
  return [
    "正确识别Q3=50%",
    "正确识别Q4=58%",
    "未把Q2=60%误判为低于60%",
    "逐题统计由脚本计算而非手工完成",
    "没有把Q4连续梯度误判为两极分化",
    "区分数据事实、教学解释和待确认内容",
    "原题候选包含来源与题号",
    ...(options.allowedOriginalCandidates
      ? ["原题来源和题号均属于后端完整题候选包"]
      : [])
  ];
}

function extractBelowThresholdList(message) {
  const inline = /(?:得分率)?(?:严格)?低于\s*60\s*%\s*的题目[：:]([^。\n]+)/.exec(message)?.[1];
  if (inline) return inline;
  const sectionStart =
    /(?:^|\n)#{1,6}\s*(?:[一二三四五六七八九十0-9]+[、.．]\s*)?(?:得分率)?(?:严格)?低于\s*60\s*%\s*的题目\s*\n/i.exec(
      message
    );
  if (!sectionStart || sectionStart.index === undefined) return undefined;
  const sectionBody = message.slice(sectionStart.index + sectionStart[0].length).split(/\n#{1,6}\s/)[0];
  const listLines = sectionBody
    .split(/\r?\n/)
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .join("\n");
  return listLines || undefined;
}

function assertOriginalCandidateRows(message, allowedOriginalCandidates) {
  const allowedPairs = new Set(
    allowedOriginalCandidates.map(
      (candidate) => `${candidate.sourceId}:${normalizeQuestionNumber(candidate.questionNumber)}`
    )
  );
  const candidateRows = message
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes("|") &&
        /[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(line) &&
        /第\s*\d{1,2}\s*题|原题号/i.test(line)
    );
  assert.ok(candidateRows.length >= 2, "原题候选表至少应有两行可核对的资料ID与原题号");
  for (const row of candidateRows) {
    const sourceId = row.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
    const questionNumber = row.match(/第\s*(\d{1,2})\s*题/i)?.[1];
    assert.ok(sourceId && questionNumber, `原题候选行无法核对资料ID与原题号：${row}`);
    assert.ok(
      allowedPairs.has(`${sourceId}:${normalizeQuestionNumber(questionNumber)}`),
      `原题候选不在后端完整题候选包中：${sourceId} 第${questionNumber}题`
    );
  }
}

function normalizeQuestionNumber(value) {
  return String(Number.parseInt(String(value), 10));
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
