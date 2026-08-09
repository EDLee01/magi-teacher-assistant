import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MagiPaths } from "../paths.js";

export interface PhysicsTeacherSkill {
  name: string;
  body: string;
}

export const PHYSICS_TEACHER_SKILL_NAMES = [
  "physics-exam-analysis",
  "physics-lesson-planning",
  "physics-question-design",
  "physics-homework-guidance",
  "physics-personalized-learning"
] as const;

const PHYSICS_TEACHER_SKILLS: PhysicsTeacherSkill[] = [
  {
    name: "physics-exam-analysis",
    body: `---
name: physics-exam-analysis
description: 当教师上传物理考试成绩、逐题得分、答题明细或试卷，并要求考试分析、学情诊断、错因判断、讲评课安排时使用。
---

# 物理考试分析

把一次考试的数据变成下一步教学安排。不要只给平均分和排名。

## 步骤

1. 先查看项目资料，确认至少有哪些文件、字段、班级范围和考试范围；缺少逐题数据时明确分析边界。
2. 对表格先做字段、空值、重复记录、满分和人数核对。涉及统计时用 Python 脚本计算，不靠心算。
3. 依次分析全卷概况、题目得分率/区分度、学生分组、典型作答和可能的错误观念。
4. 把“数据事实”“教学解释”“尚待核实”分开写。不能从低得分率直接断言学生形成了某种错误观念。
5. 给出下一节讲评课、后续作业和复测的具体安排，并让每一项建议能追溯到题号或数据。

## 输出

- 数据检查
- 三条最重要发现（带依据）
- 学生分组及需要
- 下一节课怎么讲
- 作业与复测怎么安排
- 仍需教师确认的问题

EXAM_ANALYSIS_BUSINESS_MARKER
`
  },
  {
    name: "physics-lesson-planning",
    body: `---
name: physics-lesson-planning
description: 当教师要根据课标、教材、现有学情或上次考试结果准备物理课、讲评课、实验课和复习课时使用。
---

# 物理教师备课

1. 明确课题、课时、教材版本、学生已有基础和可用资料。
2. 从已有证据中确定本节课真正要解决的一到两个学习困难。
3. 组织“情境或现象—学生预测—实验/推理—表达—练习—当堂检查”的课堂链路。
4. 对每个活动写清教师做什么、学生做什么、预计用时和用什么证据判断学会了。
5. 最后检查教学目标、课堂活动、例题、作业和评价是否一致。

输出一份教师可以直接修改的课时方案；资料不足时先列出需要补充的内容，不虚构教材页码或学生表现。
`
  },
  {
    name: "physics-question-design",
    body: `---
name: physics-question-design
description: 当教师要求出题、命题、组卷、生成模拟题、改编题、同构题、复测卷，或要求参考本地题库设计物理试题时使用。
---

# 物理命题与组卷

默认任务不是“让模型自己编题”，而是“从项目题库中选出最适合本次教学目标的原题并组成试卷”。只有题库确实没有合适原题时，才允许补充少量新题，而且必须明确标注。

## 原题优先原则

1. 先把教师要求拆成知识点、题型、题量、难度和年级范围，再逐个知识点检索题库。
2. 只要题库中存在范围合适、题干完整、答案可核对的原题，就直接选用原题，不改写题干、选项、数据和设问，不把原题“仿写”为一道 AI 题。
3. 目标是可用原题占 100%。不能为了凑年份、凑新情境或展示生成能力而主动降低原题比例。
4. 每道题都要保留来源：来源文件名、年份/地区、原题号和资料 ID。学生卷可以不显示来源，但必须另附“选题来源表”供教师核对。
5. 原题依赖图片、表格或装置图时，必须确认原图能够随题交付。提取不到原图就换一题，或明确请教师补图；不能删掉“如图”后凭空重画成另一道题。
6. 只有对应知识点检索不到合适原题时，才可补充新题。补充题必须在选题来源表中标为“题库缺口补充题”，并说明缺少的是哪个知识点、题型或难度。

## 题库检索

1. 先读 \`workspace/wiki/INDEX.md\`，重点查看“试卷与答案”“作业与练习”分类页，再用 Grep 以知识点及同义词检索来源页；不要只看文件标题，也不要只读检索摘要的开头。
2. 对每个知识点建立原题候选表，至少记录：来源、题号、题型、考点、难度、题干是否完整、答案是否可核对、是否依赖原图。
3. 至少核对两份相关来源。优先选择与当前年级、教学进度和地区风格一致的题目；年份只用于排序，不能因为题目较早就改写它。
4. 只写确实核对过的来源文件名、题号和资料 ID，不虚构“某年某区第几题”。找不到就明确写“题库未检索到”，不要用生成内容伪装成原题。

## 组卷步骤

1. 严格执行教师给定的题量、题型、年级和范围；没有指定范围时，以当前项目年级为边界，不擅自扩大到其他年级。
2. 先做组卷蓝图：考点、能力要求、难度、题型和分值，再从原题候选表中匹配，不先写题再找出处。
3. 避免同一情境或同一种解法重复堆叠；同等匹配时优先选择题干完整、答案明确、图片可交付的原题。
4. 保持原题本身不变，只允许统一题号、版式、字体和分值标注。若必须删减或改动，不能再标为“原题”，必须标为“改编题”并记录改动内容。

## 交付前质量检查

逐题对照原始资料，检查题干、选项、数据、图表、答案和题号是否一致；再独立作答，检查范围是否越界、条件是否充分、选择题是否唯一、单位是否一致、答案与解析是否匹配。不能因为排版方便而遗漏原图、表格或关键条件。

交付时同时给出：学生用试卷、答案与解析、选题来源表。来源表必须统计原题、改编题和题库缺口补充题的数量；有补充题时说明为什么没有选到原题。

把完整成果写入 \`artifacts/\`。默认优先交付可继续编辑的 DOCX，其次是 PDF；Markdown 只作为内部中间稿，不作为面向教师的默认交付格式。聊天中只给简短说明、原题占比和清晰文件名，不重复粘贴整份试卷。桌面端会把交付文件显示为可预览、可打开的文件卡片。

QUESTION_DESIGN_BUSINESS_MARKER
`
  },
  {
    name: "physics-homework-guidance",
    body: `---
name: physics-homework-guidance
description: 当教师要设计、调整或讲解物理作业，分析错题，给学生提示、分层练习、答案反馈和复测题时使用。
---

# 物理作业辅导与调整

1. 先确定作业对应的知识目标和已知学情，不按题型机械堆题。
2. 区分概念理解、物理过程建模、数学处理、图像表达和实验方法等错误来源。
3. 给学生辅导时先问关键判断或给一级提示，再逐级增加提示；不要一开始直接抄出完整答案。
4. 给教师设计作业时分为基础巩固、针对纠错和迁移挑战，并注明每组题解决什么问题。
5. 同时给出简明答案、常见错误反馈语和可用于复测的同构题。
`
  },
  {
    name: "physics-personalized-learning",
    body: `---
name: physics-personalized-learning
description: 当教师要依据物理学习数据为不同学生或学生小组制定个性化学习路径、补弱任务、阶段目标和学习陪伴计划时使用。
---

# 物理个性化学习

1. 只使用项目中已有且获准使用的学生数据，先说明证据覆盖到班级、小组还是个人。
2. 按“当前会什么—卡在哪里—下一小步—怎样证明学会”描述学生需要，避免贴固定能力标签。
3. 每名学生或每组最多安排一到两个近期目标，匹配讲解、练习、实验/图像活动和复测方式。
4. 计划中写清频率、完成标准和教师需要观察的信号，并保留根据新数据调整的入口。
5. 涉及长期学情结论时生成待教师确认的记忆草稿，不直接写入长期记忆。
`
  }
];

export function resolvePhysicsTeacherSkill(prompt: string): PhysicsTeacherSkill | undefined {
  const normalized = prompt.trim();
  if (!normalized) return undefined;
  if (
    /(出.{0,12}(题|试卷)|命题|组卷|模拟题|改编题|同构题|复测卷|生成.{0,8}(试题|题目|练习)|设计.{0,8}(试题|题目|练习))/.test(
      normalized
    )
  ) {
    return skillByName("physics-question-design");
  }
  if (/(逐题得分|答题明细|得分率|考试分析|学情诊断|错因判断|讲评课)/.test(normalized)) {
    return skillByName("physics-exam-analysis");
  }
  if (/(备课|教案|课时方案|实验课|复习课|课堂活动)/.test(normalized)) {
    return skillByName("physics-lesson-planning");
  }
  if (/(作业|错题|分层练习|作业辅导|答案反馈|逐级提示)/.test(normalized)) {
    return skillByName("physics-homework-guidance");
  }
  if (/(个性化|学习路径|补弱|阶段目标|学习陪伴|学生分组)/.test(normalized)) {
    return skillByName("physics-personalized-learning");
  }
  return undefined;
}

export function physicsTeacherSkillInstructions(skill: PhysicsTeacherSkill): string {
  return skill.body.replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
}

function skillByName(name: (typeof PHYSICS_TEACHER_SKILL_NAMES)[number]): PhysicsTeacherSkill {
  return PHYSICS_TEACHER_SKILLS.find((skill) => skill.name === name)!;
}

export function installPhysicsTeacherSkills(paths: MagiPaths): {
  installed: string[];
  skipped: string[];
} {
  const installed: string[] = [];
  const skipped: string[] = [];
  mkdirSync(paths.skillsRoot, { recursive: true, mode: 0o700 });
  for (const skill of PHYSICS_TEACHER_SKILLS) {
    const directory = path.join(paths.skillsRoot, skill.name);
    const file = path.join(directory, "SKILL.md");
    if (existsSync(file)) {
      const current = readFileSync(file, "utf8");
      if (current === skill.body) {
        skipped.push(skill.name);
        continue;
      }
      if (!isManagedPhysicsTeacherSkill(current, skill.name)) {
        skipped.push(skill.name);
        continue;
      }
      writeFileSync(file, skill.body, { encoding: "utf8", mode: 0o600 });
      installed.push(skill.name);
      continue;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, skill.body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    installed.push(skill.name);
  }
  return { installed, skipped };
}

function isManagedPhysicsTeacherSkill(content: string, name: string): boolean {
  if (!content.includes(`name: ${name}`)) return false;
  if (name === "physics-question-design") {
    return content.includes("QUESTION_DESIGN_BUSINESS_MARKER");
  }
  if (name === "physics-exam-analysis") {
    return content.includes("EXAM_ANALYSIS_BUSINESS_MARKER");
  }
  return false;
}
