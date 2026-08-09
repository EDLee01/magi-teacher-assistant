import { loadConfig } from "../config.js";
import { ensureMagiHome, getMagiPaths, MagiPaths } from "../paths.js";
import { SessionStore } from "../session-store.js";
import { ensurePhysicsTeacherPaths, getPhysicsTeacherPaths, PhysicsTeacherPaths } from "./paths.js";
import { PhysicsTeacherProjectStore } from "./project-store.js";
import { PhysicsTeacherService } from "./service.js";
import { installPhysicsTeacherSkills } from "./skills.js";

export interface PhysicsTeacherRuntime {
  magiPaths: MagiPaths;
  paths: PhysicsTeacherPaths;
  service: PhysicsTeacherService;
  close(): void;
}

export function createPhysicsTeacherRuntime(
  env: NodeJS.ProcessEnv = process.env
): PhysicsTeacherRuntime {
  const magiPaths = getMagiPaths(env);
  ensureMagiHome(magiPaths);
  installPhysicsTeacherSkills(magiPaths);
  const paths = getPhysicsTeacherPaths(magiPaths, env);
  ensurePhysicsTeacherPaths(paths);
  const projectStore = new PhysicsTeacherProjectStore(paths.databaseFile);
  const sessionStore = SessionStore.open(magiPaths);
  const service = new PhysicsTeacherService({
    magiPaths,
    paths,
    config: loadConfig(magiPaths, env),
    projectStore,
    sessionStore,
    env
  });
  let closed = false;
  return {
    magiPaths,
    paths,
    service,
    close() {
      if (closed) return;
      closed = true;
      sessionStore.close();
      projectStore.close();
    }
  };
}
