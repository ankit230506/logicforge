# LogicForge

**AI writes the code. You own the logic.** LogicForge is a VS Code prototype that keeps project planning, questions, explanations, and code changes in editor comment threads.

## Run it

1. Open this folder in VS Code and run `npm install`.
2. Run `npm run verify` and press F5 to launch the Extension Development Host.
3. Open a workspace folder and an empty `main.py`.
4. Enable `LogicForge: Toggle Demo Mode`; no network or API key is used.
5. Add a comment with the gutter `+` or `Ctrl+Alt+L`, then reply `/plan student management CLI in Python`.
6. Run `LogicForge: Next Module`, answer the three-option quiz, and inspect the generated source and folder memory.
7. In a generated source file ask `why a dict here?`, then run `LogicForge: Checkpoint` and review the preview before applying.
8. To use Gemini, turn demo mode off and run `LogicForge: Set API Key`. Enter your Gemini API key; it is stored in VS Code SecretStorage. The Gemini endpoint is built in, so no URL is required.

## Settings

- `logicforge.model`: Gemini model name, default `gemini-3.6-flash`.
- `logicforge.maxTokens`: response token cap.
- `logicforge.mode`: `sprint`, `balanced`, or `learn`.
- `logicforge.agentName`: comment author name.
- `logicforge.timeBudgetHours`: optional time budget.
- `logicforge.contextMaxChars`: context character limit.
- `logicforge.checkpoint.keepWhyComments`: add supported-language rationale comments during checkpoint.
- `logicforge.demoMode`: deterministic local demo responses.

## Commands

Use the Command Palette for Next Module, Checkpoint, Open History, Set API Key, Set Mode, Set Time Budget, New Project, Reset Session, Cancel, Ping, and Toggle Demo Mode. Replies can start with `/plan <brief>` or `/next`.

Use the **Chat** view in the LogicForge activity bar for an AI-style composer. Enter sends, Shift+Enter adds a line, and Up/Down browse previous prompts. While a request is running, the send button becomes a stop button. Open a file in the workspace before sending; messages also stay in the corresponding LogicForge comment thread.

From an inline comment thread, use **Continue in LogicForge Chat** to open the same thread in the custom Chat composer. VS Code controls the native inline reply editor's appearance and keyboard behavior; the extension cannot restyle that built-in editor.

In Balanced and Learn modes, each new plan automatically starts with one project-specific decision question before implementation. LogicForge presents three options, explains when each fits, and uses your choice to shape the first module. Design choices are treated as tradeoffs, not right-or-wrong preferences. During every build, LogicForge explains what changed, the key idea and data flow, why the approach fits, and one thing to inspect or try. Learn mode also asks a short question about the code after each successful module; its explanation follows your answer before you choose **Next Module**. Sprint mode skips questions and keeps explanations brief.

## Troubleshooting

- **Please open a workspace folder first.** Open a folder in VS Code; LogicForge stores state under `.logicforge/` in that workspace.
- **API request fails.** Confirm the saved Gemini API key is valid and the model is available to your account.
- **A file type has no why comment.** JSON and unsupported extensions keep the rationale in `.logicforge/history.md` only.
- **Tests or packaging fail.** Run `npm install`, then `npm run verify`; `npm run package` creates the VSIX.

## Development

`npm run verify` performs type checking, bundling, pure unit tests, and manifest consistency checks. `npm run test:integration` launches the VS Code smoke test when VS Code can be downloaded and started in the environment. Package with `npm run package`.
