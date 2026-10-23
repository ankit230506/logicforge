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
  const decisionRule = maxQuizzes > 0
    ? ` The FIRST module must contain a meaningful, project-specific decision checkpoint, even when the user's brief is short or does not explicitly request questions. Mark it decision="true" and give it a concise concept. Choose a consequential decision suited to this project (such as data structure, persistence, architecture, API shape, layout, or interaction behavior), not an invented or generic question. Mark later modules decision=true only when they introduce another meaningful choice. Ask at most ${maxQuizzes} questions total.`
    : ' Do not ask quiz questions in sprint mode.';
  return `Project brief: ${brief}. Break it into 3-6 small modules in build order.${decisionRule} Mark other modules decision="false" and leave concept empty. Format and example:\n${PLAN_EXAMPLE}`;
}

export function getAskPrompt(title: string, goal: string): string {
  return `Module: ${title} - ${goal}. Use the project brief and module context to identify a real decision that will shape this project. Ask ONE specific question with exactly 3 plausible, meaningfully different options and one recommended fit. In <why>, explain the tradeoffs in plain language, when each option is useful, and why the recommendation fits this project's stated needs. Treat this as a design choice: the user's choice is not morally or universally wrong; adapt the implementation to it when practical. If an option has a concrete downside, explain it without shaming. Explain what decision is being made in one sentence in <say>. No code. Format and example:\n${ASK_EXAMPLE}`;
}

export function getLearningCheckPrompt(title: string, goal: string): string {
  return `The module "${title}" has just been implemented for this goal: ${goal}. Use the actual files and code in the supplied context. Ask ONE short comprehension question that checks an important idea the user can now see in that code (for example, how data flows, why a structure is used, or what a function protects). Give exactly 3 plausible options with exactly one technically correct answer. In <why>, explain the concept and point to the relevant file/function or code behavior from context. In <say>, briefly invite the user to try before revealing the explanation. This is a learning check, not a design decision. No code changes.`;
}

export function getBuildPrompt(
  title: string,
  goal: string,
  decision: string
): string {
  return `Module: ${title} - ${goal}. User's decision: ${decision || 'none'}. Implement THIS module only; do not generate later modules or duplicate existing code. Use only folder, file, edit, insert, say, memory; paths relative to the workspace root; an edit's find text must match exactly once. Teach as you build: in <say>, explain (1) what changed and where, (2) the key concept or data flow in plain language, (3) why this approach fits the user's decision and one relevant tradeoff, and (4) one concrete thing the user can inspect or try now. Keep this explanation proportional to the mode and never claim checks were run unless they were. Add helpful file intro text that explains the file's responsibility. Format and example:\n${BUILD_EXAMPLE}`;
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
