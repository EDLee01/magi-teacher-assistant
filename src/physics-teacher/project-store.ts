import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { openSqliteDatabase, SqliteDatabase } from "../sqlite-database.js";
import {
  CreatePhysicsTeacherProjectInput,
  PhysicsTeacherProject,
  PhysicsTeacherProjectSession,
  PhysicsTeacherSessionKind,
  TeachingResource,
  TeachingResourceSource,
  TeachingResourceSourceKind
} from "./types.js";

export class PhysicsTeacherProjectStore {
  private readonly db: SqliteDatabase;

  constructor(databaseFile: string) {
    mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    this.db = openSqliteDatabase(databaseFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${databaseFile}${suffix}`;
      if (!existsSync(file)) continue;
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort for mounted or shared development filesystems.
      }
    }
  }

  static memory(): PhysicsTeacherProjectStore {
    return new PhysicsTeacherProjectStore(":memory:");
  }

  close(): void {
    this.db.close();
  }

  createProject(
    input: CreatePhysicsTeacherProjectInput & { id?: string; rootDir: string }
  ): PhysicsTeacherProject {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into physics_projects
          (id, name, subject, grade, class_name, textbook_version, teacher_name, root_dir, created_at, updated_at)
         values (?, ?, 'physics', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        requireText(input.name, "name"),
        requireText(input.grade, "grade"),
        requireText(input.className, "className"),
        optionalText(input.textbookVersion),
        optionalText(input.teacherName),
        path.resolve(input.rootDir),
        now,
        now
      );
    return this.getProject(id)!;
  }

  getProject(projectId: string): PhysicsTeacherProject | undefined {
    const row = this.db.prepare("select * from physics_projects where id = ?").get(projectId) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(): PhysicsTeacherProject[] {
    const rows = this.db
      .prepare("select * from physics_projects order by updated_at desc, created_at desc")
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  touchProject(projectId: string): void {
    this.db
      .prepare("update physics_projects set updated_at = ? where id = ?")
      .run(new Date().toISOString(), projectId);
  }

  addSession(input: {
    projectId: string;
    sessionId: string;
    title: string;
    kind: PhysicsTeacherSessionKind;
  }): PhysicsTeacherProjectSession {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into physics_project_sessions
          (project_id, session_id, title, kind, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.projectId,
        input.sessionId,
        requireText(input.title, "title"),
        input.kind,
        now,
        now
      );
    this.touchProject(input.projectId);
    return this.getSession(input.sessionId)!;
  }

  getSession(sessionId: string): PhysicsTeacherProjectSession | undefined {
    const row = this.db
      .prepare("select * from physics_project_sessions where session_id = ?")
      .get(sessionId) as ProjectSessionRow | undefined;
    return row ? toProjectSession(row) : undefined;
  }

  listSessions(projectId: string): PhysicsTeacherProjectSession[] {
    const rows = this.db
      .prepare(
        "select * from physics_project_sessions where project_id = ? order by updated_at desc, created_at desc"
      )
      .all(projectId) as ProjectSessionRow[];
    return rows.map(toProjectSession);
  }

  addResourceSource(input: {
    projectId: string;
    name: string;
    kind: TeachingResourceSourceKind;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }): TeachingResourceSource {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into physics_resource_sources
          (id, project_id, name, kind, enabled, config_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        requireText(input.name, "name"),
        input.kind,
        input.enabled === false ? 0 : 1,
        encodeJson(input.config),
        now,
        now
      );
    return this.getResourceSource(id)!;
  }

  getResourceSource(sourceId: string): TeachingResourceSource | undefined {
    const row = this.db
      .prepare("select * from physics_resource_sources where id = ?")
      .get(sourceId) as ResourceSourceRow | undefined;
    return row ? toResourceSource(row) : undefined;
  }

  listResourceSources(projectId: string): TeachingResourceSource[] {
    const rows = this.db
      .prepare(
        "select * from physics_resource_sources where project_id = ? order by created_at asc"
      )
      .all(projectId) as ResourceSourceRow[];
    return rows.map(toResourceSource);
  }

  addResource(
    input: Omit<TeachingResource, "id" | "createdAt"> & { id?: string }
  ): TeachingResource {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into physics_resources
          (id, project_id, source_id, external_id, title, kind, mime_type, original_filename,
           storage_path, size_bytes, checksum_sha256, excerpt, metadata_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.sourceId,
        optionalText(input.externalId),
        requireText(input.title, "title"),
        requireText(input.kind, "kind"),
        optionalText(input.mimeType),
        optionalText(input.originalFilename),
        optionalText(input.storagePath),
        input.sizeBytes ?? null,
        optionalText(input.checksumSha256),
        optionalText(input.excerpt),
        encodeJson(input.metadata),
        now
      );
    this.touchProject(input.projectId);
    return this.getResource(id)!;
  }

  getResource(resourceId: string): TeachingResource | undefined {
    const row = this.db.prepare("select * from physics_resources where id = ?").get(resourceId) as
      | ResourceRow
      | undefined;
    return row ? toResource(row) : undefined;
  }

  findResourceByChecksum(projectId: string, checksumSha256: string): TeachingResource | undefined {
    const row = this.db
      .prepare(
        "select * from physics_resources where project_id = ? and checksum_sha256 = ? order by created_at asc limit 1"
      )
      .get(projectId, checksumSha256) as ResourceRow | undefined;
    return row ? toResource(row) : undefined;
  }

  listResources(projectId: string): TeachingResource[] {
    const rows = this.db
      .prepare("select * from physics_resources where project_id = ? order by created_at desc")
      .all(projectId) as ResourceRow[];
    return rows.map(toResource);
  }

  searchLocalResources(projectId: string, query: string, limit = 20): TeachingResource[] {
    const pattern = `%${escapeLike(query.trim())}%`;
    const rows = this.db
      .prepare(
        `select * from physics_resources
         where project_id = ? and (title like ? escape '\\' or excerpt like ? escape '\\')
         order by created_at desc limit ?`
      )
      .all(projectId, pattern, pattern, limit) as ResourceRow[];
    return rows.map(toResource);
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists physics_projects (
        id text primary key,
        name text not null,
        subject text not null,
        grade text not null,
        class_name text not null,
        textbook_version text,
        teacher_name text,
        root_dir text not null unique,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists physics_project_sessions (
        project_id text not null references physics_projects(id) on delete cascade,
        session_id text primary key,
        title text not null,
        kind text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_physics_sessions_project
        on physics_project_sessions(project_id, updated_at desc);

      create table if not exists physics_resource_sources (
        id text primary key,
        project_id text not null references physics_projects(id) on delete cascade,
        name text not null,
        kind text not null,
        enabled integer not null default 1,
        config_json text not null,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_physics_sources_project
        on physics_resource_sources(project_id, created_at asc);

      create table if not exists physics_resources (
        id text primary key,
        project_id text not null references physics_projects(id) on delete cascade,
        source_id text not null references physics_resource_sources(id) on delete cascade,
        external_id text,
        title text not null,
        kind text not null,
        mime_type text,
        original_filename text,
        storage_path text,
        size_bytes integer,
        checksum_sha256 text,
        excerpt text,
        metadata_json text not null,
        created_at text not null
      );
      create index if not exists idx_physics_resources_project
        on physics_resources(project_id, created_at desc);
    `);
  }
}

interface ProjectRow {
  id: string;
  name: string;
  subject: "physics";
  grade: string;
  class_name: string;
  textbook_version: string | null;
  teacher_name: string | null;
  root_dir: string;
  created_at: string;
  updated_at: string;
}

interface ProjectSessionRow {
  project_id: string;
  session_id: string;
  title: string;
  kind: PhysicsTeacherSessionKind;
  created_at: string;
  updated_at: string;
}

interface ResourceSourceRow {
  id: string;
  project_id: string;
  name: string;
  kind: TeachingResourceSourceKind;
  enabled: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  id: string;
  project_id: string;
  source_id: string;
  external_id: string | null;
  title: string;
  kind: string;
  mime_type: string | null;
  original_filename: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  excerpt: string | null;
  metadata_json: string;
  created_at: string;
}

function toProject(row: ProjectRow): PhysicsTeacherProject {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    grade: row.grade,
    className: row.class_name,
    textbookVersion: row.textbook_version ?? undefined,
    teacherName: row.teacher_name ?? undefined,
    rootDir: row.root_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toProjectSession(row: ProjectSessionRow): PhysicsTeacherProjectSession {
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toResourceSource(row: ResourceSourceRow): TeachingResourceSource {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled === 1,
    config: decodeJson(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toResource(row: ResourceRow): TeachingResource {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    externalId: row.external_id ?? undefined,
    title: row.title,
    kind: row.kind,
    mimeType: row.mime_type ?? undefined,
    originalFilename: row.original_filename ?? undefined,
    storagePath: row.storage_path ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    checksumSha256: row.checksum_sha256 ?? undefined,
    excerpt: row.excerpt ?? undefined,
    metadata: decodeJson(row.metadata_json),
    createdAt: row.created_at
  };
}

function requireText(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} must not be empty`);
  if (result.length > 300) throw new Error(`${field} is too long`);
  return result;
}

function optionalText(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function encodeJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
