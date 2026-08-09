export type PhysicsTeacherSessionKind =
  | "exam-analysis"
  | "lesson-planning"
  | "practice-adjustment"
  | "retest-review"
  | "general";

export interface PhysicsTeacherProject {
  id: string;
  name: string;
  subject: "physics";
  grade: string;
  className: string;
  textbookVersion?: string;
  teacherName?: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePhysicsTeacherProjectInput {
  name: string;
  grade: string;
  className: string;
  textbookVersion?: string;
  teacherName?: string;
}

export interface PhysicsTeacherProjectSession {
  projectId: string;
  sessionId: string;
  title: string;
  kind: PhysicsTeacherSessionKind;
  createdAt: string;
  updatedAt: string;
}

export type TeachingResourceSourceKind = "upload" | "remote-api";

export interface TeachingResourceSource {
  id: string;
  projectId: string;
  name: string;
  kind: TeachingResourceSourceKind;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TeachingResource {
  id: string;
  projectId: string;
  sourceId: string;
  externalId?: string;
  title: string;
  kind: string;
  mimeType?: string;
  originalFilename?: string;
  storagePath?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  excerpt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TeachingResourceSearchItem {
  id: string;
  title: string;
  kind: string;
  snippet?: string;
  source: string;
  sourceId: string;
  metadata: Record<string, unknown>;
}

export interface TeachingResourceSearchResult {
  query: string;
  items: TeachingResourceSearchItem[];
  warnings?: string[];
}
