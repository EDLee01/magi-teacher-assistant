import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensurePhysicsTeacherDocumentRenderer } from "../src/physics-teacher/document-renderer.js";
import { getPhysicsTeacherProjectPaths } from "../src/physics-teacher/paths.js";

describe("teacher document renderer", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("renders a UTF-8 Markdown draft into valid DOCX and PDF files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "magi-teacher-renderer-"));
    roots.push(root);
    const paths = getPhysicsTeacherProjectPaths(
      { root, stateRoot: path.join(root, "state"), databaseFile: "", projectsRoot: root },
      "project-renderer-test"
    );
    mkdirSync(paths.analysisScripts, { recursive: true });
    mkdirSync(paths.artifacts, { recursive: true });
    const renderer = ensurePhysicsTeacherDocumentRenderer(paths);
    const source = path.join(paths.artifacts, "专项训练.md");
    const docx = path.join(paths.artifacts, "专项训练.docx");
    const pdf = path.join(paths.artifacts, "专项训练.pdf");
    writeFileSync(
      source,
      "# 摩擦力与浮力专项训练\n\n## 一、选择题\n\n1. 下列说法正确的是（　　）\n\n## 参考答案\n\n1. A\n",
      "utf8"
    );

    execFileSync("python3", [renderer, "--input", source, "--docx", docx, "--pdf", pdf], {
      cwd: paths.root
    });

    expect(readFileSync(docx).subarray(0, 2).toString("ascii")).toBe("PK");
    expect(readFileSync(pdf).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const pdftotext = [
      "/opt/homebrew/bin/pdftotext",
      "/usr/local/bin/pdftotext",
      "/usr/bin/pdftotext"
    ].find(existsSync);
    if (pdftotext) {
      const extractedPdf = execFileSync(pdftotext, [pdf, "-"], { encoding: "utf8" });
      expect(extractedPdf).toContain("摩擦");
      expect(extractedPdf).toContain("浮");
    }
    if (process.platform === "darwin") {
      const extracted = execFileSync("/usr/bin/textutil", ["-convert", "txt", "-stdout", docx], {
        encoding: "utf8"
      });
      expect(extracted).toContain("摩擦力与浮力专项训练");
      expect(extracted).toContain("参考答案");
    }
  });
});
