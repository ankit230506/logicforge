// sandbox.ts – Path safety checks (PURE: no vscode import)

import * as path from 'path';

/**
 * Normalize path separators to forward slash.
 */
export function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Check if a relative path is safe to use.
 * Rejects: absolute paths, drive letters, UNC paths, ".." segments,
 * paths under .logicforge/, .git/, or node_modules/.
 * Treats "\" and "/" equally.
 */
export function validateRelativePath(relPath: string): { valid: boolean; reason?: string } {
  if (!relPath || !relPath.trim()) {
    return { valid: false, reason: 'Path is empty' };
  }

  const normalized = normalizeSeparators(relPath.trim());

  // Reject absolute paths
  if (normalized.startsWith('/')) {
    return { valid: false, reason: 'Absolute paths are not allowed' };
  }

  // Reject drive letters (e.g. C:)
  if (/^[a-zA-Z]:/.test(normalized)) {
    return { valid: false, reason: 'Drive letter paths are not allowed' };
  }

  // Reject UNC paths
  if (normalized.startsWith('//')) {
    return { valid: false, reason: 'UNC paths are not allowed' };
  }

  // Reject ".." segments
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { valid: false, reason: 'Path traversal ("..") is not allowed' };
    }
  }

  // Reject reserved directories
  const lower = normalized.toLowerCase();
  if (lower === '.logicforge' || lower.startsWith('.logicforge/')) {
    return { valid: false, reason: 'Paths under .logicforge/ are reserved' };
  }
  if (lower === '.git' || lower.startsWith('.git/')) {
    return { valid: false, reason: 'Paths under .git/ are reserved' };
  }
  if (lower === 'node_modules' || lower.startsWith('node_modules/')) {
    return { valid: false, reason: 'Paths under node_modules/ are reserved' };
  }

  return { valid: true };
}

/**
 * Resolve a relative path against a workspace root and verify containment.
 */
export function resolveAndContain(workspaceRoot: string, relPath: string): { resolved: string; valid: boolean; reason?: string } {
  const validation = validateRelativePath(relPath);
  if (!validation.valid) {
    return { resolved: '', valid: false, reason: validation.reason };
  }

  const normalizedRel = normalizeSeparators(relPath.trim());
  const normalizedRoot = normalizeSeparators(workspaceRoot);
  const resolved = path.resolve(workspaceRoot, normalizedRel);
  const resolvedNorm = normalizeSeparators(resolved);

  // Verify the resolved path is inside the workspace root
  if (!resolvedNorm.startsWith(normalizedRoot + '/') && resolvedNorm !== normalizedRoot) {
    return { resolved: '', valid: false, reason: 'Resolved path escapes the workspace' };
  }

  return { resolved, valid: true };
}
