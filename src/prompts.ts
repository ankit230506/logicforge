// prompts.ts – LLM prompt templates (PURE: no vscode import)

const SYSTEM_PROMPT = `You are LogicForge, a friendly coding tutor and coding agent inside the user's VS Code editor. The human must understand the logic; you write the code. Plain, concise language, light markdown only, no emojis. Reply ONLY in the tagged format for the requested state. Put <say> first.`;

const PLAN_EXAMPLE = `<say>Here is a plan for a student CLI in Python.</say>
<plan name="Student CLI Management" summary="CLI to add, list and search students.">
<module id="m1" title="Student storage" goal="Store and find students by ID" decision="true" concept="hash map"/>
<module id="m2" title="CLI menu" goal="Loop that reads commands" decision="false" concept=""/>
</plan>`;

const ASK_EXAMPLE = `<say>We need fast lookup by student ID.</say>
<ask concept="hash map"><q>Which data structure fits best?</q><opt id="A">List</opt><opt id="B">Dictionary / hash map</opt><opt id="C">Linked list</opt><correct>B</correct><why>A hash map finds an ID in about O(1); a list needs a full scan.</why></ask>`;

const BUILD_EXAMPLE = `<say>I created students.py. It keeps students in a dict keyed by ID so lookups are instant.</say>
<folder path="src" purpose="Application source code"/>
<file path="src/students.py" intro="Student storage using a dictionary keyed by ID.">
class StudentManager:
    def __init__(self):
        self.students = {}
</file>
<memory>students stored in a dict keyed by ID</memory>`;

const CHAT_EXAMPLE = `<say>A dictionary gives O(1) lookup by key. Lists require scanning every element.</say>
<memory>user understands dict vs list tradeoffs</memory>`;

const NOTES_EXAMPLE = `<note id="1">Dict gives O(1) lookup by student ID.</note>
<note id="2" drop="true"/>`;

const HISTORY_EXAMPLE = `<history project="Student CLI Management"><section title="Data Structure Decision"><item label="Question">Why use a dictionary?</item><item label="Key Insight">Unique student ID gives O(1) lookup</item><item label="Alternatives">List (O(n)), Set (only IDs), Database</item><item label="Final Decision">Python dictionary</item></section></history>`;

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function getPlanPrompt(brief: string, maxQuizzes: number): string {
  return `Project brief: ${brief}. Break it into 3-6 small modules in build order. Set decision=true only for modules with a REAL design choice (architecture, data structure, algorithm), at most ${maxQuizzes} in total, each with a short concept name. Format and example:\n${PLAN_EXAMPLE}`;
}

export function getAskPrompt(title: string, goal: string): string {
  return `Module: ${title} - ${goal}. Write ONE question with exactly 3 plausible options, exactly one best, and a 2-3 line why. Explain the problem in one sentence in <say>. No code. Format and example:\n${ASK_EXAMPLE}`;
}

export function getBuildPrompt(
  title: string,
  goal: string,
  decision: string
): string {
  return `Module: ${title} - ${goal}. User's decision: ${decision || 'none'}. Write the code for THIS module only. Use only folder, file, edit, insert, say, memory; paths relative to the workspace root; an edit's find text must match exactly once. In <say> explain what it does, why, and how it connects. Format and example:\n${BUILD_EXAMPLE}`;
}

export function getChatPrompt(message: string): string {
  return `The user wrote: ${message}. Answer as a tutor. If they ask you to create or change code use the BUILD format; otherwise only <say> (and <memory> if a lasting fact emerged). Format and example:\n${CHAT_EXAMPLE}`;
}

export function getNotesPrompt(threads: { id: string; messages: string; anchor: string; codeContext: string }[]): string {
  const threadTexts = threads.map(t =>
    `Thread ${t.id}:\nAnchor: ${t.anchor}\nCode:\n${t.codeContext}\nMessages:\n${t.messages}`
  ).join('\n\n');
  return `For each thread, write a 1-2 line note capturing WHY this code decision was made. Remove questions, keep logic. Max 2 lines, max 110 chars per line. No role words, no emojis, no @mentions. Use <note id="X">text</note> or <note id="X" drop="true"/> if nothing worth keeping. Format:\n${NOTES_EXAMPLE}\n\nThreads:\n${threadTexts}`;
}

export function getHistoryPrompt(
  material: string,
  existingHeadings: string
): string {
  return `Write a project history update from the checkpoint material below. Each section has a title and labeled items (Question, Key Insight, Alternatives, Final Decision, or other free labels). At most ONE short Question per section (<= 12 words, topic-style). No dialogue, greetings, or @mentions. Format:\n${HISTORY_EXAMPLE}\n\nExisting headings: ${existingHeadings || 'none'}\n\nMaterial:\n${material}`;
}
