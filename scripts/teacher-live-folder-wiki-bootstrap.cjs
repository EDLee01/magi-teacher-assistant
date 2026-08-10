const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-folder-wiki-eval.mjs"))
  .catch((error) => {
    process.stderr.write(`[文件夹知识库业务测试] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
