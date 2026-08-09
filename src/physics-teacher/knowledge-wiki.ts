import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PhysicsTeacherProjectPaths } from "./paths.js";
import { TeachingResource } from "./types.js";

export interface PhysicsTeacherWikiCategorySummary {
  id: string;
  label: string;
  count: number;
}

export interface PhysicsTeacherKnowledgeWikiSummary {
  resourceCount: number;
  generatedAt: string;
  indexPath: string;
  categories: PhysicsTeacherWikiCategorySummary[];
}

interface WikiCategoryDefinition {
  id: string;
  label: string;
  description: string;
}

const CATEGORIES: WikiCategoryDefinition[] = [
  { id: "curriculum-textbooks", label: "课标与教材", description: "课程标准、教材和章节资料" },
  { id: "exams-answers", label: "试卷与答案", description: "考试、试卷、答案和题目解析" },
  { id: "student-learning", label: "成绩与学情", description: "成绩、答题明细、错题和复测数据" },
  { id: "lesson-plans", label: "教案与课件", description: "教案、教学设计、备课和课堂课件" },
  { id: "exercises", label: "作业与练习", description: "作业、练习、习题和导学材料" },
  { id: "other", label: "其他资料", description: "暂未归入以上类别的项目资料" }
];

export function rebuildPhysicsTeacherKnowledgeWiki(input: {
  projectPaths: PhysicsTeacherProjectPaths;
  resources: TeachingResource[];
}): PhysicsTeacherKnowledgeWikiSummary {
  const generatedAt = new Date().toISOString();
  const grouped = new Map(CATEGORIES.map((category) => [category.id, [] as TeachingResource[]]));
  for (const resource of input.resources) grouped.get(categoryFor(resource).id)!.push(resource);

  const wikiRoot = input.projectPaths.wiki;
  const sourcesRoot = path.join(wikiRoot, "sources");
  rmSync(wikiRoot, { recursive: true, force: true });
  mkdirPrivate(sourcesRoot);

  for (const resource of input.resources) {
    const category = categoryFor(resource);
    writePrivate(
      path.join(sourcesRoot, `${resource.id}.md`),
      renderResourcePage(resource, category, input.projectPaths)
    );
  }

  for (const category of CATEGORIES) {
    writePrivate(
      path.join(wikiRoot, `${category.id}.md`),
      renderCategoryPage(category, grouped.get(category.id) ?? [])
    );
  }

  const categories = CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    count: grouped.get(category.id)?.length ?? 0
  }));
  writePrivate(
    path.join(wikiRoot, "INDEX.md"),
    renderIndex(input.resources.length, generatedAt, categories)
  );
  return {
    resourceCount: input.resources.length,
    generatedAt,
    indexPath: "workspace/wiki/INDEX.md",
    categories
  };
}

function renderIndex(
  resourceCount: number,
  generatedAt: string,
  categories: PhysicsTeacherWikiCategorySummary[]
): string {
  return [
    "# 项目教学知识库",
    "",
    "> 由 Magi 根据项目基础资料自动整理。回答教学问题时先查看对应分类页，再回到来源页和原文件核对。",
    "",
    `- 资料总数：${resourceCount}`,
    `- 更新时间：${generatedAt}`,
    "- 引用要求：保留文件名和资料 ID；知识库没有的结论不要补写。",
    "",
    "## 分类目录",
    "",
    ...categories.map(
      (category) => `- [${category.label}](./${category.id}.md)（${category.count}）`
    ),
    ""
  ].join("\n");
}

function renderCategoryPage(
  category: WikiCategoryDefinition,
  resources: TeachingResource[]
): string {
  return [
    `# ${category.label}`,
    "",
    category.description,
    "",
    resources.length ? "## 资料" : "当前还没有这一类资料。",
    "",
    ...resources.flatMap((resource) => [
      `### [${resource.title}](./sources/${resource.id}.md)`,
      "",
      `- 资料 ID：${resource.id}`,
      resource.metadata.importPath
        ? `- 原目录：${String(resource.metadata.importPath)}`
        : undefined,
      resource.excerpt ? `- 内容线索：${singleLine(resource.excerpt).slice(0, 280)}` : undefined,
      ""
    ]),
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderResourcePage(
  resource: TeachingResource,
  category: WikiCategoryDefinition,
  projectPaths: PhysicsTeacherProjectPaths
): string {
  const sourcePath = resource.storagePath
    ? path.relative(projectPaths.root, resource.storagePath).replaceAll(path.sep, "/")
    : undefined;
  return [
    `# ${resource.title}`,
    "",
    `- 资料 ID：${resource.id}`,
    `- 分类：${category.label}`,
    resource.mimeType ? `- 格式：${resource.mimeType}` : undefined,
    resource.sizeBytes ? `- 大小：${resource.sizeBytes} bytes` : undefined,
    resource.metadata.importPath
      ? `- 导入位置：${String(resource.metadata.importPath)}`
      : undefined,
    sourcePath ? `- 原文件：\`${sourcePath}\`` : undefined,
    `- 知识化状态：${resource.excerpt ? "已抽取正文" : "仅登记来源，需用工具读取原文件"}`,
    `- 导入时间：${resource.createdAt}`,
    "",
    "## 可检索内容",
    "",
    resource.excerpt?.trim() ||
      "当前文件格式没有生成文本预览。需要内容时，请使用上面的原文件路径读取或运行分析工具。",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function categoryFor(resource: TeachingResource): WikiCategoryDefinition {
  const value = `${resource.title} ${resource.kind} ${String(resource.metadata.importPath ?? "")}`;
  if (/(成绩|得分|学生|答题明细|错题|学情|复测|correct.?rate|score)/i.test(value)) {
    return category("student-learning");
  }
  if (/(课标|课程标准|教材|教科书|必修|选修|textbook|curriculum)/i.test(value)) {
    return category("curriculum-textbooks");
  }
  if (/(教案|教学设计|备课|课件|课堂|lesson|slides?)/i.test(value)) {
    return category("lesson-plans");
  }
  if (/(作业|练习|习题|导学案|homework|exercise|practice)/i.test(value)) {
    return category("exercises");
  }
  if (/(试卷|考试|期中|期末|月考|模拟|答案|解析|题目|exam|answer)/i.test(value)) {
    return category("exams-answers");
  }
  return category("other");
}

function category(id: string): WikiCategoryDefinition {
  return CATEGORIES.find((item) => item.id === id)!;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mkdirPrivate(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best effort for mounted or shared development filesystems.
  }
}

function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort for mounted or shared development filesystems.
  }
}
