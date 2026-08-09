import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { loadConfig } from "../config.js";
import { MagiPaths } from "../paths.js";

export const PHYSICS_TEACHER_OPENAI_PROVIDER = "physics-teacher-openai";
export const PHYSICS_TEACHER_OPENAI_KEY_ENV = "MAGI_TEACHER_OPENAI_API_KEY";
export const PHYSICS_TEACHER_MODEL_ALIAS = "physics-teacher";

export interface PhysicsTeacherModelSettings {
  baseUrl: string;
  model: string;
}

export function readPhysicsTeacherModelSettings(
  paths: MagiPaths,
  env: NodeJS.ProcessEnv = process.env
): PhysicsTeacherModelSettings | undefined {
  const config = loadConfig(paths, env);
  const provider = config.providers[PHYSICS_TEACHER_OPENAI_PROVIDER];
  const alias = config.models.aliases[PHYSICS_TEACHER_MODEL_ALIAS];
  if (!provider || provider.type !== "openai" || !provider.baseUrl || !alias) return undefined;
  const prefix = `${PHYSICS_TEACHER_OPENAI_PROVIDER}:`;
  const model = alias.startsWith(prefix) ? alias.slice(prefix.length) : provider.defaultModel;
  if (!model) return undefined;
  return { baseUrl: provider.baseUrl, model };
}

export function writePhysicsTeacherModelSettings(input: {
  paths: MagiPaths;
  baseUrl: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}): PhysicsTeacherModelSettings {
  const settings = normalizePhysicsTeacherModelSettings(input);
  const raw = YAML.parse(readFileSync(input.paths.configFile, "utf8"));
  const document = isRecord(raw) ? raw : {};
  const providers = ensureRecord(document, "providers");
  providers[PHYSICS_TEACHER_OPENAI_PROVIDER] = {
    type: "openai",
    apiKeyEnv: PHYSICS_TEACHER_OPENAI_KEY_ENV,
    baseUrl: settings.baseUrl,
    defaultModel: settings.model,
    endpoint: "chat"
  };
  const models = ensureRecord(document, "models");
  const aliases = ensureRecord(models, "aliases");
  aliases[PHYSICS_TEACHER_MODEL_ALIAS] = `${PHYSICS_TEACHER_OPENAI_PROVIDER}:${settings.model}`;
  if (!isRecord(models.fallbacks)) models.fallbacks = {};

  const text = YAML.stringify(document);
  const validationFile = `${input.paths.configFile}.validate-${process.pid}-${Date.now()}`;
  writeFileSync(validationFile, text, { encoding: "utf8", mode: 0o600 });
  try {
    loadConfig({ ...input.paths, configFile: validationFile }, input.env);
  } finally {
    rmSync(validationFile, { force: true });
  }
  writeAtomic(input.paths.configFile, text);
  return settings;
}

export function normalizePhysicsTeacherModelSettings(input: {
  baseUrl: string;
  model: string;
}): PhysicsTeacherModelSettings {
  const rawBaseUrl = requireText(input.baseUrl, "接口地址");
  const model = requireText(input.model, "模型名称");
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("接口地址必须是完整 URL，例如 https://api.openai.com/v1");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("接口地址不能包含账号、密码、查询参数或锚点");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("远程接口必须使用 HTTPS；本机 localhost 接口可以使用 HTTP");
  }
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    model
  };
}

function ensureRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(root[key])) root[key] = {};
  return root[key] as Record<string, unknown>;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  const normalized = value.trim();
  if (normalized.length > 500) throw new Error(`${label}过长`);
  return normalized;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryFile, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryFile, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on shared or mounted filesystems.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
