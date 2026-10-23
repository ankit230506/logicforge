// quiz.ts – Quiz normalization and evaluation (PURE: no vscode import)

/**
 * Normalize a concept string: lowercase, trim, collapse spaces/hyphens/underscores,
 * strip one trailing "s".
 */
export function normalizeConcept(concept: string): string {
  let c = concept.toLowerCase().trim();
  // Collapse spaces, hyphens, underscores to single space
  c = c.replace(/[\s\-_]+/g, ' ');
  // Strip one trailing "s" (simple plurals)
  if (c.length > 1 && c.endsWith('s') && !c.endsWith('ss')) {
    c = c.slice(0, -1);
  }
  return c.trim();
}

/**
 * Check if a concept is known (exists in the known concepts list).
 */
export function isConceptKnown(concept: string, knownConcepts: string[]): boolean {
  const normalized = normalizeConcept(concept);
  return knownConcepts.some(k => normalizeConcept(k) === normalized);
}

/**
 * Evaluate a quiz answer.
 */
export function evaluateQuiz(
  choice: string,
  correctId: string,
  options: { id: string; text: string }[],
  why: string
): { isCorrect: boolean; feedback: string } {
  const choiceUpper = choice.toUpperCase();
  const correctUpper = correctId.toUpperCase();
  const isCorrect = choiceUpper === correctUpper;

  const correctOption = options.find(o => o.id.toUpperCase() === correctUpper);
  const chosenOption = options.find(o => o.id.toUpperCase() === choiceUpper);

  if (isCorrect) {
    // Truncate why to 2-3 lines
    const whyLines = why.split('\n').filter(l => l.trim()).slice(0, 3).join(' ');
    return {
      isCorrect: true,
      feedback: `Correct. ${whyLines}`,
    };
  } else {
    const whyLines = why.split('\n').filter(l => l.trim()).slice(0, 3).join(' ');
    const wrongExplanation = chosenOption
      ? ` "${chosenOption.text}" works differently in this context.`
      : '';
    return {
      isCorrect: false,
      feedback: `Better choice: ${correctOption?.text || correctUpper}. ${whyLines}${wrongExplanation}`,
    };
  }
}

/**
 * Parse a text reply that might be a quiz answer.
 * Returns the choice letter or null.
 */
export function parseQuizAnswer(text: string): { type: 'answer'; choice: string } | { type: 'iknow' } | null {
  const trimmed = text.trim();

  // "I know this" or "I know it"
  if (/^i know (this|it)/i.test(trimmed)) {
    return { type: 'iknow' };
  }

  // Match answer patterns like "A", "answer A", "A)", "answer a)"
  const answerMatch = trimmed.match(/^\s*(?:answer\s*)?([abc])\)?\s*$/i);
  if (answerMatch) {
    return { type: 'answer', choice: answerMatch[1].toUpperCase() };
  }

  return null;
}
