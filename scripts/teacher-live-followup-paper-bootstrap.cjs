const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-followup-paper-eval.mjs"))
  .catch((error) => {
    process.stderr.write(`[追问组卷业务测试] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
