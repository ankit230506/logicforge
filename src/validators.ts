// validators.ts – Semantic validators for parsed LLM responses (PURE: no vscode import)

import { ParsedTag, findTag, findAllTags, findChildTags } from './parser';

export interface ValidationError {
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function err(message: string): ValidationResult {
  return { valid: false, errors: [{ message }] };
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function combine(...results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap(r => r.errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a PLAN response: 3-6 modules, unique IDs, non-empty titles.
 */
export function validatePlan(tags: ParsedTag[]): ValidationResult {
  const planTag = findTag(tags, 'plan');
  if (!planTag) return err('Missing <plan> tag');
  if (!planTag.attrs.name?.trim()) return err('Plan missing name attribute');
  if (!planTag.attrs.summary?.trim()) return err('Plan missing summary attribute');

  const modules = findChildTags(planTag, 'module');
  if (modules.length < 3) return err(`Plan needs at least 3 modules, got ${modules.length}`);
  if (modules.length > 6) return err(`Plan can have at most 6 modules, got ${modules.length}`);

  const ids = new Set<string>();
  const results: ValidationResult[] = [];
  for (const m of modules) {
    if (!m.attrs.id?.trim()) {
      results.push(err('Module missing id attribute'));
    } else if (ids.has(m.attrs.id)) {
      results.push(err(`Duplicate module id: ${m.attrs.id}`));
    } else {
      ids.add(m.attrs.id);
    }
    if (!m.attrs.title?.trim()) {
      results.push(err('Module missing title attribute'));
    }
    if (!m.attrs.goal?.trim()) {
      results.push(err('Module missing goal attribute'));
    }
  }

  return combine(...results);
}

/**
 * Validate an ASK response: exactly one <ask>, exactly 3 options with IDs A-C, correct exists.
 */
export function validateAsk(tags: ParsedTag[]): ValidationResult {
  const askTags = findAllTags(tags, 'ask');
  if (askTags.length === 0) return err('Missing <ask> tag');
  if (askTags.length > 1) return err('Expected exactly one <ask> tag');

  const ask = askTags[0];
  const q = findTag(ask.children, 'q');
  if (!q || !q.body.trim()) return err('Missing or empty <q> tag inside <ask>');

  const opts = findChildTags(ask, 'opt');
  if (opts.length !== 3) return err(`Expected exactly 3 <opt> tags, got ${opts.length}`);

  const validIds = ['A', 'B', 'C'];
  for (let i = 0; i < opts.length; i++) {
    const optId = opts[i].attrs.id?.toUpperCase();
    if (!validIds.includes(optId)) {
      return err(`Option id must be A, B, or C; got "${opts[i].attrs.id}"`);
    }
    if (!opts[i].body.trim()) {
      return err(`Option ${optId} has empty text`);
    }
  }

  const correct = findTag(ask.children, 'correct');
  if (!correct) return err('Missing <correct> tag inside <ask>');
  const correctVal = correct.body.trim().toUpperCase();
  if (!validIds.includes(correctVal)) {
    return err(`Correct value must be A, B, or C; got "${correct.body.trim()}"`);
  }

  const why = findTag(ask.children, 'why');
  if (!why || !why.body.trim()) return err('Missing or empty <why> tag inside <ask>');

  return ok();
}

/**
 * Validate BUILD/CHAT response: paths non-empty, file content non-empty,
 * edit has find and replace, intro <= 140 chars.
 */
export function validateBuildChat(tags: ParsedTag[]): ValidationResult {
  const results: ValidationResult[] = [];

  for (const tag of tags) {
    if (tag.tag === 'folder') {
      if (!tag.attrs.path?.trim()) results.push(err('Folder missing path attribute'));
    } else if (tag.tag === 'file') {
      if (!tag.attrs.path?.trim()) results.push(err('File missing path attribute'));
      if (!tag.body.trim()) results.push(err(`File ${tag.attrs.path || '?'} has empty content`));
      if (tag.attrs.intro && tag.attrs.intro.length > 140) {
        results.push(err(`File ${tag.attrs.path} intro exceeds 140 characters`));
      }
    } else if (tag.tag === 'edit') {
      if (!tag.attrs.path?.trim()) results.push(err('Edit missing path attribute'));
      const findChild = findTag(tag.children, 'find');
      const replaceChild = findTag(tag.children, 'replace');
      if (!findChild || !findChild.body) results.push(err(`Edit on ${tag.attrs.path || '?'} missing <find>`));
      if (!replaceChild) results.push(err(`Edit on ${tag.attrs.path || '?'} missing <replace>`));
    } else if (tag.tag === 'insert') {
      if (!tag.body.trim()) results.push(err('Insert has empty content'));
    }
  }

  return combine(...results);
}

/**
 * Validate NOTES response: each note has id attr.
 */
export function validateNotes(tags: ParsedTag[]): ValidationResult {
  const notes = findAllTags(tags, 'note');
  if (notes.length === 0) return err('No <note> tags found');
  for (const n of notes) {
    if (!n.attrs.id) return err('Note missing id attribute');
  }
  return ok();
}

/**
 * Validate HISTORY response.
 */
export function validateHistory(tags: ParsedTag[]): ValidationResult {
  const hist = findTag(tags, 'history');
  if (!hist) return err('Missing <history> tag');
  const sections = findChildTags(hist, 'section');
  if (sections.length === 0) return err('History has no sections');
  for (const s of sections) {
    if (!s.attrs.title?.trim()) return err('Section missing title');
  }
  return ok();
}

/**
 * Validate tags only contain allowed tags for a given state.
 */
export function validateAllowedTags(tags: ParsedTag[], state: string): ValidationResult {
  const allowedMap: Record<string, Set<string>> = {
    PLAN: new Set(['say', 'plan']),
    CHAT: new Set(['say', 'folder', 'file', 'edit', 'insert', 'memory']),
    BUILD: new Set(['say', 'folder', 'file', 'edit', 'insert', 'memory']),
    ASK: new Set(['say', 'ask']),
    NOTES: new Set(['note']),
    HISTORY: new Set(['history']),
  };

  const allowed = allowedMap[state];
  if (!allowed) return ok();

  for (const tag of tags) {
    if (!allowed.has(tag.tag)) {
      return err(`Tag <${tag.tag}> not allowed in ${state} state`);
    }
  }
  return ok();
}

/**
 * Truncate <say> body by max lines based on explanation length.
 */
export function truncateSay(sayBody: string, explanationLength: 'short' | 'medium' | 'full'): string {
  const maxLines: Record<string, number> = { short: 3, medium: 6, full: 12 };
  const max = maxLines[explanationLength] || 6;
  const lines = sayBody.split('\n').filter(l => l.trim().length > 0);
  if (lines.length <= max) return lines.join('\n');
  return lines.slice(0, max).join('\n');
}
