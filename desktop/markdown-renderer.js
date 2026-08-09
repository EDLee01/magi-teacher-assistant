const inlinePatterns = [
  { type: "code", expression: /`([^`\n]+)`/g },
  { type: "link", expression: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g },
  { type: "strong-star", expression: /\*\*([^\n]+?)\*\*/g },
  { type: "strong-underscore", expression: /__([^\n]+?)__/g },
  { type: "delete", expression: /~~([^\n]+?)~~/g },
  { type: "em-star", expression: /\*([^*\n]+?)\*/g },
  { type: "em-underscore", expression: /_([^_\n]+?)_/g }
];

export function renderMarkdown(markdown, options = {}) {
  const fragment = document.createDocumentFragment();
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n").trim();
  if (!source) return fragment;

  const lines = source.split("\n");
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    const fence = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const minimumLength = fence[1].length;
      const codeLines = [];
      index += 1;
      while (index < lines.length) {
        const closingFence = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (
          closingFence &&
          closingFence[1][0] === marker &&
          closingFence[1].length >= minimumLength
        ) {
          index += 1;
          break;
        }
        codeLines.push(lines[index]);
        index += 1;
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[2]) code.className = `language-${fence[2]}`;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`);
      appendInline(node, heading[2], options);
      fragment.append(node);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(lines[index])) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      const blockquote = document.createElement("blockquote");
      blockquote.append(renderMarkdown(quoteLines.join("\n"), options));
      fragment.append(blockquote);
      continue;
    }

    const listMatch = matchListItem(lines[index]);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const list = document.createElement(ordered ? "ol" : "ul");
      if (ordered && listMatch.start !== 1) list.start = listMatch.start;
      while (index < lines.length) {
        const itemMatch = matchListItem(lines[index]);
        if (!itemMatch || itemMatch.ordered !== ordered) break;
        const item = document.createElement("li");
        appendInline(item, itemMatch.content, options);
        index += 1;

        const continuation = [];
        while (
          index < lines.length &&
          lines[index].trim() &&
          !matchListItem(lines[index]) &&
          /^\s{2,}/.test(lines[index])
        ) {
          continuation.push(lines[index].trim());
          index += 1;
        }
        if (continuation.length > 0) {
          item.append(document.createTextNode(" "));
          appendInline(item, continuation.join(" "), options);
        }
        list.append(item);
      }
      fragment.append(list);
      continue;
    }

    if (isTableHeader(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const alignments = splitTableRow(lines[index + 1]).map(tableAlignment);
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table-wrap";
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      headers.forEach((header, column) => {
        const cell = document.createElement("th");
        if (alignments[column]) cell.style.textAlign = alignments[column];
        appendInline(cell, header, options);
        headerRow.append(cell);
      });
      thead.append(headerRow);
      table.append(thead);
      index += 2;

      const tbody = document.createElement("tbody");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = document.createElement("tr");
        const cells = splitTableRow(lines[index]);
        headers.forEach((_header, column) => {
          const cell = document.createElement("td");
          if (alignments[column]) cell.style.textAlign = alignments[column];
          appendInline(cell, cells[column] || "", options);
          row.append(cell);
        });
        tbody.append(row);
        index += 1;
      }
      if (tbody.childElementCount > 0) table.append(tbody);
      wrapper.append(table);
      fragment.append(wrapper);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim()) {
      if (paragraphLines.length > 0 && isBlockStart(lines, index)) break;
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    const paragraph = document.createElement("p");
    paragraphLines.forEach((line, lineIndex) => {
      const hardBreak = /(?: {2,}|\\)$/.test(line);
      appendInline(paragraph, line.replace(/(?: {2,}|\\)$/, ""), options);
      if (lineIndex < paragraphLines.length - 1) {
        paragraph.append(hardBreak ? document.createElement("br") : document.createTextNode(" "));
      }
    });
    fragment.append(paragraph);
  }

  return fragment;
}

function appendInline(parent, source, options) {
  let cursor = 0;
  while (cursor < source.length) {
    const token = findNextInline(source, cursor);
    if (!token) {
      parent.append(document.createTextNode(source.slice(cursor)));
      break;
    }
    if (token.index > cursor) {
      parent.append(document.createTextNode(source.slice(cursor, token.index)));
    }

    if (token.type === "code") {
      const code = document.createElement("code");
      code.textContent = token.match[1];
      parent.append(code);
    } else if (token.type === "link") {
      const link = document.createElement("a");
      link.href = token.match[2];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      appendInline(link, token.match[1], options);
      link.addEventListener("click", (event) => {
        event.preventDefault();
        options.openExternal?.(token.match[2]);
      });
      parent.append(link);
    } else {
      const tag = token.type.startsWith("strong")
        ? "strong"
        : token.type === "delete"
          ? "del"
          : "em";
      const node = document.createElement(tag);
      appendInline(node, token.match[1], options);
      parent.append(node);
    }
    cursor = token.index + token.match[0].length;
  }
}

function findNextInline(source, cursor) {
  let next;
  for (const pattern of inlinePatterns) {
    pattern.expression.lastIndex = cursor;
    const match = pattern.expression.exec(source);
    if (!match) continue;
    if (!next || match.index < next.index) {
      next = { type: pattern.type, match, index: match.index };
    }
  }
  return next;
}

function matchListItem(line) {
  const match = line.match(/^\s{0,3}([-+*]|(\d+)[.)])\s+(.+)$/);
  if (!match) return null;
  return {
    ordered: Boolean(match[2]),
    start: match[2] ? Number(match[2]) : 1,
    content: match[3]
  };
}

function isBlockStart(lines, index) {
  const line = lines[index];
  return (
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    Boolean(matchListItem(line)) ||
    /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line) ||
    isTableHeader(lines, index)
  );
}

function isTableHeader(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return false;
  const delimiters = splitTableRow(lines[index + 1]);
  return delimiters.length > 0 && delimiters.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignment(delimiter) {
  if (delimiter.startsWith(":") && delimiter.endsWith(":")) return "center";
  if (delimiter.endsWith(":")) return "right";
  if (delimiter.startsWith(":")) return "left";
  return "";
}
