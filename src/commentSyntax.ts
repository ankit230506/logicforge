// commentSyntax.ts – Comment syntax map and insertion text (PURE: no vscode import)

export interface CommentStyle {
  type: 'line' | 'block' | 'html' | 'none';
  start: string;
  end?: string;
}

const LINE_COMMENT_EXTS: Record<string, string> = {
  '.js': '//',
  '.ts': '//',
  '.jsx': '//',
  '.tsx': '//',
  '.java': '//',
  '.c': '//',
  '.cpp': '//',
  '.h': '//',
  '.hpp': '//',
  '.cs': '//',
  '.go': '//',
  '.rs': '//',
  '.kt': '//',
  '.swift': '//',
  '.php': '//',
  '.py': '#',
  '.sh': '#',
  '.rb': '#',
  '.yaml': '#',
  '.yml': '#',
  '.toml': '#',
  '.ini': '#',
};

const BLOCK_COMMENT_EXTS: Record<string, { start: string; end: string }> = {
  '.css': { start: '/* ', end: ' */' },
};

const HTML_COMMENT_EXTS = new Set(['.html', '.htm', '.md', '.xml', '.svg']);

/**
 * Get the comment style for a file extension.
 */
export function getCommentStyle(ext: string): CommentStyle {
  const lower = ext.toLowerCase();
  if (LINE_COMMENT_EXTS[lower]) {
    return { type: 'line', start: LINE_COMMENT_EXTS[lower] };
  }
  if (BLOCK_COMMENT_EXTS[lower]) {
    return { type: 'block', start: BLOCK_COMMENT_EXTS[lower].start, end: BLOCK_COMMENT_EXTS[lower].end };
  }
  if (HTML_COMMENT_EXTS.has(lower)) {
    return { type: 'html', start: '<!-- ', end: ' -->' };
  }
  return { type: 'none', start: '' };
}

/**
 * Check if a file extension supports line comments (for why-comments).
 */
export function supportsWhyComment(ext: string): boolean {
  const style = getCommentStyle(ext);
  return style.type !== 'none';
}

/**
 * Format a "why:" comment for insertion above a line.
 * Preserves the line's indentation.
 */
export function formatWhyComment(
  whyText: string,
  ext: string,
  indentation: string,
  eol: string
): string {
  const style = getCommentStyle(ext);
  if (style.type === 'none') return '';

  const text = `why: ${whyText}`;
  let commentLine: string;

  switch (style.type) {
    case 'line':
      commentLine = `${indentation}${style.start} ${text}`;
      break;
    case 'block':
      commentLine = `${indentation}${style.start}${text}${style.end}`;
      break;
    case 'html':
      commentLine = `${indentation}${style.start}${text}${style.end}`;
      break;
    default:
      return '';
  }

  return commentLine + eol;
}

/**
 * Extract indentation (leading whitespace) from a line.
 */
export function getIndentation(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

/**
 * Detect the EOL style of a text.
 */
export function detectEol(text: string): string {
  if (text.includes('\r\n')) return '\r\n';
  return '\n';
}
