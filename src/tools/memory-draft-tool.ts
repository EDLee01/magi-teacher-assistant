import { proposeMemoryDraft } from "../memory-draft.js";

export type MemoryDraftCategory = "project" | "preference" | "decision" | "session";

export interface MemoryDraftToolRequest {
  category: MemoryDraftCategory;
  content: string;
  supersedes?: string;
  reason: string;
  confidence?: number;
}

export const MemoryDraftToolInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    category: {
      type: "string",
      enum: ["project", "preference", "decision", "session"],
      description:
        "Where the reviewed memory should live. Use project for stable class/course facts, session for findings tied to this Session."
    },
    content: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description:
        "A concise memory candidate that separates observed evidence from interpretation and contains no secrets or unnecessary personal data."
    },
    supersedes: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description:
        "For a revision, quote the prior confirmed conclusion that this candidate should replace as the current teaching judgment. Omit for a new memory."
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Why this evidence is stable enough to ask the teacher to review it."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Optional confidence from 0 to 1."
    }
  },
  required: ["category", "content", "reason"]
} satisfies Record<string, unknown>;

export function parseMemoryDraftToolInput(input: Record<string, unknown>): MemoryDraftToolRequest {
  const allowed = new Set(["category", "content", "supersedes", "reason", "confidence"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`MemoryDraft input does not allow ${key}`);
  }
  return {
    category: readCategory(input.category),
    content: readRequiredText(input.content, "content", 4000),
    supersedes: readOptionalText(input.supersedes, "supersedes", 1000),
    reason: readRequiredText(input.reason, "reason", 500),
    confidence: readConfidence(input.confidence)
  };
}

export function executeMemoryDraftTool(input: {
  request: MemoryDraftToolRequest;
  appRoot: string;
  memoryRoot?: string;
  sourceSession?: string;
}): string {
  const draft = proposeMemoryDraft({
    appRoot: input.appRoot,
    root: input.memoryRoot,
    targetFile: targetFile(input.request.category, input.sourceSession),
    content: input.request.content,
    supersedes: input.request.supersedes,
    reason: input.request.reason,
    sourceSession: input.sourceSession,
    confidence: input.request.confidence
  });
  return [
    `Created ${draft.supersedes ? "Memory Revision Draft" : "Memory Draft"}: ${draft.id} -> ${draft.targetFile}.`,
    "Formal project memory is unchanged. The teacher must confirm or reject this draft in the project memory panel."
  ].join(" ");
}

function targetFile(category: MemoryDraftCategory, sourceSession?: string): string {
  if (category === "project") return "projects/context.md";
  if (category === "preference") return "preferences.md";
  if (category === "decision") return "decisions/teaching.md";
  const sessionId = sourceSession?.trim();
  if (!sessionId) throw new Error("MemoryDraft session category requires a Session");
  return `sessions/${sessionId}.md`;
}

function readCategory(value: unknown): MemoryDraftCategory {
  if (
    value === "project" ||
    value === "preference" ||
    value === "decision" ||
    value === "session"
  ) {
    return value;
  }
  throw new Error("MemoryDraft category must be project, preference, decision, or session");
}

function readRequiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MemoryDraft ${label} must not be empty`);
  }
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`MemoryDraft ${label} is too long`);
  return text;
}

function readOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredText(value, label, maxLength);
}

function readConfidence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("MemoryDraft confidence must be between 0 and 1");
  }
  return value;
}
