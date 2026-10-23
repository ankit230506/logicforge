// budget.ts – Mode and time budget mapping (PURE: no vscode import)

export type Mode = 'sprint' | 'balanced' | 'learn';
export type ExplanationLength = 'short' | 'medium' | 'full';

export interface BudgetConfig {
  maxQuizzes: number;
  explanationLength: ExplanationLength;
}

/**
 * Compute budget config from mode and time budget hours.
 */
export function computeBudget(mode: Mode, timeBudgetHours: number): BudgetConfig {
  if (mode === 'sprint') {
    return { maxQuizzes: 0, explanationLength: 'short' };
  }

  // Time budget determines quiz count and explanation length
  if (timeBudgetHours > 0 && timeBudgetHours <= 1) {
    return { maxQuizzes: 1, explanationLength: 'short' };
  } else if (timeBudgetHours > 1 && timeBudgetHours <= 3) {
    return { maxQuizzes: 3, explanationLength: 'medium' };
  } else {
    // > 3 or 0 (no limit)
    if (mode === 'learn') {
      return { maxQuizzes: 6, explanationLength: 'full' };
    } else {
      return { maxQuizzes: 6, explanationLength: 'medium' };
    }
  }
}
