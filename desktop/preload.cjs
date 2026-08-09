const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("physicsTeacherDesktop", {
  request: (request) => ipcRenderer.invoke("physics-teacher:request", request),
  importProjectMaterials: (input) =>
    ipcRenderer.invoke("physics-teacher:import-project-materials", input),
  onMaterialImportProgress: (callback) =>
    ipcRenderer.on("physics-teacher:material-import-progress", (_event, progress) =>
      callback(progress)
    ),
  chooseMessageFiles: () => ipcRenderer.invoke("physics-teacher:choose-message-files"),
  sendMessage: (input) => ipcRenderer.invoke("physics-teacher:send-message", input),
  sendMessageWithAttachments: (input) =>
    ipcRenderer.invoke("physics-teacher:send-message-with-attachments", input),
  getModelSettings: () => ipcRenderer.invoke("physics-teacher:get-model-settings"),
  saveModelSettings: (settings) =>
    ipcRenderer.invoke("physics-teacher:save-model-settings", settings),
  openExternal: (url) => ipcRenderer.invoke("physics-teacher:open-external", url),
  listArtifacts: (projectId) => ipcRenderer.invoke("physics-teacher:list-artifacts", projectId),
  previewProjectFile: (input) => ipcRenderer.invoke("physics-teacher:preview-project-file", input),
  openProjectFile: (input) => ipcRenderer.invoke("physics-teacher:open-project-file", input)
});
