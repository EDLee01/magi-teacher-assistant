const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-followup-homework-recheck.mjs"))
  .catch((error) => {
    process.stderr.write(`[追问作业离线复核] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
