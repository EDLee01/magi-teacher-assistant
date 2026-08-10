const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-followup-personalized-recheck.mjs"))
  .catch((error) => {
    process.stderr.write(`[个性化学习离线复核] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
