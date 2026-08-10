const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-cross-session-memory-eval.mjs"))
  .catch((error) => {
    process.stderr.write(`[跨Session记忆业务测试] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
