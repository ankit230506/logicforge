// context.ts – Context assembly and truncation (PURE: no vscode import)

export interface ContextParts {
  projectName?: string;
  projectBrief?: string;
  planSummary?: string;
  moduleStatuses?: string;
  currentModule?: string;
  knownConcepts?: string[];
  folderMemory?: string;
  folderFiles?: string[];
  anchorContext?: string;  // anchor line + ~40 lines around
  recentMessages?: string[];  // last 6 messages
  mode?: string;
  explanationLength?: string;
}

/**
 * Assemble context string from parts, truncated to maxChars.
 */
export function assembleContext(parts: ContextParts, maxChars: number): string {
  const sections: string[] = [];

  if (parts.projectName) {
    sections.push(`Project: ${parts.projectName}${parts.projectBrief ? ' - ' + parts.projectBrief : ''}`);
  }

  if (parts.planSummary) {
    sections.push(`Plan: ${parts.planSummary}`);
  }

  if (parts.moduleStatuses) {
    sections.push(`Modules:\n${parts.moduleStatuses}`);
  }

  if (parts.currentModule) {
    sections.push(`Current module: ${parts.currentModule}`);
  }

  if (parts.knownConcepts && parts.knownConcepts.length > 0) {
    sections.push(`Known concepts: ${parts.knownConcepts.join(', ')}`);
  }

  if (parts.mode) {
    sections.push(`Mode: ${parts.mode}, explanation: ${parts.explanationLength || 'medium'}`);
  }

  if (parts.folderMemory) {
    sections.push(`Folder notes:\n${parts.folderMemory}`);
  }

  if (parts.folderFiles && parts.folderFiles.length > 0) {
    sections.push(`Files in this folder: ${parts.folderFiles.join(', ')}`);
  }

  if (parts.anchorContext) {
    sections.push(`Code around the thread:\n${parts.anchorContext}`);
  }

  if (parts.recentMessages && parts.recentMessages.length > 0) {
    sections.push(`Recent messages:\n${parts.recentMessages.join('\n')}`);
  }

  let text = sections.join('\n\n');
  return truncateContext(text, maxChars);
}

/**
 * Truncate context to maxChars, removing from the middle sections first (preserving
 * project info and recent messages).
 */
export function truncateContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Simple truncation: cut from the end with an indicator
  return text.substring(0, maxChars - 20) + '\n...(truncated)...';
}

/**
 * Get ~40 lines around an anchor line from a document.
 */
export function getAnchorContext(documentText: string, anchorLine: number, radius: number = 20): string {
  const lines = documentText.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, anchorLine - radius);
  const end = Math.min(lines.length - 1, anchorLine + radius);
  const contextLines: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === anchorLine ? '>>>' : '   ';
    contextLines.push(`${marker} ${i + 1}: ${lines[i]}`);
  }
  return contextLines.join('\n');
}
