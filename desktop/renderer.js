import { renderMarkdown } from "./markdown-renderer.js";

const desktop = window.physicsTeacherDesktop;

const state = {
  projects: [],
  project: null,
  sessions: [],
  session: null,
  resources: [],
  artifacts: [],
  wiki: null,
  messageAttachments: [],
  memoryFiles: [],
  memoryDrafts: [],
  importingMode: null,
  permissionScope: "project-write",
  sending: false,
  stopping: false,
  settlingCancellation: false,
  activeRequestId: null,
  activeSessionId: null,
  activePendingMessage: null,
  queuedFollowUps: [],
  loadingSession: false,
  previewFile: null,
  previewObjectUrl: null
};

const ui = {
  appShell: document.querySelector("#app"),
  projectSelect: document.querySelector("#project-select"),
  projectMeta: document.querySelector("#project-meta"),
  newProjectButton: document.querySelector("#new-project-button"),
  newSessionButton: document.querySelector("#new-session-button"),
  sessionList: document.querySelector("#session-list"),
  sessionKind: document.querySelector("#session-kind"),
  sessionTitle: document.querySelector("#session-title"),
  messageArea: document.querySelector("#message-area"),
  messageList: document.querySelector("#message-list"),
  emptyChat: document.querySelector("#empty-chat"),
  composerForm: document.querySelector("#composer-form"),
  composerInput: document.querySelector("#composer-input"),
  attachMessageButton: document.querySelector("#attach-message-button"),
  messageAttachmentList: document.querySelector("#message-attachment-list"),
  permissionScopeButton: document.querySelector("#permission-scope-button"),
  permissionScopeLabel: document.querySelector("#permission-scope-label"),
  permissionScopeMenu: document.querySelector("#permission-scope-menu"),
  permissionScopeItems: [...document.querySelectorAll("[data-permission-scope]")],
  composerModelButton: document.querySelector("#composer-model-button"),
  composerModelLabel: document.querySelector("#composer-model-label"),
  sendButton: document.querySelector("#send-button"),
  inspector: document.querySelector("#inspector"),
  toggleInspectorButton: document.querySelector("#toggle-inspector-button"),
  closeInspectorButton: document.querySelector("#close-inspector-button"),
  uploadButton: document.querySelector("#upload-button"),
  folderUploadButton: document.querySelector("#folder-upload-button"),
  quickUploadButton: document.querySelector("#quick-upload-button"),
  quickFolderUploadButton: document.querySelector("#quick-folder-upload-button"),
  resourceOnboarding: document.querySelector("#resource-onboarding"),
  resourceCountBadge: document.querySelector("#resource-count-badge"),
  resourceSummary: document.querySelector("#resource-summary"),
  resourceSearchForm: document.querySelector("#resource-search-form"),
  resourceSearchInput: document.querySelector("#resource-search-input"),
  resourceList: document.querySelector("#resource-list"),
  wikiSummary: document.querySelector("#wiki-summary"),
  wikiCategoryList: document.querySelector("#wiki-category-list"),
  memoryFileList: document.querySelector("#memory-file-list"),
  memoryDraftList: document.querySelector("#memory-draft-list"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  modelSettingsButton: document.querySelector("#model-settings-button"),
  modelSettingsStatus: document.querySelector("#model-settings-status"),
  projectDialog: document.querySelector("#project-dialog"),
  projectForm: document.querySelector("#project-form"),
  sessionDialog: document.querySelector("#session-dialog"),
  sessionForm: document.querySelector("#session-form"),
  modelSettingsDialog: document.querySelector("#model-settings-dialog"),
  modelSettingsForm: document.querySelector("#model-settings-form"),
  modelKeyHelp: document.querySelector("#model-key-help"),
  artifactPreviewDialog: document.querySelector("#artifact-preview-dialog"),
  artifactPreviewTitle: document.querySelector("#artifact-preview-title"),
  artifactPreviewMeta: document.querySelector("#artifact-preview-meta"),
  artifactPreviewBody: document.querySelector("#artifact-preview-body"),
  artifactPreviewCloseButton: document.querySelector("#artifact-preview-close-button"),
  artifactOpenButton: document.querySelector("#artifact-open-button"),
  toast: document.querySelector("#toast")
};

const kindLabels = {
  "exam-analysis": "考试分析",
  "lesson-planning": "教师备课",
  "practice-adjustment": "练习调整",
  "retest-review": "复测回顾",
  general: "物理教研"
};

async function api(method, path, payload = {}) {
  const response = await desktop.request({ method, path, ...payload });
  if (!response.ok) {
    throw new Error(response.data?.error || `请求失败（${response.status}）`);
  }
  return response.data;
}

async function initialize() {
  try {
    setInspectorOpen(true);
    const savedPermissionScope = localStorage.getItem("physics-teacher-permission-scope");
    state.permissionScope = normalizePermissionScope(savedPermissionScope);
    renderPermissionScope();
    await api("GET", "/health");
    setConnection(true);
    await loadModelSettings();
    const result = await api("GET", "/api/projects");
    state.projects = result.projects || [];
    renderProjects();
    if (state.projects.length > 0) {
      await selectProject(state.projects[0].id);
    } else {
      renderNoProject();
      ui.projectDialog.showModal();
    }
  } catch (error) {
    setConnection(false);
    showToast(error.message, true);
  }
}

async function loadModelSettings() {
  const settings = await desktop.getModelSettings();
  ui.modelSettingsForm.elements.baseUrl.value = settings.baseUrl || "https://api.openai.com/v1";
  ui.modelSettingsForm.elements.model.value = settings.model || "";
  ui.modelSettingsForm.elements.apiKey.value = "";
  ui.modelKeyHelp.textContent = settings.hasApiKey
    ? "已安全保存；留空表示继续使用当前 Key"
    : "首次配置时必填";
  ui.modelSettingsStatus.textContent =
    settings.hasApiKey && settings.model ? `已配置 · ${settings.model}` : "未配置";
  ui.composerModelLabel.textContent = settings.model || "设置模型";
  ui.modelSettingsStatus.classList.toggle(
    "configured",
    settings.hasApiKey && Boolean(settings.model)
  );
  return settings;
}

async function saveModelSettings(form) {
  const submitButton = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());
  submitButton.disabled = true;
  submitButton.textContent = "正在保存…";
  try {
    const settings = await desktop.saveModelSettings(data);
    ui.modelSettingsDialog.close();
    form.elements.apiKey.value = "";
    ui.modelKeyHelp.textContent = "已安全保存；留空表示继续使用当前 Key";
    ui.modelSettingsStatus.textContent = `已配置 · ${settings.model}`;
    ui.composerModelLabel.textContent = settings.model;
    ui.modelSettingsStatus.classList.add("configured");
    showToast("模型接口已保存，新的对话将立即使用这项配置");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "保存并使用";
  }
}

function setConnection(online) {
  ui.connectionDot.classList.toggle("online", online);
  ui.connectionDot.classList.toggle("offline", !online);
  ui.connectionLabel.textContent = online ? "本地服务已连接" : "本地服务连接失败";
}

function renderProjects() {
  ui.projectSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.projects.length === 0 ? "还没有教学项目" : "请选择项目";
  ui.projectSelect.append(placeholder);
  if (state.projects.length === 0) {
    ui.projectSelect.value = "";
    return;
  }
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    ui.projectSelect.append(option);
  }
  ui.projectSelect.value = state.project?.id || "";
}

async function selectProject(projectId) {
  if ((state.sending || state.settlingCancellation) && state.project?.id !== projectId) {
    showToast("当前回答仍在生成，请先停止或等待完成");
    renderProjects();
    return;
  }
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  state.project = project;
  state.session = null;
  state.sessions = [];
  state.resources = [];
  state.artifacts = [];
  state.wiki = null;
  state.messageAttachments = [];
  state.queuedFollowUps = [];
  state.memoryFiles = [];
  state.memoryDrafts = [];
  renderProjects();
  renderProjectHeader();
  renderSessions();
  renderResources();
  renderMessageAttachments();
  renderChat();
  setProjectControls(true);

  try {
    const [sessionsResult, resourcesResult, wikiResult, memoryResult, draftsResult, artifacts] =
      await Promise.all([
        api("GET", `/api/projects/${encodeURIComponent(projectId)}/sessions`),
        api("GET", `/api/projects/${encodeURIComponent(projectId)}/resources`),
        api("GET", `/api/projects/${encodeURIComponent(projectId)}/wiki`),
        api("GET", `/api/projects/${encodeURIComponent(projectId)}/memory`),
        api("GET", `/api/projects/${encodeURIComponent(projectId)}/memory/drafts`),
        desktop.listArtifacts(projectId)
      ]);
    if (state.project?.id !== projectId) return;
    state.sessions = sessionsResult.sessions || [];
    state.resources = resourcesResult.resources || [];
    state.artifacts = artifacts || [];
    state.wiki = wikiResult.wiki || null;
    state.memoryFiles = memoryResult.files || [];
    state.memoryDrafts = draftsResult.drafts || [];
    renderSessions();
    renderResources();
    renderMemory();
    if (state.sessions.length > 0) await selectSession(state.sessions[0].sessionId);
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderProjectHeader() {
  if (!state.project) return renderNoProject();
  ui.projectSelect.value = state.project.id;
  ui.projectMeta.textContent = [
    state.project.grade,
    state.project.className,
    state.project.textbookVersion
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderNoProject() {
  ui.projectSelect.value = "";
  ui.projectMeta.textContent = "创建项目后开始教研";
  setProjectControls(false);
  renderSessions();
  renderResources();
  renderMemory();
  renderChat();
}

function setProjectControls(enabled) {
  ui.newSessionButton.disabled = !enabled;
  ui.uploadButton.disabled = !enabled;
  ui.folderUploadButton.disabled = !enabled;
  ui.quickUploadButton.disabled = !enabled;
  ui.quickFolderUploadButton.disabled = !enabled;
  ui.resourceSearchInput.disabled = !enabled;
}

function renderSessions() {
  ui.sessionList.replaceChildren();
  if (!state.project) {
    ui.sessionList.append(emptyList("选择一个项目查看教研记录。"));
    return;
  }
  if (state.sessions.length === 0) {
    ui.sessionList.append(
      emptyList("还没有 Session。点击左侧「新建教研工作」开始考试分析或备课。")
    );
    return;
  }
  for (const session of state.sessions) {
    const button = element("button", "session-item");
    button.type = "button";
    button.classList.toggle("active", session.sessionId === state.session?.id);
    const title = textElement("strong", session.title);
    const meta = element("small");
    const dot = element("span", "session-kind-dot");
    meta.append(dot, document.createTextNode(kindLabels[session.kind] || "物理教研"));
    button.append(title, meta);
    button.addEventListener("click", () => void selectSession(session.sessionId));
    ui.sessionList.append(button);
  }
}

async function selectSession(sessionId) {
  if ((state.sending || state.settlingCancellation) && sessionId !== state.activeSessionId) {
    showToast("当前回答仍在生成，请先停止或等待完成");
    return;
  }
  if (state.loadingSession) return;
  state.loadingSession = true;
  state.messageAttachments = [];
  state.queuedFollowUps = [];
  renderMessageAttachments();
  try {
    const result = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
    state.session = result.session;
    state.session.projectSession = result.projectSession;
    renderSessions();
    renderChat();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.loadingSession = false;
  }
}

function renderChat(extraMessage) {
  const busy = state.sending || state.settlingCancellation;
  const projectSession = state.session?.projectSession;
  ui.sessionTitle.textContent = state.session?.title || "开始一项教研工作";
  ui.sessionKind.textContent = projectSession
    ? kindLabels[projectSession.kind] || "物理教研"
    : "物理教研";
  ui.composerInput.disabled = !state.session;
  ui.attachMessageButton.disabled = !state.session || state.settlingCancellation;
  ui.sendButton.disabled = !state.session || state.settlingCancellation;
  ui.sendButton.classList.toggle("stop", state.sending);
  ui.sendButton.textContent = state.sending ? "■" : "↑";
  ui.sendButton.setAttribute("aria-label", state.sending ? "停止生成" : "发送");
  ui.sendButton.title = state.sending ? "停止生成" : "发送";
  ui.projectSelect.disabled = busy;
  ui.newProjectButton.disabled = busy;
  ui.newSessionButton.disabled = !state.project || busy;
  const messages = (state.session?.messages || []).filter(
    (message) => message.role === "user" || message.role === "assistant"
  );
  const queued = state.queuedFollowUps.filter((message) => message.sessionId === state.session?.id);
  const pendingMessage = extraMessage ?? (state.sending ? state.activePendingMessage : null);
  ui.emptyChat.hidden = messages.length > 0 || Boolean(pendingMessage) || queued.length > 0;
  ui.messageList.replaceChildren();
  for (const message of messages) appendMessage(message);
  if (pendingMessage) appendMessage(pendingMessage);
  for (const message of queued) {
    appendMessage({ role: "user", content: message.visiblePrompt, queued: true });
  }
  requestAnimationFrame(() => {
    ui.messageArea.scrollTop = ui.messageArea.scrollHeight;
  });
}

function appendMessage(message) {
  const { role, content, pending = false, queued = false } = message;
  const article = element(
    "article",
    `message ${role}${pending ? " pending" : ""}${queued ? " queued" : ""}`
  );
  const avatar = element("div", "message-avatar");
  if (role === "user") {
    avatar.textContent = "我";
  } else {
    const image = document.createElement("img");
    image.src = "./assets/app-icon.png";
    image.alt = "";
    avatar.append(image);
  }
  article.append(avatar);
  const container = element("div", "message-content");
  const body = element("div", `message-body${pending ? " typing-dots" : ""}`);
  if (role === "assistant" && !pending) {
    body.classList.add("markdown-body");
    body.append(
      renderMarkdown(content, {
        openExternal: (url) => void desktop.openExternal(url)
      })
    );
    const deliverables = matchingArtifacts(content);
    if (deliverables.length) body.append(renderArtifactCards(deliverables));
  } else {
    const parsed = role === "user" ? splitTemporaryAttachmentManifest(content) : undefined;
    body.textContent = parsed?.content ?? content;
    if (parsed?.filenames.length) {
      const files = element("div", "message-file-list");
      for (const filename of parsed.filenames) {
        const chip = element("div", "message-file-chip");
        chip.append(textElement("span", `📎 ${filename}`));
        files.append(chip);
      }
      body.append(files);
    }
  }
  container.append(textElement("div", role === "user" ? "教师" : "Magi", "message-meta"), body);
  article.append(container);
  ui.messageList.append(article);
}

async function sendCurrentMessage(promptOverride, queuedMessage) {
  if (!state.session || state.sending || state.settlingCancellation) return;
  const sessionId = state.session.id;
  const requestId = crypto.randomUUID();
  const attachments = queuedMessage
    ? [...queuedMessage.attachments]
    : [...state.messageAttachments];
  const permissionScope = queuedMessage?.permissionScope || state.permissionScope;
  const typedPrompt = (queuedMessage?.prompt || promptOverride || ui.composerInput.value).trim();
  const prompt =
    typedPrompt || (attachments.length ? "请处理这份资料，先说明你读到了什么，再给出分析。" : "");
  if (!prompt) return;
  const visiblePrompt = appendTemporaryAttachmentManifest(
    prompt,
    attachments.map((attachment) => attachment.name)
  );
  const optimisticMessages = [
    ...(state.session.messages || []),
    { role: "user", content: visiblePrompt }
  ];
  state.session.messages = optimisticMessages;
  state.sending = true;
  state.stopping = false;
  state.settlingCancellation = false;
  state.activeRequestId = requestId;
  state.activeSessionId = sessionId;
  if (!queuedMessage) state.messageAttachments = [];
  state.activePendingMessage = {
    role: "assistant",
    content: attachments.length ? "正在读取本次资料并整理" : "正在阅读项目资料并整理",
    pending: true
  };
  if (!queuedMessage) ui.composerInput.value = "";
  resizeComposer();
  renderMessageAttachments();
  renderChat();
  try {
    const response = attachments.length
      ? await desktop.sendMessageWithAttachments({
          sessionId,
          requestId,
          prompt,
          permissionScope,
          files: attachments
        })
      : await desktop.sendMessage({
          sessionId,
          requestId,
          prompt,
          permissionScope
        });
    const fresh = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
    if (state.session?.id === sessionId) {
      state.session = fresh.session;
      state.session.projectSession = fresh.projectSession;
      const hasAssistant = state.session.messages.some(
        (message) => message.role === "assistant" && message.content === response.result?.message
      );
      if (response.result?.message && !hasAssistant) {
        state.session.messages.push({ role: "assistant", content: response.result.message });
      }
    }
    try {
      await refreshArtifacts();
    } catch (error) {
      showToast(`交付文件列表刷新失败：${error.message}`, true);
    }
    try {
      await refreshMemory();
    } catch (error) {
      showToast(`项目记忆列表刷新失败：${error.message}`, true);
    }
  } catch (error) {
    if (state.session?.id === sessionId) {
      state.session.messages = optimisticMessages;
      state.session.messages.push({ role: "assistant", content: `这次没有完成：${error.message}` });
    }
    showToast(error.message, true);
  } finally {
    if (state.activeRequestId === requestId) {
      state.sending = false;
      state.stopping = false;
      state.settlingCancellation = false;
      state.activePendingMessage = null;
      state.activeRequestId = null;
      state.activeSessionId = null;
    }
    renderChat();
    renderMessageAttachments();
    ui.composerInput.focus();
    const next = state.queuedFollowUps.shift();
    if (next && state.session?.id === sessionId) void sendCurrentMessage(next.prompt, next);
  }
}

function queueCurrentFollowUp() {
  if (!state.session || !state.sending) return;
  const attachments = [...state.messageAttachments];
  const typedPrompt = ui.composerInput.value.trim();
  const prompt =
    typedPrompt || (attachments.length ? "请处理这份资料，先说明你读到了什么，再给出分析。" : "");
  if (!prompt) return;
  state.queuedFollowUps.push({
    sessionId: state.session.id,
    prompt,
    attachments,
    permissionScope: state.permissionScope,
    visiblePrompt: appendTemporaryAttachmentManifest(
      prompt,
      attachments.map((attachment) => attachment.name)
    )
  });
  state.messageAttachments = [];
  ui.composerInput.value = "";
  resizeComposer();
  renderMessageAttachments();
  renderChat();
  showToast("已加入追问，Magi 完成本轮后会接着处理");
}

async function stopCurrentMessage() {
  if (!state.sending || !state.activeRequestId || !state.activeSessionId || state.stopping) return;
  const requestId = state.activeRequestId;
  const sessionId = state.activeSessionId;
  const cancelledMessage = {
    role: "assistant",
    content: "已停止本次生成。你可以修改要求后继续追问。",
    optimisticCancellation: true
  };
  state.stopping = true;
  state.sending = false;
  state.settlingCancellation = true;
  state.activePendingMessage = null;
  if (state.session?.id === sessionId) state.session.messages.push(cancelledMessage);
  renderChat();
  try {
    const result = await desktop.cancelMessage({
      requestId,
      sessionId
    });
    if (!result.cancelled) {
      showToast("这次生成已经结束");
      const fresh = await api("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
      if (state.session?.id === sessionId) {
        state.session = fresh.session;
        state.session.projectSession = fresh.projectSession;
      }
      if (state.activeRequestId === requestId) {
        state.stopping = false;
        state.settlingCancellation = false;
        state.activeRequestId = null;
        state.activeSessionId = null;
      }
      renderChat();
    }
  } catch (error) {
    if (state.session?.id === sessionId) {
      state.session.messages = state.session.messages.filter(
        (message) => message !== cancelledMessage
      );
    }
    if (state.activeRequestId === requestId) {
      state.sending = true;
      state.stopping = false;
      state.settlingCancellation = false;
      state.activePendingMessage = {
        role: "assistant",
        content: "正在继续生成",
        pending: true
      };
    }
    showToast(error.message, true);
    renderChat();
  }
}

async function chooseMessageAttachments() {
  if (!state.session || state.settlingCancellation) return;
  try {
    const files = await desktop.chooseMessageFiles();
    if (!files?.length) return;
    const combined = [...state.messageAttachments, ...files];
    if (combined.length > 5) throw new Error("每次对话最多添加 5 份临时资料");
    const totalBytes = combined.reduce(
      (sum, file) => sum + (Number(file.sizeBytes) || file.bytes?.length || 0),
      0
    );
    if (totalBytes > 32 * 1024 * 1024) throw new Error("本次对话资料总大小不能超过 32 MB");
    state.messageAttachments = combined;
    renderMessageAttachments();
    ui.composerInput.focus();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderMessageAttachments() {
  ui.messageAttachmentList.replaceChildren();
  ui.messageAttachmentList.hidden = state.messageAttachments.length === 0;
  for (const [index, attachment] of state.messageAttachments.entries()) {
    const chip = element("div", "message-attachment-chip");
    const size = Number(attachment.sizeBytes) || attachment.bytes?.length || 0;
    chip.append(textElement("span", `📎 ${attachment.name} · ${formatBytes(size)}`));
    const remove = textElement("button", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除 ${attachment.name}`);
    remove.addEventListener("click", () => {
      state.messageAttachments.splice(index, 1);
      renderMessageAttachments();
    });
    chip.append(remove);
    ui.messageAttachmentList.append(chip);
  }
}

function appendTemporaryAttachmentManifest(content, filenames) {
  if (!filenames.length) return content;
  return [content, "", "[本次附件]", ...filenames.map((filename) => `- ${filename}`)].join("\n");
}

function splitTemporaryAttachmentManifest(content) {
  const marker = "\n\n[本次附件]\n";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return { content, filenames: [] };
  const filenames = content
    .slice(markerIndex + marker.length)
    .split("\n")
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  return { content: content.slice(0, markerIndex), filenames };
}

function normalizePermissionScope(value) {
  return value === "read-only" || value === "approval" ? value : "project-write";
}

function renderPermissionScope() {
  const labels = {
    "project-write": "项目内读写",
    "read-only": "只读",
    approval: "操作前询问"
  };
  const descriptions = {
    "project-write": "可写 workspace 和 artifacts，原始资料与长期记忆保持只读",
    "read-only": "只允许检索和分析，不写文件、不运行修改性命令",
    approval: "写文件或运行命令前弹出审批，只允许一次或拒绝"
  };
  ui.permissionScopeLabel.textContent = labels[state.permissionScope];
  ui.permissionScopeButton.title = descriptions[state.permissionScope];
  ui.permissionScopeButton.dataset.scope = state.permissionScope;
  for (const item of ui.permissionScopeItems) {
    item.setAttribute(
      "aria-checked",
      String(item.dataset.permissionScope === state.permissionScope)
    );
  }
}

function setPermissionMenuOpen(open) {
  ui.permissionScopeMenu.hidden = !open;
  ui.permissionScopeButton.setAttribute("aria-expanded", String(open));
  if (open) {
    ui.permissionScopeItems
      .find((item) => item.dataset.permissionScope === state.permissionScope)
      ?.focus();
  } else if (ui.permissionScopeMenu.contains(document.activeElement)) {
    ui.permissionScopeButton.focus();
  }
}

function renderResources(items = state.resources) {
  renderResourceStatus();
  ui.resourceList.replaceChildren();
  if (!state.project) {
    ui.resourceList.append(emptyList("选择项目后查看资料。"));
    return;
  }
  if (items.length === 0) {
    ui.resourceList.append(emptyList("还没有资料。可以先上传集中考试成绩、答题明细或试卷。"));
    return;
  }
  for (const resource of items) {
    const card = element("article", "resource-card");
    card.append(textElement("strong", resource.title));
    const details = [
      resource.source || resource.kind || "教学资料",
      resource.sizeBytes ? formatBytes(resource.sizeBytes) : null
    ]
      .filter(Boolean)
      .join(" · ");
    card.append(textElement("div", details, "resource-meta"));
    if (resource.snippet || resource.excerpt) {
      card.append(textElement("div", resource.snippet || resource.excerpt, "resource-snippet"));
    }
    const filename = resource.originalFilename || resource.title;
    if (canPreviewClient(filename)) {
      const actions = element("div", "file-card-actions");
      const preview = textElement("button", "预览", "file-action-button primary");
      const open = textElement("button", "打开", "file-action-button");
      preview.type = open.type = "button";
      const request = {
        source: "resource",
        projectId: state.project.id,
        resourceId: resource.id
      };
      preview.addEventListener("click", () => void previewProjectFile(request));
      open.addEventListener("click", () => void openProjectFile(request));
      actions.append(preview, open);
      card.append(actions);
    }
    ui.resourceList.append(card);
  }
}

function renderResourceStatus() {
  const count = state.project ? state.resources.length : 0;
  ui.resourceCountBadge.textContent = String(count);
  ui.resourceSummary.textContent =
    count > 0 ? `已加入 ${count} 份资料，供本项目所有 Session 使用` : "还没有上传资料";
  ui.resourceOnboarding.hidden = !state.project || count > 0;
  ui.toggleInspectorButton.classList.toggle(
    "needs-resources",
    Boolean(state.project) && count === 0
  );
  ui.toggleInspectorButton.setAttribute(
    "aria-label",
    state.project ? `查看项目资料，当前 ${count} 份` : "查看项目资料"
  );
  renderWikiStatus();
}

function renderWikiStatus() {
  ui.wikiCategoryList.replaceChildren();
  const wiki = state.wiki;
  if (!wiki || wiki.resourceCount === 0) {
    ui.wikiSummary.textContent = "导入资料后自动生成分类目录和来源页";
    return;
  }
  ui.wikiSummary.textContent = `已整理 ${wiki.resourceCount} 份资料，Magi 可按目录检索和追溯原文件`;
  for (const category of wiki.categories || []) {
    if (!category.count) continue;
    ui.wikiCategoryList.append(textElement("span", `${category.label} ${category.count}`));
  }
}

function setUploadState(uploading, mode) {
  ui.uploadButton.disabled = uploading || !state.project;
  ui.folderUploadButton.disabled = uploading || !state.project;
  ui.quickUploadButton.disabled = uploading || !state.project;
  ui.quickFolderUploadButton.disabled = uploading || !state.project;
  if (uploading) {
    const label = mode === "folder" ? "正在导入文件夹…" : "正在导入文件…";
    (mode === "folder" ? ui.folderUploadButton : ui.uploadButton).textContent = label;
    (mode === "folder" ? ui.quickFolderUploadButton : ui.quickUploadButton).textContent =
      "正在整理…";
    return;
  }
  ui.uploadButton.replaceChildren(textElement("span", "＋"), document.createTextNode(" 添加文件"));
  ui.folderUploadButton.replaceChildren(
    textElement("span", "↥"),
    document.createTextNode(" 导入文件夹")
  );
  ui.quickUploadButton.textContent = "选择文件";
  ui.quickFolderUploadButton.textContent = "导入文件夹";
}

function setImportProgress(progress) {
  if (!state.importingMode) return;
  const label =
    progress?.phase === "wiki"
      ? "正在生成知识库…"
      : `正在整理 ${progress?.current || 0}/${progress?.total || 0}`;
  const activeButton = state.importingMode === "folder" ? ui.folderUploadButton : ui.uploadButton;
  const activeQuickButton =
    state.importingMode === "folder" ? ui.quickFolderUploadButton : ui.quickUploadButton;
  activeButton.textContent = label;
  activeQuickButton.textContent = label;
}

async function uploadResources(mode = "files") {
  if (!state.project) return;
  const projectId = state.project.id;
  try {
    state.importingMode = mode;
    setUploadState(true, mode);
    const result = await desktop.importProjectMaterials({ projectId, mode });
    if (result?.canceled) return;
    state.wiki = result.wiki || null;
    if (state.project?.id === projectId) await refreshResources();
    activateInspectorTab("resources");
    setInspectorOpen(true);
    const notes = [
      `新增 ${result.addedCount} 份资料`,
      result.duplicateCount ? `跳过 ${result.duplicateCount} 份重复文件` : null,
      result.skippedUnsupported ? `忽略 ${result.skippedUnsupported} 个不支持的文件` : null,
      result.skippedOversized ? `忽略 ${result.skippedOversized} 个超大文件` : null
    ].filter(Boolean);
    showToast(`${notes.join("，")}；知识库已更新`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.importingMode = null;
    setUploadState(false, mode);
  }
}

async function refreshResources() {
  if (!state.project) return;
  const result = await api(
    "GET",
    `/api/projects/${encodeURIComponent(state.project.id)}/resources`
  );
  state.resources = result.resources || [];
  renderResources();
}

async function refreshArtifacts() {
  if (!state.project) return;
  state.artifacts = (await desktop.listArtifacts(state.project.id)) || [];
}

async function searchResources(query) {
  if (!state.project || !query.trim()) return renderResources();
  try {
    const result = await api(
      "POST",
      `/api/projects/${encodeURIComponent(state.project.id)}/resources/search`,
      { json: { query: query.trim(), limit: 30 } }
    );
    renderResources(result.items || []);
    if (result.warnings?.length) showToast(result.warnings.join("；"), true);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function refreshMemory() {
  if (!state.project) return;
  const projectId = state.project.id;
  const [memoryResult, draftsResult] = await Promise.all([
    api("GET", `/api/projects/${encodeURIComponent(projectId)}/memory`),
    api("GET", `/api/projects/${encodeURIComponent(projectId)}/memory/drafts`)
  ]);
  if (state.project?.id !== projectId) return;
  state.memoryFiles = memoryResult.files || [];
  state.memoryDrafts = draftsResult.drafts || [];
  renderMemory();
}

function renderMemory() {
  ui.memoryDraftList.replaceChildren();
  ui.memoryFileList.replaceChildren();
  const pending = state.memoryDrafts.filter((draft) => draft.status === "pending");
  if (pending.length === 0) {
    ui.memoryDraftList.append(emptyList("当前没有待确认的记忆。"));
  } else {
    for (const draft of pending) {
      const card = element("article", "memory-card");
      card.append(
        textElement("strong", draft.content || draft.targetFile),
        textElement("div", draft.reason || "来自教研对话", "memory-meta")
      );
      const actions = element("div", "draft-actions");
      const approve = textElement("button", "确认写入", "approve");
      const reject = textElement("button", "暂不采用", "reject");
      approve.type = reject.type = "button";
      approve.addEventListener("click", () => void reviewDraft(draft.id, "apply"));
      reject.addEventListener("click", () => void reviewDraft(draft.id, "reject"));
      actions.append(approve, reject);
      card.append(actions);
      ui.memoryDraftList.append(card);
    }
  }
  const formalFiles = state.memoryFiles.filter((file) => isTeacherVisibleMemory(file.path));
  if (formalFiles.length === 0) {
    ui.memoryFileList.append(emptyList("还没有正式项目记忆。"));
  } else {
    for (const file of formalFiles) {
      const card = element("article", "memory-card");
      card.append(
        textElement("strong", memoryLabel(file.path)),
        textElement(
          "div",
          `${formatBytes(file.size)} · ${formatDate(file.updatedAt)}`,
          "memory-meta"
        )
      );
      ui.memoryFileList.append(card);
    }
  }
}

async function reviewDraft(draftId, action) {
  if (!state.project) return;
  try {
    await api(
      "POST",
      `/api/projects/${encodeURIComponent(state.project.id)}/memory/drafts/${encodeURIComponent(draftId)}/${action}`
    );
    await refreshMemory();
    showToast(action === "apply" ? "已写入项目记忆" : "已拒绝这条记忆");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function createProject(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const result = await api("POST", "/api/projects", { json: data });
  state.projects.unshift(result.project);
  ui.projectDialog.close();
  form.reset();
  renderProjects();
  await selectProject(result.project.id);
  activateInspectorTab("resources");
  setInspectorOpen(true);
  showToast("教学项目已建立");
}

async function createSession(form) {
  if (!state.project) return;
  const data = Object.fromEntries(new FormData(form).entries());
  const result = await api(
    "POST",
    `/api/projects/${encodeURIComponent(state.project.id)}/sessions`,
    { json: data }
  );
  state.sessions.unshift(result.session);
  ui.sessionDialog.close();
  form.reset();
  renderSessions();
  await selectSession(result.session.sessionId);
  ui.composerInput.focus();
}

function activateInspectorTab(name) {
  document.querySelectorAll(".inspector-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".inspector-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${name}-panel`);
  });
}

function setInspectorOpen(open) {
  ui.appShell.classList.toggle("inspector-open", open);
  ui.inspector.classList.toggle("open", open);
  ui.inspector.setAttribute("aria-hidden", String(!open));
  ui.toggleInspectorButton.setAttribute("aria-expanded", String(open));
}

function matchingArtifacts(content) {
  const normalized = String(content || "").replaceAll("\\", "/");
  return state.artifacts.filter(
    (artifact) =>
      normalized.includes(artifact.relativePath) ||
      normalized.includes(`artifacts/${artifact.relativePath}`) ||
      normalized.includes(artifact.name)
  );
}

function renderArtifactCards(artifacts) {
  const section = element("section", "artifact-deliverables");
  section.append(textElement("div", "交付文件", "artifact-deliverables-label"));
  for (const artifact of artifacts) {
    const card = element("div", "artifact-card");
    const icon = textElement(
      "span",
      artifact.extension.replace(/^\./, "").toUpperCase() || "FILE",
      "artifact-file-type"
    );
    const copy = element("div", "artifact-card-copy");
    copy.append(
      textElement("strong", artifact.name),
      textElement(
        "small",
        `${formatBytes(artifact.sizeBytes)} · ${formatDateTime(artifact.updatedAt)}`
      )
    );
    const actions = element("div", "file-card-actions");
    const preview = textElement("button", "预览", "file-action-button primary");
    const open = textElement("button", "打开", "file-action-button");
    preview.type = open.type = "button";
    const request = {
      source: "artifact",
      projectId: state.project.id,
      relativePath: artifact.relativePath
    };
    preview.addEventListener("click", () => void previewProjectFile(request));
    open.addEventListener("click", () => void openProjectFile(request));
    actions.append(preview, open);
    card.append(icon, copy, actions);
    section.append(card);
  }
  return section;
}

async function previewProjectFile(request) {
  state.previewFile = request;
  ui.artifactPreviewTitle.textContent = "正在打开…";
  ui.artifactPreviewMeta.textContent = "";
  ui.artifactPreviewBody.replaceChildren(textElement("div", "正在生成预览…", "preview-loading"));
  ui.artifactOpenButton.disabled = true;
  if (!ui.artifactPreviewDialog.open) ui.artifactPreviewDialog.showModal();
  try {
    const preview = await desktop.previewProjectFile(request);
    if (state.previewFile !== request) return;
    ui.artifactPreviewTitle.textContent = preview.name;
    ui.artifactPreviewMeta.textContent = `${preview.extension.replace(/^\./, "").toUpperCase()} · ${formatBytes(preview.sizeBytes)} · ${formatDateTime(preview.updatedAt)}`;
    ui.artifactPreviewBody.replaceChildren(renderFilePreview(preview));
    ui.artifactOpenButton.disabled = false;
  } catch (error) {
    ui.artifactPreviewTitle.textContent = "暂时无法预览";
    ui.artifactPreviewMeta.textContent = "可以尝试用默认应用打开";
    ui.artifactPreviewBody.replaceChildren(
      textElement("div", error.message || String(error), "preview-error")
    );
    ui.artifactOpenButton.disabled = false;
  }
}

function renderFilePreview(preview) {
  if (preview.kind === "markdown") {
    const body = element("article", "artifact-markdown-preview markdown-body");
    body.append(
      renderMarkdown(preview.content, {
        openExternal: (url) => void desktop.openExternal(url)
      })
    );
    return body;
  }
  if (preview.kind === "html") {
    const frame = element("iframe", "artifact-preview-frame");
    frame.setAttribute("sandbox", "");
    frame.title = preview.name;
    frame.srcdoc = preview.content;
    return frame;
  }
  if (preview.kind === "pdf") {
    const frame = element("iframe", "artifact-preview-frame");
    frame.title = preview.name;
    revokePreviewObjectUrl();
    const bytes = base64ToBytes(preview.dataBase64);
    state.previewObjectUrl = URL.createObjectURL(
      new Blob([bytes], { type: preview.mimeType || "application/pdf" })
    );
    frame.src = state.previewObjectUrl;
    return frame;
  }
  if (preview.kind === "image") {
    const image = element("img", "artifact-preview-image");
    image.alt = preview.name;
    image.src = `data:${preview.mimeType};base64,${preview.dataBase64}`;
    return image;
  }
  const text = element("pre", "artifact-text-preview");
  text.textContent = preview.content || "";
  return text;
}

async function openProjectFile(request = state.previewFile) {
  if (!request) return;
  try {
    await desktop.openProjectFile(request);
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

function closeArtifactPreview() {
  state.previewFile = null;
  revokePreviewObjectUrl();
  ui.artifactPreviewDialog.close();
  ui.artifactPreviewBody.replaceChildren();
}

function revokePreviewObjectUrl() {
  if (!state.previewObjectUrl) return;
  URL.revokeObjectURL(state.previewObjectUrl);
  state.previewObjectUrl = null;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function canPreviewClient(filename) {
  return /\.(md|markdown|html?|pdf|docx?|txt|csv|json|png|jpe?g|webp)$/i.test(filename || "");
}

function resizeComposer() {
  ui.composerInput.style.height = "auto";
  ui.composerInput.style.height = `${Math.min(ui.composerInput.scrollHeight, 150)}px`;
}

let toastTimer;
function showToast(message, error = false) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.toggle("error", error);
  ui.toast.classList.add("show");
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 3_400);
}

function element(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textElement(tag, text, className) {
  const node = element(tag, className);
  node.textContent = text ?? "";
  return node;
}

function emptyList(text) {
  return textElement("div", text, "empty-list");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(
    new Date(value)
  );
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function memoryLabel(path) {
  const labels = {
    "projects/context.md": "项目基本信息",
    "projects/default.md": "项目补充信息",
    "preferences.md": "教师偏好",
    "decisions/teaching.md": "教学决定",
    "INDEX.md": "记忆索引"
  };
  if (labels[path]) return labels[path];
  if (path.startsWith("sessions/")) return "Session 学情记录";
  return path;
}

function isTeacherVisibleMemory(path) {
  return (
    path === "projects/context.md" ||
    path === "projects/default.md" ||
    path === "preferences.md" ||
    path === "decisions/teaching.md" ||
    path.startsWith("sessions/")
  );
}

ui.newProjectButton.addEventListener("click", () => ui.projectDialog.showModal());
ui.modelSettingsButton.addEventListener("click", () => {
  void loadModelSettings()
    .then(() => ui.modelSettingsDialog.showModal())
    .catch((error) => showToast(error.message, true));
});
ui.composerModelButton.addEventListener("click", () => {
  void loadModelSettings()
    .then(() => ui.modelSettingsDialog.showModal())
    .catch((error) => showToast(error.message, true));
});
ui.projectSelect.addEventListener("change", () => {
  if (ui.projectSelect.value) void selectProject(ui.projectSelect.value);
});
ui.newSessionButton.addEventListener("click", () => ui.sessionDialog.showModal());
ui.projectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createProject(ui.projectForm).catch((error) => showToast(error.message, true));
});
ui.sessionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createSession(ui.sessionForm).catch((error) => showToast(error.message, true));
});
ui.modelSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveModelSettings(ui.modelSettingsForm).catch((error) => showToast(error.message, true));
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
ui.composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.sending) void stopCurrentMessage();
  else if (state.settlingCancellation) showToast("停止已经生效，正在完成后台收尾");
  else void sendCurrentMessage();
});
ui.composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (state.sending) {
      queueCurrentFollowUp();
    } else if (state.settlingCancellation) {
      showToast("停止已经生效，正在完成后台收尾");
    } else {
      void sendCurrentMessage();
    }
  }
});
ui.composerInput.addEventListener("input", resizeComposer);
ui.attachMessageButton.addEventListener("click", () => void chooseMessageAttachments());
document.querySelectorAll(".starter-card").forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.session) {
      if (state.project) ui.sessionDialog.showModal();
      else ui.projectDialog.showModal();
      return;
    }
    void sendCurrentMessage(button.dataset.prompt);
  });
});
document.querySelectorAll(".inspector-tab").forEach((tab) => {
  tab.addEventListener("click", () => activateInspectorTab(tab.dataset.tab));
});
ui.toggleInspectorButton.addEventListener("click", () => {
  activateInspectorTab("resources");
  setInspectorOpen(true);
});
ui.closeInspectorButton.addEventListener("click", () => setInspectorOpen(false));
ui.artifactPreviewCloseButton.addEventListener("click", closeArtifactPreview);
ui.artifactOpenButton.addEventListener("click", () => void openProjectFile());
ui.artifactPreviewDialog.addEventListener("close", () => {
  state.previewFile = null;
  revokePreviewObjectUrl();
  ui.artifactPreviewBody.replaceChildren();
});
ui.uploadButton.addEventListener("click", () => void uploadResources("files"));
ui.folderUploadButton.addEventListener("click", () => void uploadResources("folder"));
ui.quickUploadButton.addEventListener("click", () => void uploadResources("files"));
ui.quickFolderUploadButton.addEventListener("click", () => void uploadResources("folder"));
ui.resourceSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void searchResources(ui.resourceSearchInput.value);
});
ui.resourceSearchInput.addEventListener("search", () => {
  if (!ui.resourceSearchInput.value) renderResources();
});
desktop.onMaterialImportProgress?.((progress) => setImportProgress(progress));
ui.permissionScopeButton.addEventListener("click", () => {
  setPermissionMenuOpen(ui.permissionScopeMenu.hidden);
});
for (const item of ui.permissionScopeItems) {
  item.addEventListener("click", () => {
    state.permissionScope = normalizePermissionScope(item.dataset.permissionScope);
    localStorage.setItem("physics-teacher-permission-scope", state.permissionScope);
    renderPermissionScope();
    setPermissionMenuOpen(false);
  });
}
document.addEventListener("click", (event) => {
  if (!event.target.closest(".permission-menu-wrap")) setPermissionMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui.permissionScopeMenu.hidden) {
    event.preventDefault();
    setPermissionMenuOpen(false);
  }
});

void initialize();
