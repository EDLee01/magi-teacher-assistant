const { app } = require("electron");

app
  .whenReady()
  .then(() => import("./teacher-live-followup-homework-eval.mjs"))
  .catch((error) => {
    process.stderr.write(`[追问作业辅导业务测试] 启动失败：${error.stack || error.message}\n`);
    app.exit(1);
  });
