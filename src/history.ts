// history.ts – History.md rendering (PURE: no vscode import)

export interface HistorySection {
  title: string;
  items: { label?: string; text: string }[];
}

export interface HistoryData {
  project: string;
  sections: HistorySection[];
}

/**
 * Count existing sections in history.md content by looking for ### numbered headings.
 */
export function countExistingSections(existingContent: string): number {
  const re = /^### \d+\./gm;
  const matches = existingContent.match(re);
  return matches ? matches.length : 0;
}

/**
 * Render new history sections into markdown text.
 * If existingContent is empty, starts with the project header.
 * Otherwise appends after a checkpoint timestamp separator.
 */
export function renderHistory(
  data: HistoryData,
  existingContent: string,
  timestamp: string
): string {
  const sectionStartNum = countExistingSections(existingContent) + 1;
  const lines: string[] = [];

  if (!existingContent.trim()) {
    lines.push(`# LogicForge - Project History`);
    lines.push('');
    lines.push(`## Project: ${data.project}`);
    lines.push('');
  }

  lines.push(`_Checkpoint ${timestamp}_`);
  lines.push('');

  data.sections.forEach((section, idx) => {
    const num = sectionStartNum + idx;
    lines.push(`### ${num}. ${section.title}`);
    lines.push('');
    for (const item of section.items) {
      if (item.label) {
        lines.push(`- ${item.label}: ${item.text}`);
      } else {
        lines.push(`- ${item.text}`);
      }
    }
    lines.push('');
  });

  if (existingContent.trim()) {
    return existingContent.trimEnd() + '\n\n' + lines.join('\n');
  }
  return lines.join('\n');
}
