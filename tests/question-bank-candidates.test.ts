import { describe, expect, it } from "vitest";

import {
  buildPhysicsQuestionCandidatePack,
  renderPhysicsQuestionCandidatePack
} from "../src/physics-teacher/question-bank-candidates.js";
import { TeachingResource } from "../src/physics-teacher/types.js";

describe("physics question-bank candidate pack", () => {
  it("preselects balanced text-complete questions and excludes explicit image dependencies", () => {
    const resources = [
      resource(
        "friction-source",
        "2024广州一模物理试题解析.docx",
        [
          "1．下列关于滑动摩擦力的说法正确的是（　　）\nA．只与速度有关 B．只与面积有关 C．与压力和接触面有关 D．始终不变\n【答案】C",
          "2．一个木块受到的滑动摩擦力为3N，则摩擦力大小应填______N。",
          "3．如图所示，木块在水平面运动，求滑动摩擦力。\n（1）画受力图；（2）求大小。",
          "7．下列说法正确的是（　　）\nA．甲：增大摩擦 B．乙：减小摩擦 C．丙：没有摩擦 D．丁：摩擦不变"
        ].join("\n")
      ),
      resource(
        "buoyancy-source",
        "2023广州中考物理试题.docx",
        [
          "4．物体浸没在水中时受到浮力，下列说法正确的是（　　）\nA．与排开水有关 B．始终为零 C．只与质量有关 D．方向向下",
          "5．物体排开水的体积增大，受到的浮力将______（选填“增大”或“减小”）。",
          "6．密封塑料盒漂浮在水面。\n（1）写出浮力关系；（2）求排开水的体积；（3）判断装入物体后的状态。",
          "8．利用图示装置研究浮力。\n（1）求浮力；（2）判断物体状态。"
        ].join("\n")
      ),
      resource(
        "analysis-source",
        "2024年广州市中考物理科年报.pdf",
        "9．本题质量分析表明学生对滑动摩擦力理解不足，正确率为______。"
      ),
      resource(
        "answer-source",
        "2024花都一模答案.docx",
        "17．（1）解：由阿基米德原理可得浮力。\n（2）计算结果为2N。"
      )
    ];

    const candidates = buildPhysicsQuestionCandidatePack({
      resources,
      query: "摩擦力和浮力专项训练：5道选择题、2道填空题、3道综合题"
    });

    expect(candidates.map((candidate) => candidate.questionNumber)).toEqual(
      expect.arrayContaining(["1", "2", "4", "5", "6"])
    );
    expect(candidates.map((candidate) => candidate.questionNumber)).not.toContain("3");
    expect(candidates.map((candidate) => candidate.questionNumber)).not.toContain("7");
    expect(candidates.map((candidate) => candidate.questionNumber)).not.toContain("8");
    expect(candidates.map((candidate) => candidate.sourceId)).not.toContain("analysis-source");
    expect(candidates.map((candidate) => candidate.sourceId)).not.toContain("answer-source");
    expect(candidates.map((candidate) => candidate.topic)).toEqual(
      expect.arrayContaining(["摩擦力", "浮力"])
    );
    expect(renderPhysicsQuestionCandidatePack(candidates).join("\n")).toContain("候选 1");
  });
});

function resource(id: string, title: string, excerpt: string): TeachingResource {
  return {
    id,
    projectId: "project-1",
    sourceId: "upload-source",
    title,
    kind: "document",
    excerpt,
    metadata: { importPath: `题库/${title}` },
    createdAt: "2026-08-10T00:00:00.000Z"
  };
}
