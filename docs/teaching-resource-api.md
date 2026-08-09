# 教学资料与教研后端 API

所有 `/api/*` 请求在设置了 `MAGI_TEACHER_API_TOKEN` 时都需要：

```http
Authorization: Bearer <token>
```

`GET /health` 不需要鉴权。以下响应示例省略时间字段。

## Project 与 Session

创建项目：

```http
POST /api/projects
Content-Type: application/json

{
  "name": "高一力学教研",
  "grade": "高一",
  "className": "3班",
  "textbookVersion": "人教版"
}
```

项目接口：

- `GET /api/projects`
- `GET /api/projects/:projectId`
- `GET /api/projects/:projectId/sessions`
- `POST /api/projects/:projectId/sessions`
- `GET /api/sessions/:sessionId`

创建 Session 时，`kind` 可取：`exam-analysis`、`lesson-planning`、`practice-adjustment`、`retest-review`、`general`。

向 Session 发消息：

```http
POST /api/sessions/:sessionId/messages
Content-Type: application/json

{
  "prompt": "根据这次考试，我下一节课先讲什么？",
  "resourceQuery": "摩擦力 受力分析",
  "resourceFilters": {
    "grade": "高一"
  }
}
```

设置 `resourceQuery` 后，后端会同时检索项目上传资料和启用的远程资料源，并把命中的摘要作为本次回答的依据。不会把远程资料整库复制到本地。

本地资料检索支持自然语言相关性匹配：文件标题与查询中的中英文关键词可分词命中；当教师明确说“根据已上传资料”但没有重复文件名时，会补充最近上传的少量项目资料。与资料无关的查询不会自动混入全部文件。

## 教师上传资料

上传使用原始请求体，不使用 multipart：

```http
POST /api/projects/:projectId/resources/upload?filename=期中答题明细.csv&kind=exam-results
Content-Type: text/csv

<文件字节>
```

资料列表和检索：

- `GET /api/projects/:projectId/resources`
- `POST /api/projects/:projectId/resources/search`
- `GET /api/projects/:projectId/wiki`

检索请求：

```json
{
  "query": "牛顿第一定律",
  "limit": 20,
  "filters": {
    "grade": "八年级"
  }
}
```

当前版本会为纯文本、Markdown、CSV 和 JSON 直接保存有限长度的可检索正文。PDF 优先通过可配置的 `pdftotext`（环境变量 `MAGI_PDFTOTEXT_PATH`）抽取前 20 页，macOS 上的 Word 文件通过系统 `textutil` 抽取正文；抽取工具不可用时仍登记私有原文件并在来源页标记为“仅登记来源”。Excel、PPT、图片 OCR 和题目结构化可以继续作为异步处理器接入。

每次项目资料导入后都会刷新 `workspace/wiki/`：`INDEX.md` 是总目录，分类页按课标教材、试卷答案、成绩学情、教案课件和作业练习组织资料，`sources/` 中的来源页保留资料 ID、原目录、文本预览和私有原文件相对路径。桌面端文件夹导入由主进程递归扫描和顺序读取，不把整批文件字节传到 Renderer；内容相同的文件按 SHA-256 自动去重。

## 闭源教学资料 Provider

注册远程资料源：

```http
POST /api/projects/:projectId/resource-sources
Content-Type: application/json

{
  "name": "校本物理资料库",
  "baseUrl": "https://materials.example.com",
  "apiKeyEnv": "SCHOOL_MATERIALS_API_KEY",
  "searchPath": "/v1/search"
}
```

这里保存的是环境变量名，不是密钥本身。部署时单独设置：

```bash
export SCHOOL_MATERIALS_API_KEY="<private value>"
```

后端向资料服务发送：

```http
POST /v1/search
Authorization: Bearer <value from SCHOOL_MATERIALS_API_KEY>
Content-Type: application/json

{
  "query": "牛顿第一定律",
  "filters": {
    "grade": "八年级"
  },
  "limit": 20
}
```

闭源资料服务返回：

```json
{
  "items": [
    {
      "id": "curriculum-8-3",
      "title": "课标：运动和力",
      "kind": "curriculum",
      "snippet": "与本次检索有关的短摘要",
      "source": "校本物理资料库",
      "metadata": {
        "grade": "八年级"
      }
    }
  ]
}
```

Provider 应只返回完成当前任务所需的片段和引用标识。教材全文、整张试卷和学生明细是否允许返回，应由闭源资料服务根据租户权限决定。

## 长期记忆审核

- `GET /api/projects/:projectId/memory`
- `GET /api/projects/:projectId/memory?file=projects/context.md`
- `GET /api/projects/:projectId/memory/drafts`
- `POST /api/projects/:projectId/memory/drafts`
- `POST /api/projects/:projectId/memory/drafts/:draftId/apply`
- `POST /api/projects/:projectId/memory/drafts/:draftId/reject`

创建记忆草稿：

```json
{
  "category": "session",
  "sourceSession": "<session-id>",
  "content": "学生对速度图像斜率的意义容易混淆。",
  "reason": "月考错题统计",
  "confidence": 0.9
}
```

`category` 可取 `project`、`preference`、`decision`、`session`。草稿只有执行 `apply` 后才会进入同一项目后续 Session 可读取的正式记忆。
