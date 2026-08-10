const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-followup-personalized-eval.mjs"))
  .catch((error) => {
    process.stderr.write(`[个性化学习业务测试] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
