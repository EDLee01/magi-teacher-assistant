import assert from "node:assert/strict";

import { evaluateTeacherExamBusinessResult } from "./teacher-exam-business-rubric.mjs";

const passingMessage = `
已使用 Python 脚本计算，非心算，并完成字段与人数核对。

逐题结果：Q1 为 90.0%；Q2 为 60.0%，恰好等于 60.0%，不列入；Q3 为 50.0%；Q4 为 58.0%；Q5 为 70.0%。
得分率低于60%的题目：Q3、Q4。

数据事实：Q3 对应滑动摩擦力及受力分析，0 分 5 人、4 分 5 人。Q4 对应浮力和阿基米德原理，得分呈连续梯度，1 分 3 人、2 分 1 人、3 分 2 人、4 分 2 人、5 分 2 人。
教学解释：Q3 可能卡在摩擦力方向判断，Q4 可能没有正确识别排开液体体积变化。这些只是可能原因，不能替代学生答卷证据。
尚待教师确认：需要核实班级人数、缺考情况和学生的具体作答步骤。

原题候选：
1. 来源文件：2024年广州市中考物理试题解析.pdf；地区/年份：广州/2024；原题号：第4题；知识点：滑动摩擦力；题干完整，答案为B。
2. 来源文件：2023年荔湾区中考一模物理试题.pdf；地区/年份：广州荔湾/2023；原题号：第17题；知识点：浮力；题干完整，答案可由来源文件核对。

说明：候选题均来自项目题库，保留了来源文件、地区、年份和原题号。缺图、缺选项或答案无法核对的片段没有列入，不会把新编题冒充原题。为了让业务评分器覆盖足够完整的分析结构，这里补充说明：正式报告还应保留计算脚本路径、数据异常检查结果、原题适用范围以及需要教师最终确认的教学判断。
`.trim();
const frictionSourceId = "11111111-1111-4111-8111-111111111111";
const buoyancySourceId = "22222222-2222-4222-8222-222222222222";
const traceableMessage = `${passingMessage}

| 知识点 | 来源文件 | 资料ID | 原题号 |
| --- | --- | --- | --- |
| 摩擦力 | 2024年广州市中考物理试题解析.pdf | ${frictionSourceId} | 第4题 |
| 浮力 | 2023年荔湾区中考一模物理试题.pdf | ${buoyancySourceId} | 第17题 |`;
const allowedOriginalCandidates = [
  { sourceId: frictionSourceId, questionNumber: "4" },
  { sourceId: buoyancySourceId, questionNumber: "17" }
];
const headingListMessage = passingMessage.replace(
  "得分率低于60%的题目：Q3、Q4。",
  "## 严格低于 60% 的题目\n\n- **Q3（50.0%）**\n- **Q4（58.0%）**\n\nQ2 恰好等于 60%，不列入。"
);

assert.equal(evaluateTeacherExamBusinessResult(passingMessage).length, 7);
assert.equal(evaluateTeacherExamBusinessResult(headingListMessage).length, 7);
assert.equal(
  evaluateTeacherExamBusinessResult(traceableMessage, { allowedOriginalCandidates }).length,
  8
);
assert.equal(
  evaluateTeacherExamBusinessResult(traceableMessage, {
    allowedOriginalCandidates,
    scriptExecutionEvidence: true
  }).length,
  8
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(traceableMessage, {
      allowedOriginalCandidates,
      scriptExecutionEvidence: false
    }),
  /Session 中没有统计脚本成功执行/
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(
      passingMessage.replace("Python 脚本计算，非心算", "Python 脚本计算，之后手工复核")
    ),
  /不应依赖手工计算/
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(
      passingMessage.replace(
        "已使用 Python 脚本计算，非心算",
        "Bash/Python 执行被环境拒绝，因此逐题手工求和"
      )
    ),
  /统计脚本没有成功执行/
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(
      passingMessage.replace(
        "Q4 对应浮力和阿基米德原理，得分呈连续梯度",
        "Q4 对应浮力和阿基米德原理，呈两极分化"
      )
    ),
  /不应判断为两极分化/
);
assert.equal(
  evaluateTeacherExamBusinessResult(
    passingMessage.replace(
      "Q4 对应浮力和阿基米德原理，得分呈连续梯度",
      "Q4 对应浮力和阿基米德原理，得分呈连续梯度，不是两极分化"
    )
  ).length,
  7
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(
      passingMessage.replace("得分率低于60%的题目：Q3、Q4", "得分率低于60%的题目：Q2、Q3、Q4")
    ),
  /第2题恰好60%/
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(
      passingMessage.replace(
        "题干完整，答案为B。",
        "题干出现‘如图’，但图片仅为情境示意，判断依据全部在文字中。"
      )
    ),
  /不能把含图片引用的题目解释为图片不重要/
);
assert.throws(
  () =>
    evaluateTeacherExamBusinessResult(traceableMessage.replace("第17题 |", "第18题 |"), {
      allowedOriginalCandidates
    }),
  /不在后端完整题候选包/
);

process.stdout.write("Teacher exam business rubric smoke passed.\n");
