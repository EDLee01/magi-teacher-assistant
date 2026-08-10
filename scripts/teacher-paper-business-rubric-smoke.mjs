import assert from "node:assert/strict";

import { app } from "electron";

process.env.MAGI_TEACHER_PAPER_ASSERTIONS_ONLY = "1";
const { evaluatePaperResult } = await import("./teacher-live-followup-paper-eval.mjs");

const artifactStem = "匿名原题组卷评分器测试";
const candidateNumbers = [3, 8, 10, 16, 24];
const originalPaperNumbers = new Set([1, 5, 7, 9, 10]);
const candidates = candidateNumbers.map((questionNumber, index) => ({
  sourceId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
  questionNumber: String(questionNumber)
}));
const message = [
  "已完成10题专项训练：选择题5道、填空题2道、综合题3道。",
  "原题占比50%（5/10），其余5题均标为题库缺口补充题。",
  `交付文件：artifacts/${artifactStem}.docx、artifacts/${artifactStem}.pdf。`
].join("\n");
const docxText = buildDocument();

assert.equal(
  evaluatePaperResult({
    message,
    docxText,
    docxContainsMedia: false,
    allowedOriginalCandidates: candidates,
    artifactStem
  }).length,
  12
);
assert.throws(
  () => evaluate(docxText.replace("地区/2024    24    55555555", "地区/2024    25    55555555")),
  /候选包之外的原题/
);
assert.throws(() => evaluate(docxText.replace(/^10\s{2,}.*$/m, "")), /没有逐题覆盖10道题/);
assert.throws(
  () => evaluate(docxText.replace(/^10\s{2,}.*原题.*$/m, supplementRow(10))),
  /没有尽量使用候选包原题/
);
assert.throws(
  () => evaluate(docxText.replace("1. 摩擦力选择题", "1. 如图所示，摩擦力选择题")),
  /引用了图示/
);

process.stdout.write("Teacher paper business rubric smoke passed.\n");
app.exit(0);

function evaluate(value) {
  return evaluatePaperResult({
    message,
    docxText: value,
    docxContainsMedia: false,
    allowedOriginalCandidates: candidates,
    artifactStem
  });
}

function buildDocument() {
  const lines = [
    "摩擦力与浮力专项训练卷",
    "第一部分 学生卷",
    "一、选择题",
    ...range(1, 5).map((number) => `${number}. 摩擦力选择题 ${number}（　　） A.甲 B.乙 C.丙 D.丁`),
    "二、填空题",
    ...range(6, 7).map((number) => `${number}. 浮力填空题 ${number}______。`),
    "三、综合题",
    ...range(8, 10).map((number) => `${number}. 浮力综合题 ${number}，请计算并说明理由。`),
    "第二部分 答案与解析",
    ...range(1, 10).map((number) => `${number}. 答案与解析 ${number}`),
    "第三部分 选题来源表",
    "卷内题号    题型    知识点    属性    来源文件    地区/年份    原题号    资料ID    答案核对方式",
    ...range(1, 10).map(sourceRow)
  ];
  return lines.join("\n");
}

function sourceRow(number) {
  if (!originalPaperNumbers.has(number)) return supplementRow(number);
  const originalIndex = [...originalPaperNumbers].indexOf(number);
  const candidate = candidates[originalIndex];
  return `${number}    ${questionType(number)}    摩擦力或浮力    原题    匿名题库${originalIndex + 1}.docx    地区/2024    ${candidate.questionNumber}    ${candidate.sourceId}    同源答案`;
}

function supplementRow(number) {
  return `${number}    ${questionType(number)}    摩擦力或浮力    补充题    —（题库缺口）    —    —    —    独立复核`;
}

function questionType(number) {
  if (number <= 5) return "选择题";
  if (number <= 7) return "填空题";
  return "综合题";
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
