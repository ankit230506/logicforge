// parser.ts – Tagged-reply parser for LLM responses (PURE: no vscode import)

export interface ParsedTag {
  tag: string;
  attrs: Record<string, string>;
  body: string;
  children: ParsedTag[];
}

const KNOWN_TAGS = new Set([
  'say', 'plan', 'module', 'ask', 'q', 'opt', 'correct', 'why',
  'folder', 'file', 'edit', 'find', 'replace', 'insert', 'memory',
  'note', 'history', 'section', 'item',
]);

// Raw-body tags: their body is raw text until the matching close tag (not parsed for children)
const RAW_BODY_TAGS = new Set([
  'say', 'q', 'opt', 'why', 'file', 'find', 'replace', 'insert', 'memory',
  'note', 'item',
]);

/**
 * Strip an outer ``` fence wrapping the whole reply.
 */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const fenceStart = /^```[a-zA-Z]*\s*\n/;
  const fenceEnd = /\n```\s*$/;
  if (fenceStart.test(trimmed) && fenceEnd.test(trimmed)) {
    return trimmed.replace(fenceStart, '').replace(fenceEnd, '').trim();
  }
  return trimmed;
}

/**
 * Parse attribute string like: name="foo" id="bar"
 */
function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"<\n]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Find the matching close tag for a given tag name starting at pos in text.
 * Returns the index right after </tag>. Handles nesting of same-name tags.
 */
function findCloseTag(text: string, tagName: string, startPos: number): number {
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'g');
  const closeRe = new RegExp(`</${tagName}>`, 'g');
  let depth = 1;
  let pos = startPos;

  while (depth > 0 && pos < text.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const openMatch = openRe.exec(text);
    const closeMatch = closeRe.exec(text);

    if (!closeMatch) {
      return -1; // unclosed tag
    }

    if (openMatch && openMatch.index < closeMatch.index) {
      depth++;
      pos = openMatch.index + openMatch[0].length;
    } else {
      depth--;
      if (depth === 0) {
        return closeMatch.index + closeMatch[0].length;
      }
      pos = closeMatch.index + closeMatch[0].length;
    }
  }

  return -1;
}

/**
 * Parse tagged blocks from text. Returns an array of top-level ParsedTag objects.
 * Throws on unknown tags or unclosed tags.
 */
export function parseTags(rawText: string): ParsedTag[] {
  const text = stripOuterFence(rawText);
  return parseTagsInner(text);
}

function parseTagsInner(text: string): ParsedTag[] {
  const results: ParsedTag[] = [];
  const tagRe = /<([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?\s*(?:\/>|>)/g;
  let lastEnd = 0;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(text)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrStr = match[2] || '';
    const isSelfClosing = match[0].endsWith('/>');

    if (!KNOWN_TAGS.has(tagName)) {
      // Avoid angle-bracket formatting: comment renderers treat unknown HTML tags as markup.
      throw new Error(`Unknown tag name '${tagName}'`);
    }

    if (isSelfClosing) {
      results.push({
        tag: tagName,
        attrs: parseAttrs(attrStr),
        body: '',
        children: [],
      });
      lastEnd = match.index + match[0].length;
      continue;
    }

    const bodyStart = match.index + match[0].length;

    if (RAW_BODY_TAGS.has(tagName)) {
      // Raw body: find the close tag without parsing inner tags
      const closeStr = `</${tagName}>`;
      const closeIdx = text.indexOf(closeStr, bodyStart);
      if (closeIdx === -1) {
        throw new Error(`Unclosed tag: <${tagName}>`);
      }
      const body = text.substring(bodyStart, closeIdx);
      results.push({
        tag: tagName,
        attrs: parseAttrs(attrStr),
        body,
        children: [],
      });
      const afterClose = closeIdx + closeStr.length;
      tagRe.lastIndex = afterClose;
      lastEnd = afterClose;
    } else {
      // Structured tag: parse children
      const closeEnd = findCloseTag(text, tagName, bodyStart);
      if (closeEnd === -1) {
        throw new Error(`Unclosed tag: <${tagName}>`);
      }
      const innerText = text.substring(bodyStart, closeEnd - `</${tagName}>`.length);
      const children = parseTagsInner(innerText);
      results.push({
        tag: tagName,
        attrs: parseAttrs(attrStr),
        body: innerText,
        children,
      });
      tagRe.lastIndex = closeEnd;
      lastEnd = closeEnd;
    }
  }

  return results;
}

/**
 * Extract the first tag with the given name from a list of parsed tags.
 */
export function findTag(tags: ParsedTag[], name: string): ParsedTag | undefined {
  return tags.find(t => t.tag === name);
}

/**
 * Extract all tags with the given name from a list of parsed tags.
 */
export function findAllTags(tags: ParsedTag[], name: string): ParsedTag[] {
  return tags.filter(t => t.tag === name);
}

/**
 * Extract all child tags with the given name from a parent tag.
 */
export function findChildTags(parent: ParsedTag, name: string): ParsedTag[] {
  return parent.children.filter(t => t.tag === name);
}
