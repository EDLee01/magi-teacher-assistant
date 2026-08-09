import { buildToolPermissionRules } from "../tool-policy.js";
import { ToolPermissionRules } from "../tools/registry.js";

/** Tools present on the first model turn when MAGI_TOOL_LOAD=minimal. */
export const PHYSICS_TEACHER_ALWAYS_TOOLS = [
  "ToolSearch",
  "WebSearch",
  "WebFetch",
  "FileRead",
  "Skill",
  "Brief",
  "AskUserQuestion"
] as const;

/** General Magi tools that a teacher session may reveal through ToolSearch. */
export const PHYSICS_TEACHER_ON_DEMAND_TOOLS = [
  "WebBrowser",
  "Glob",
  "Grep",
  "FileWrite",
  "FileEdit",
  "FilePatch",
  "NotebookRead",
  "NotebookEdit",
  "Bash",
  "GitSummary",
  "GitStatus",
  "GitDiff",
  "GitLog",
  "GitShow",
  "GitBranchList",
  "GitStage",
  "SessionSearch",
  "SendUserMessage"
] as const;

export const PHYSICS_TEACHER_BLOCKED_TOOLS = [
  "FileDelete",
  "GitBranchCreate",
  "GitBranchDelete",
  "GitCheckout",
  "GitReset",
  "GitStash",
  "KillProcess",
  "CronCreate",
  "CronDelete",
  "SshExec",
  "SshFileRead",
  "SshFileWrite",
  "WorktreeCreate",
  "WorktreeRemove",
  "GitHubIssueCreate",
  "GitHubPRCreate",
  "Config",
  "SkillManage"
] as const;

export type PhysicsTeacherPermissionScope = "read-only" | "project-write" | "approval";

const SAFE_PYTHON_COMMANDS = [
  "Bash(python3 workspace/analysis-scripts/*)",
  "Bash(python workspace/analysis-scripts/*)"
] as const;

const SCOPED_ON_DEMAND_TOOLS = new Set([
  "FileWrite",
  "FileEdit",
  "FilePatch",
  "NotebookEdit",
  "Bash",
  "GitStage"
]);

const SAFE_READ_ONLY_SHELL_COMMANDS = [
  "Bash(pwd:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(sed:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)"
] as const;

const BLOCKED_SHELL_PATTERNS = [
  "Bash(*&&*)",
  "Bash(*;*)",
  "Bash(*|*)",
  "Bash(*&*)",
  "Bash(*>*)",
  "Bash(*<*)",
  "Bash(*..*)",
  "Bash(* /*)",
  "Bash(*=/*)",
  "Bash(rm:*)",
  "Bash(trash:*)",
  "Bash(unlink:*)",
  "Bash(rmdir:*)",
  "Bash(sudo:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(git push:*)",
  "Bash(git reset:*)",
  "Bash(git clean:*)",
  "Bash(git checkout:*)",
  "Bash(pip:*)",
  "Bash(pip3:*)"
] as const;

export function buildPhysicsTeacherToolRules(
  scope: PhysicsTeacherPermissionScope = "project-write"
): ToolPermissionRules {
  const sharedAllowedTools = [
    ...PHYSICS_TEACHER_ALWAYS_TOOLS,
    ...PHYSICS_TEACHER_ON_DEMAND_TOOLS.filter((name) => !SCOPED_ON_DEMAND_TOOLS.has(name)),
    ...SAFE_READ_ONLY_SHELL_COMMANDS
  ];
  const projectWriteTools = [
    "FileWrite(workspace/*)",
    "FileWrite(artifacts/*)",
    "FileWrite(*workspace/*)",
    "FileWrite(*artifacts/*)",
    "FileEdit(workspace/*)",
    "FileEdit(artifacts/*)",
    "FileEdit(*workspace/*)",
    "FileEdit(*artifacts/*)",
    "FilePatch(workspace/*)",
    "FilePatch(artifacts/*)",
    "FilePatch(*workspace/*)",
    "FilePatch(*artifacts/*)",
    "NotebookEdit(workspace/*)",
    "NotebookEdit(artifacts/*)",
    "NotebookEdit(*workspace/*)",
    "NotebookEdit(*artifacts/*)",
    "GitStage(*)",
    ...SAFE_PYTHON_COMMANDS
  ];
  return buildToolPermissionRules({
    allowedTools: [...sharedAllowedTools, ...(scope === "project-write" ? projectWriteTools : [])],
    askTools:
      scope === "approval"
        ? ["FileWrite", "FileEdit", "FilePatch", "NotebookEdit", "Bash", "GitStage"]
        : [],
    disallowedTools: [...PHYSICS_TEACHER_BLOCKED_TOOLS, ...BLOCKED_SHELL_PATTERNS]
  })!;
}

export function buildPhysicsTeacherRuntimeEnv(
  env: NodeJS.ProcessEnv,
  projectRoot: string
): NodeJS.ProcessEnv {
  const requestedTimeout = Number(env.MAGI_TEACHER_BASH_TIMEOUT_MS);
  const timeoutMs =
    Number.isSafeInteger(requestedTimeout) && requestedTimeout >= 1_000
      ? Math.min(requestedTimeout, 300_000)
      : 60_000;
  return {
    ...env,
    MAGI_TOOL_LOAD: "minimal",
    MAGI_TEACHER_PROJECT_ROOT: projectRoot,
    MAGI_BASH_TIMEOUT_MS: String(timeoutMs)
  };
}
