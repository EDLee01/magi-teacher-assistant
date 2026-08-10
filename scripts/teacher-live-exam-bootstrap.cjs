const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-exam-eval.mjs"))
  .catch((error) => {
    process.stderr.write(`[考试分析业务测试] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
