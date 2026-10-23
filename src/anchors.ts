// anchors.ts – Thread anchor re-finder (PURE: no vscode import)

/**
 * Normalize text for matching: collapse whitespace, trim, normalize CRLF to LF.
 */
function normalizeForMatch(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * Find the best line for a thread anchor in a document.
 * Searches within +-searchRadius lines of the saved line for the anchor text.
 * Returns the best matching line number (0-indexed), or clamps the saved line if not found.
 */
export function findAnchorLine(
  documentLines: string[],
  savedLine: number,
  anchorText: string,
  searchRadius: number = 20
): number {
  if (!anchorText || !anchorText.trim()) {
    // No anchor text - just clamp the saved line
    return clampLine(savedLine, documentLines.length);
  }

  const normalizedAnchor = normalizeForMatch(anchorText);
  if (!normalizedAnchor) {
    return clampLine(savedLine, documentLines.length);
  }

  const startLine = Math.max(0, savedLine - searchRadius);
  const endLine = Math.min(documentLines.length - 1, savedLine + searchRadius);

  let bestLine = -1;
  let bestDistance = Infinity;

  for (let i = startLine; i <= endLine; i++) {
    const lineNorm = normalizeForMatch(documentLines[i]);
    if (lineNorm === normalizedAnchor) {
      const distance = Math.abs(i - savedLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = i;
      }
    }
  }

  // Exact match found
  if (bestLine >= 0) return bestLine;

  // Try substring match
  for (let i = startLine; i <= endLine; i++) {
    const lineNorm = normalizeForMatch(documentLines[i]);
    if (lineNorm.includes(normalizedAnchor) || normalizedAnchor.includes(lineNorm)) {
      const distance = Math.abs(i - savedLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = i;
      }
    }
  }

  if (bestLine >= 0) return bestLine;

  // No match found: clamp the saved line
  return clampLine(savedLine, documentLines.length);
}

function clampLine(line: number, totalLines: number): number {
  if (totalLines === 0) return 0;
  return Math.max(0, Math.min(line, totalLines - 1));
}
