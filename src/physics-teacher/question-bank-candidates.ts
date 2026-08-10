import { TeachingResource } from "./types.js";

export type PhysicsQuestionType = "choice" | "fill" | "comprehensive";

export interface PhysicsQuestionCandidate {
  topic: string;
  questionType: PhysicsQuestionType;
  questionNumber: string;
  sourceId: string;
  sourceTitle: string;
  importPath?: string;
  answerEvidence: boolean;
  excerpt: string;
}

interface TopicDefinition {
  label: string;
  trigger: RegExp;
  terms: string[];
}

const TOPICS: TopicDefinition[] = [
  {
    label: "摩擦力",
    trigger: /摩擦|粗糙|接触面/,
    terms: ["滑动摩擦力", "摩擦力", "增大摩擦", "减小摩擦", "接触面粗糙"]
  },
  {
    label: "浮力",
    trigger: /浮力|阿基米德|排开液体|漂浮|悬浮|沉浮/,
    terms: ["浮力", "阿基米德", "排开液体", "排开水", "漂浮", "悬浮"]
  },
  {
    label: "压强",
    trigger: /压强|压力|液体压强|大气压/,
    terms: ["压强", "压力", "液体压强", "大气压"]
  },
  { label: "杠杆", trigger: /杠杆|力臂|支点/, terms: ["杠杆", "力臂", "支点"] },
  {
    label: "功与机械能",
    trigger: /功率|机械能|动能|势能|做功/,
    terms: ["功率", "机械能", "动能", "势能", "做功"]
  },
  {
    label: "电路与欧姆定律",
    trigger: /电路|欧姆定律|电阻|电流|电压/,
    terms: ["欧姆定律", "电路", "电阻", "电流", "电压"]
  },
  { label: "电功率", trigger: /电功率|电功|用电器|焦耳热/, terms: ["电功率", "电功", "焦耳热"] },
  {
    label: "电与磁",
    trigger: /电与磁|磁场|电磁铁|电动机|发电机/,
    terms: ["磁场", "电磁铁", "电动机", "发电机"]
  },
  {
    label: "声现象",
    trigger: /声现象|声音|音调|响度|音色/,
    terms: ["声音", "音调", "响度", "音色"]
  },
  {
    label: "光学",
    trigger: /光学|光的反射|平面镜|凸透镜|折射/,
    terms: ["光的反射", "平面镜", "凸透镜", "折射"]
  },
  {
    label: "热学",
    trigger: /物态变化|内能|比热容|热量/,
    terms: ["物态变化", "内能", "比热容", "热量"]
  }
];

const QUESTION_START = /(?:^|\n)[ \t　]*(\d{1,2})[．.、][ \t　]*/g;
const IMAGE_DEPENDENCY =
  /如图|见图|图\s*\d|题\s*\d+\s*图|图[甲乙丙丁一二三四]|下图|图中|图示|图像|示意图|装置图|电路图|利用图|下表|表中|表格|数据表|(?:^|\s)[ABCD][．.、]\s*[甲乙丙丁][：:]|(?:MN|NM|OP|OQ)段/m;
const ANALYSIS_SOURCE = /年报|质量分析|分析报告|试题分析|教学建议/;
const ANSWER_SOURCE = /答案|评分标准/;
const COMPLETE_ANSWER_SOURCE = /含答案|解析版|试题及答案|试卷.{0,8}答案/;

export function buildPhysicsQuestionCandidatePack(input: {
  resources: TeachingResource[];
  query: string;
  limit?: number;
}): PhysicsQuestionCandidate[] {
  const topics = topicsForQuery(input.query);
  if (topics.length === 0) return [];
  const requestedCounts = requestedQuestionCounts(input.query);
  const candidates = input.resources.flatMap((resource) =>
    extractResourceCandidates(resource, topics)
  );
  const selected: PhysicsQuestionCandidate[] = [];
  const seen = new Set<string>();
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 60);
  const bucketLimits: Record<PhysicsQuestionType, number> = {
    choice: candidateBucketLimit(requestedCounts.choice),
    fill: candidateBucketLimit(requestedCounts.fill),
    comprehensive: candidateBucketLimit(requestedCounts.comprehensive)
  };
  const targetLimit = Math.min(
    limit,
    bucketLimits.choice + bucketLimits.fill + bucketLimits.comprehensive
  );

  for (const questionType of ["choice", "fill", "comprehensive"] as const) {
    const bucket = candidates
      .filter((candidate) => candidate.questionType === questionType)
      .sort(compareCandidates);
    selectRoundRobinByTopic(bucket, topics, bucketLimits[questionType], selected, seen);
  }
  if (selected.length < targetLimit) {
    for (const candidate of candidates.sort(compareCandidates)) {
      addCandidate(candidate, selected, seen);
      if (selected.length >= targetLimit) break;
    }
  }
  return selected.slice(0, targetLimit);
}

export function renderPhysicsQuestionCandidatePack(
  candidates: PhysicsQuestionCandidate[]
): string[] {
  if (candidates.length === 0) {
    return ["- 当前资料没有提取到匹配的完整题目候选，需要向教师说明题库缺口。"];
  }
  return candidates.flatMap((candidate, index) =>
    [
      `### 候选 ${index + 1}｜${candidate.topic}｜${questionTypeLabel(candidate.questionType)}｜原题号 ${candidate.questionNumber}`,
      `- 来源文件：${candidate.sourceTitle}`,
      `- 资料 ID：${candidate.sourceId}`,
      candidate.importPath ? `- 导入位置：${candidate.importPath}` : undefined,
      `- 答案证据：${candidate.answerEvidence ? "当前片段或来源标题含答案/解析线索" : "当前片段未附答案；题干条件完整且独立作答可得唯一答案时仍可作为原题，来源表标注“答案独立复核”"}`,
      "- 图片依赖：未检测到“如图/见图”等标记；交付前仍需核对原文件",
      "- 题目片段：",
      candidate.excerpt,
      ""
    ].filter((line): line is string => line !== undefined)
  );
}

function extractResourceCandidates(
  resource: TeachingResource,
  topics: TopicDefinition[]
): PhysicsQuestionCandidate[] {
  const text = resource.excerpt?.replace(/\r\n?/g, "\n");
  if (!text) return [];
  if (ANALYSIS_SOURCE.test(resource.title)) return [];
  if (ANSWER_SOURCE.test(resource.title) && !COMPLETE_ANSWER_SOURCE.test(resource.title)) return [];
  const starts = [...text.matchAll(QUESTION_START)];
  const candidates: PhysicsQuestionCandidate[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index ?? 0;
    const nextStart = starts[index + 1]?.index ?? text.length;
    const block = text.slice(start, Math.min(nextStart, start + 3_200)).trim();
    if (block.length < 20 || IMAGE_DEPENDENCY.test(block)) continue;
    const questionType = classifyQuestionType(block);
    if (!questionType || !looksLikeCompleteQuestion(block, questionType)) continue;
    for (const topic of topics) {
      if (!matchesTopic(block, topic)) continue;
      candidates.push({
        topic: topic.label,
        questionType,
        questionNumber: starts[index][1],
        sourceId: resource.id,
        sourceTitle: resource.title,
        importPath:
          typeof resource.metadata.importPath === "string"
            ? resource.metadata.importPath
            : undefined,
        answerEvidence:
          (/(?:解析版|答案|含答案|答案解析)/.test(resource.title) &&
            !/原卷版/.test(resource.title)) ||
          /【答案】|答案[：:]|故选|故填|答[：:]/.test(block),
        excerpt: block.slice(0, 2_400)
      });
    }
  }
  return candidates;
}

function classifyQuestionType(block: string): PhysicsQuestionType | undefined {
  const hasChoiceA = /(?:^|\s)A[．.、]/m.test(block);
  const hasChoiceD = /(?:^|\s)D[．.、]/m.test(block);
  if (hasChoiceA && hasChoiceD) {
    return hasCompleteChoiceOptions(block) ? "choice" : undefined;
  }
  const subpartCount = [...block.matchAll(/(?:\(\d+\)|（\d+）)/g)].length;
  const hasBlank = /[_＿﹏…·]{2,}|选填|填入|填“|填\"/.test(block.slice(0, 1_200));
  if (hasBlank && subpartCount < 2) return "fill";
  if (subpartCount >= 2 && hasQuestionInstruction(block.slice(0, 1_400))) {
    return "comprehensive";
  }
  return undefined;
}

function looksLikeCompleteQuestion(block: string, questionType: PhysicsQuestionType): boolean {
  const body = block.replace(/^\s*\d{1,2}[．.、]\s*/, "").trim();
  if (/^(?:【?(?:答案|分析|解析|详解)】?|解[：:]|[A-D](?:\b|[．.、]))/.test(body)) {
    return false;
  }
  if (questionType === "choice") {
    const optionStart = /(?:^|\s)A[．.、]/m.exec(body)?.index ?? -1;
    if (optionStart < 0) return false;
    const stem = body.slice(0, optionStart).replace(/[\s（）()　]/g, "");
    if (stem.length < 10) return false;
    return /下列|正确|错误|不正确|符合|不符合|则|那么|为|是|可知|可能/.test(stem);
  }
  if (questionType === "fill") {
    return /[_＿﹏…·]{2,}|选填|填入|填“|填\"/.test(body.slice(0, 1_200));
  }
  const withoutScore = body.replace(/^\s*[（(][^）)]{0,24}分[^）)]*[）)]\s*/, "");
  const firstSubpart = withoutScore.search(/(?:\(1\)|（1）)/);
  if (firstSubpart < 0) return false;
  const preamble = withoutScore.slice(0, firstSubpart).replace(/[\s（）()　]/g, "");
  if (preamble.length < 8) return false;
  return hasQuestionInstruction(withoutScore.slice(0, 1_400));
}

function hasCompleteChoiceOptions(block: string): boolean {
  for (const [label, next] of [
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
    ["D", undefined]
  ] as const) {
    const end = next ? `(?=(?:^|\\s)${next}[．.、])` : "$";
    const match = new RegExp(`(?:^|\\s)${label}[．.、]([\\s\\S]*?)${end}`, "m").exec(block);
    if (!match || match[1].replace(/[\s（）()]/g, "").length < 2) return false;
  }
  return true;
}

function hasQuestionInstruction(block: string): boolean {
  return /求|计算|比较|判断|说明|写出|画出|探究|测量|设计|估算|分析|为什么|如何|是否|请/.test(
    block
  );
}

function matchesTopic(block: string, topic: TopicDefinition): boolean {
  if (topic.label === "摩擦力") {
    if (
      /摩擦起电|带电|电荷|电子/.test(block) &&
      !/滑动摩擦力|摩擦力|增大摩擦|减小摩擦/.test(block)
    ) {
      return false;
    }
  }
  return topic.terms.some((term) => block.includes(term));
}

function topicsForQuery(query: string): TopicDefinition[] {
  return TOPICS.filter((topic) => topic.trigger.test(query));
}

function requestedQuestionCounts(query: string): Record<PhysicsQuestionType, number> {
  return {
    choice: requestedCount(query, "选择"),
    fill: requestedCount(query, "填空"),
    comprehensive: requestedCount(query, "(?:综合|计算|解答)")
  };
}

function requestedCount(query: string, labelPattern: string): number {
  const match = new RegExp(`(\\d{1,2})\\s*道?${labelPattern}`).exec(query);
  return match ? Number(match[1]) : 0;
}

function candidateBucketLimit(requested: number): number {
  return requested ? Math.max(requested * 2, requested + 2) : 6;
}

function compareCandidates(
  left: PhysicsQuestionCandidate,
  right: PhysicsQuestionCandidate
): number {
  const answerDifference = Number(right.answerEvidence) - Number(left.answerEvidence);
  if (answerDifference !== 0) return answerDifference;
  const preferredSourceDifference =
    Number(/中考|一模|二模|期末/.test(right.sourceTitle)) -
    Number(/中考|一模|二模|期末/.test(left.sourceTitle));
  if (preferredSourceDifference !== 0) return preferredSourceDifference;
  return left.excerpt.length - right.excerpt.length;
}

function selectRoundRobinByTopic(
  candidates: PhysicsQuestionCandidate[],
  topics: TopicDefinition[],
  limit: number,
  selected: PhysicsQuestionCandidate[],
  seen: Set<string>
): void {
  let added = 0;
  let cursor = 0;
  while (added < limit) {
    let progressed = false;
    for (const topic of topics) {
      const candidate = candidates.filter((item) => item.topic === topic.label)[cursor];
      if (!candidate) continue;
      progressed = true;
      if (addCandidate(candidate, selected, seen)) added += 1;
      if (added >= limit) return;
    }
    if (!progressed) return;
    cursor += 1;
  }
}

function addCandidate(
  candidate: PhysicsQuestionCandidate,
  selected: PhysicsQuestionCandidate[],
  seen: Set<string>
): boolean {
  const keys = [
    `${candidate.sourceId}:${candidate.questionNumber}:${candidate.questionType}`,
    questionFingerprint(candidate)
  ];
  if (keys.some((key) => seen.has(key))) return false;
  for (const key of keys) seen.add(key);
  selected.push(candidate);
  return true;
}

function questionFingerprint(candidate: PhysicsQuestionCandidate): string {
  let content =
    candidate.questionType === "choice"
      ? candidate.excerpt.slice(Math.max(candidate.excerpt.search(/(?:^|\s)A[．.、]/m), 0))
      : candidate.excerpt;
  if (candidate.questionType === "choice") {
    content = content.split(/【(?:答案|解析|详解)】|判断依据|答案[：:]|解析[：:]/)[0];
  }
  const normalized = content
    .replace(/【(?:答案|解析|详解)】[\s\S]*$/, "")
    .replace(/[\s，。；：、,.．!?！？（）()“”‘’\-—_＿]/g, "")
    .replace(/的/g, "")
    .toLowerCase();
  return `${candidate.questionType}:${normalized.slice(0, 700)}`;
}

function questionTypeLabel(value: PhysicsQuestionType): string {
  if (value === "choice") return "选择题";
  if (value === "fill") return "填空题";
  return "综合题";
}
