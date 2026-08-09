#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createPhysicsTeacherRuntime } from "./runtime.js";
import { startPhysicsTeacherHttpServer } from "./server.js";

export async function runPhysicsTeacherBackend(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const runtime = createPhysicsTeacherRuntime(env);

  try {
    const { server, bind, port } = await startPhysicsTeacherHttpServer(runtime.service, { env });
    process.stdout.write(`Magi 教师助手后端已启动：http://${bind}:${port}\n`);
    await new Promise<void>((resolve) => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        server.close(() => resolve());
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  } finally {
    runtime.close();
  }
}

const entryFile = process.argv[1];
if (entryFile && import.meta.url === pathToFileURL(entryFile).href) {
  runPhysicsTeacherBackend().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Magi 教师助手启动失败：${message}\n`);
    process.exitCode = 1;
  });
}
