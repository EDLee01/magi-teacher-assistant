import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

把项目题库当作命题依据，不把旧题简单换数字。先确定范围和蓝图，再出题、作答、校验。

## 读取资料

1. 先读 \`workspace/wiki/INDEX.md\`，用 Grep 在分类页中找最近、最相关的真题和年报，再读少量来源页；不要遍历目录，不调用 Bash 或不存在的目录工具。
2. 读取 Wiki 文件时，FileRead 不要主动设置过小的 \`max_bytes\`。已经由资料检索上下文提供的内容不要重复读取。
3. 至少核对两份相关来源。当前题库存在时，按 2025、2024、2023 的顺序优先读取本地真题、官方年报和当前教材；更早资料只作补充。只写确实核对过的来源文件名或资料 ID，不虚构“仿某年第某题”。

## 命题步骤

1. 严格执行教师给定的题量、题型、年级和范围；没有指定范围时，以当前项目年级为边界，不擅自扩大到其他年级。
2. 先做内部命题蓝图：考点、能力要求、情境、难度、题型和分值。小卷也要有基础、理解应用、综合探究的层次，避免连续多道纯概念回忆题。
3. 每道题必须脱离原图也能独立作答。需要图表时，用完整的文字、数据表或在试卷中实际给出图，不能引用不存在的“如图”。交付前搜索“如图、下图、见图”，逐处确认图确实存在，否则改写。
4. 单项选择题只能有一个最佳答案。三个干扰项要来自常见错误、单位换算、条件遗漏或错误模型，数值和表述都要有迷惑性，避免用 16m 身高、10m/s 步行速度这类一眼排除的荒谬量级凑选项。
5. 填空题不拆成过多零碎记忆空；优先考信息读取、物理判断、数据处理和理由表达。
6. 大题采用递进设问，至少覆盖计算、实验探究、证据解释中的两类。给出的数据必须够用且符合真实量级。

## 交付前质量检查

逐题独立作答后，再以挑错者身份检查：范围是否越界、条件是否充分、选择题是否唯一、单位和有效数字是否一致、数值是否可算、答案与解析是否一致、是否与来源题过度重复。不能只凭质量大小推断物体振动频率、音调等还受材料和结构影响的量；凡是结论需要额外条件，就必须在题干中给出。

实验结论必须与证据强度匹配：两组数据通常只能说明在给定条件下的变化关系，不能直接写“成正比”等更强结论。不能从单次实验或有限样本推出普遍规律。

把完整试卷、答案和解析写入 \`artifacts/\`，优先生成便于继续编辑的 Markdown；教师指定 Word、PDF 或 HTML 时按要求生成。聊天中只给简短质量说明和清晰文件名，不重复粘贴整份试卷。桌面端会把交付文件显示为可预览、可打开的文件卡片。

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
      skipped.push(skill.name);
      continue;
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(file, skill.body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    installed.push(skill.name);
  }
  return { installed, skipped };
}
