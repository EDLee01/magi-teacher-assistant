import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PhysicsTeacherProjectPaths } from "./paths.js";

export const PHYSICS_TEACHER_DOCUMENT_RENDERER_RELATIVE_PATH =
  "workspace/analysis-scripts/render_teacher_document.py";

const RENDERER_MARKER = "MAGI_TEACHER_DOCUMENT_RENDERER_V1";

export function ensurePhysicsTeacherDocumentRenderer(
  projectPaths: PhysicsTeacherProjectPaths
): string {
  const file = path.join(projectPaths.analysisScripts, "render_teacher_document.py");
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (current === PHYSICS_TEACHER_DOCUMENT_RENDERER) return file;
    if (!current.includes(RENDERER_MARKER)) return file;
  }
  writeFileSync(file, PHYSICS_TEACHER_DOCUMENT_RENDERER, { encoding: "utf8", mode: 0o700 });
  try {
    chmodSync(file, 0o700);
  } catch {
    // Best effort for mounted or shared project directories.
  }
  return file;
}

export const PHYSICS_TEACHER_DOCUMENT_RENDERER = String.raw`#!/usr/bin/env python3
# MAGI_TEACHER_DOCUMENT_RENDERER_V1
import argparse
import html
import json
import os
import re
import subprocess
import textwrap
import zipfile
from pathlib import Path


def require_artifact_path(value, suffix=None):
    root = (Path.cwd() / "artifacts").resolve()
    candidate = Path(value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise SystemExit("input and output files must stay inside artifacts/") from error
    if suffix and candidate.suffix.lower() != suffix:
        raise SystemExit("unexpected output extension: " + str(candidate))
    return candidate


def plain_text(line):
    value = re.sub(r"^\s{0,3}#{1,6}\s*", "", line)
    value = re.sub(r"\*\*(.*?)\*\*", r"\1", value)
    tick = chr(96)
    value = re.sub(tick + r"([^" + tick + r"]*)" + tick, r"\1", value)
    return value.replace("|", "  ").strip()


def word_paragraph(line):
    raw = line.rstrip()
    style = "Normal"
    if raw.startswith("# "):
        style = "Title"
    elif raw.startswith("## "):
        style = "Heading1"
    elif raw.startswith("### "):
        style = "Heading2"
    text = html.escape(plain_text(raw))
    if not text:
        return "<w:p/>"
    style_xml = "" if style == "Normal" else '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>'
    return '<w:p>' + style_xml + '<w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>'


def write_docx(markdown, output):
    body = "".join(word_paragraph(line) for line in markdown.splitlines())
    document = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>''' + body + '''
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
  </w:body>
</w:document>'''
    styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="PingFang SC"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="100" w:line="320" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
</w:styles>'''
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''
    relationships = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''
    document_relationships = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", relationships)
        archive.writestr("word/document.xml", document)
        archive.writestr("word/styles.xml", styles)
        archive.writestr("word/_rels/document.xml.rels", document_relationships)


def pdf_lines(markdown):
    result = []
    for raw in markdown.splitlines():
        text = plain_text(raw)
        if not text:
            result.append("")
            continue
        result.extend(textwrap.wrap(text, width=45, break_long_words=True, break_on_hyphens=False) or [""])
    return result


def write_pdf(markdown, output):
    lines = pdf_lines(markdown)
    output.parent.mkdir(parents=True, exist_ok=True)
    cupsfilter = Path("/usr/sbin/cupsfilter")
    if cupsfilter.exists():
        temporary_text = output.with_suffix(output.suffix + ".txt")
        try:
            temporary_text.write_text("\n".join(lines), encoding="utf-8")
            environment = dict(os.environ)
            environment.update({"LANG": "zh_CN.UTF-8", "CHARSET": "utf-8"})
            result = subprocess.run(
                [str(cupsfilter), "-m", "application/pdf", "-o", "media=A4", str(temporary_text)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=environment,
                timeout=60,
                check=False,
            )
            if result.returncode != 0 or not result.stdout.startswith(b"%PDF-"):
                raise SystemExit("macOS PDF renderer failed: " + result.stderr.decode("utf-8", "replace")[-600:])
            output.write_bytes(result.stdout)
            return
        finally:
            temporary_text.unlink(missing_ok=True)
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfgen import canvas
    except ImportError as error:
        raise SystemExit("PDF rendering requires macOS cupsfilter or reportlab") from error
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    page = canvas.Canvas(str(output), pagesize=(595, 842))
    page.setFont("STSong-Light", 10)
    y = 805
    for line in lines:
        if y < 45:
            page.showPage()
            page.setFont("STSong-Light", 10)
            y = 805
        page.drawString(48, y, line)
        y -= 16
    page.save()


def main():
    parser = argparse.ArgumentParser(description="Render a teacher Markdown draft to editable DOCX and previewable PDF")
    parser.add_argument("--input", required=True)
    parser.add_argument("--docx", required=True)
    parser.add_argument("--pdf", required=True)
    args = parser.parse_args()
    source = require_artifact_path(args.input, ".md")
    docx = require_artifact_path(args.docx, ".docx")
    pdf = require_artifact_path(args.pdf, ".pdf")
    markdown = source.read_text(encoding="utf-8")
    if len(markdown.strip()) < 20:
        raise SystemExit("document draft is empty")
    write_docx(markdown, docx)
    write_pdf(markdown, pdf)
    print(json.dumps({"docx": str(docx), "pdf": str(pdf)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
`;
