import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import { MagiPaths } from "../paths.js";

export interface PhysicsTeacherPaths {
  root: string;
  stateRoot: string;
  databaseFile: string;
  projectsRoot: string;
}

export interface PhysicsTeacherProjectPaths {
  root: string;
  workspace: string;
  analysisScripts: string;
  templates: string;
  mappings: string;
  wiki: string;
  uploads: string;
  artifacts: string;
  memory: string;
}

export function getPhysicsTeacherPaths(
  magiPaths: MagiPaths,
  env: NodeJS.ProcessEnv = process.env
): PhysicsTeacherPaths {
  const root = env.MAGI_TEACHER_CONFIG_DIR?.trim()
    ? path.resolve(env.MAGI_TEACHER_CONFIG_DIR)
    : path.join(magiPaths.root, "physics-teacher");
  const stateRoot = path.join(root, "state");
  return {
    root,
    stateRoot,
    databaseFile: path.join(stateRoot, "physics-teacher.sqlite"),
    projectsRoot: path.join(root, "projects")
  };
}

export function ensurePhysicsTeacherPaths(paths: PhysicsTeacherPaths): void {
  for (const directory of [paths.root, paths.stateRoot, paths.projectsRoot]) {
    mkdirPrivate(directory);
  }
}

export function getPhysicsTeacherProjectPaths(
  paths: PhysicsTeacherPaths,
  projectId: string
): PhysicsTeacherProjectPaths {
  const safeId = requireSafeProjectId(projectId);
  const root = path.join(paths.projectsRoot, safeId);
  const workspace = path.join(root, "workspace");
  return {
    root,
    workspace,
    analysisScripts: path.join(workspace, "analysis-scripts"),
    templates: path.join(workspace, "templates"),
    mappings: path.join(workspace, "mappings"),
    wiki: path.join(workspace, "wiki"),
    uploads: path.join(root, "uploads"),
    artifacts: path.join(root, "artifacts"),
    memory: path.join(root, "memory")
  };
}

export function ensurePhysicsTeacherProjectPaths(paths: PhysicsTeacherProjectPaths): void {
  for (const directory of [
    paths.root,
    paths.workspace,
    paths.analysisScripts,
    paths.templates,
    paths.mappings,
    paths.wiki,
    paths.uploads,
    paths.artifacts,
    paths.memory
  ]) {
    mkdirPrivate(directory);
  }
}

function requireSafeProjectId(projectId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(projectId)) {
    throw new Error("Invalid physics teacher project id");
  }
  return projectId;
}

function mkdirPrivate(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best effort for mounted or shared development filesystems.
  }
}
