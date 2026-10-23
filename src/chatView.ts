import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private busy = false;

  constructor(
    private readonly sendToLogicForge: (text: string) => Promise<string>,
    private readonly cancelRequest: () => void
  ) {}

  focusInput(): void {
    this.view?.show(false);
    void this.view?.webview.postMessage({ type: 'focus' });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async (message: { type?: string; text?: string }) => {
      if (message.type === 'cancel') {
        this.cancelRequest();
        return;
      }
      if (message.type !== 'send' || this.busy) return;

      const text = (message.text || '').trim();
      if (!text) return;
      this.busy = true;
      void view.webview.postMessage({ type: 'busy', value: true });
      try {
        const reply = await this.sendToLogicForge(text);
        void view.webview.postMessage({ type: 'reply', text: reply || 'No response was produced. Check the LogicForge comment thread for details.' });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void view.webview.postMessage({ type: 'reply', text: `Error: ${detail}` });
      } finally {
        this.busy = false;
        void view.webview.postMessage({ type: 'busy', value: false });
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>LogicForge Chat</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    header { padding: 14px 16px 12px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 9px; }
    .brand { font-weight: 600; font-size: 14px; }
    .subtitle { opacity: .7; font-size: 11px; margin-top: 2px; }
    .mark { width: 25px; height: 25px; border-radius: 8px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); display: grid; place-items: center; font-weight: 700; }
    #messages { flex: 1; overflow-y: auto; padding: 18px 12px; display: flex; flex-direction: column; gap: 14px; }
    .welcome { margin: auto 3px; padding: 18px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; background: var(--vscode-editor-background); }
    .welcome h2 { font-size: 17px; margin: 0 0 8px; }
    .welcome p { margin: 0; opacity: .75; line-height: 1.5; }
    .message { max-width: 94%; padding: 10px 12px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .assistant { align-self: flex-start; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
    .working { opacity: .7; font-style: italic; }
    footer { padding: 10px 12px 12px; border-top: 1px solid var(--vscode-panel-border); }
    .composer { display: flex; align-items: flex-end; gap: 8px; padding: 8px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 16px; background: var(--vscode-input-background); box-shadow: 0 2px 8px #0002; }
    textarea { flex: 1; resize: none; min-height: 26px; max-height: 140px; padding: 4px; color: var(--vscode-input-foreground); background: transparent; border: 0; outline: 0; font: inherit; line-height: 1.45; }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    #send { width: 30px; height: 30px; flex: 0 0 30px; border: 0; border-radius: 9px; display: grid; place-items: center; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font-size: 17px; }
    #send:hover { background: var(--vscode-button-hoverBackground); }
    #send:disabled { opacity: .55; cursor: default; }
    .hint { margin: 7px 3px 0; text-align: center; opacity: .6; font-size: 10px; }
  </style>
</head>
<body>
  <header><div class="mark">L</div><div><div class="brand">LogicForge</div><div class="subtitle">Plan, learn, and build with your project</div></div></header>
  <main id="messages" aria-live="polite"><section class="welcome" id="welcome"><h2>What are you building?</h2><p>Describe a feature, ask a question, or start a plan with <code>/plan</code>. Press Enter to send; use the arrow keys to browse recent prompts.</p></section></main>
  <footer><div class="composer"><textarea id="input" rows="1" aria-label="Message LogicForge" placeholder="Message LogicForge…"></textarea><button id="send" aria-label="Send message" title="Send">↑</button></div><div class="hint">Enter to send · Shift+Enter for a new line</div></footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const button = document.getElementById('send');
    let history = [];
    let historyIndex = -1;
    let busy = false;
    let workingNode = null;
    function save() { vscode.setState({ history }); }
    function addMessage(role, text) {
      const welcome = document.getElementById('welcome');
      if (welcome) welcome.remove();
      const node = document.createElement('div');
      node.className = 'message ' + role;
      node.textContent = text;
      messages.appendChild(node);
      messages.scrollTop = messages.scrollHeight;
    }
    function setBusy(value) {
      if (busy === value) return;
      busy = value;
      input.disabled = value;
      button.disabled = false;
      button.textContent = value ? '■' : '↑';
      button.setAttribute('aria-label', value ? 'Stop response' : 'Send message');
      button.title = value ? 'Stop' : 'Send';
      if (value) {
        workingNode = document.createElement('div');
        workingNode.className = 'message assistant working';
        workingNode.textContent = 'Thinking…';
        messages.appendChild(workingNode);
        messages.scrollTop = messages.scrollHeight;
      } else if (workingNode) {
        workingNode.remove();
        workingNode = null;
      }
    }
    function send() {
      if (busy) return;
      const text = input.value.trim();
      if (!text) return;
      addMessage('user', text);
      history.push(text);
      historyIndex = -1;
      save();
      input.value = '';
      input.style.height = 'auto';
      setBusy(true);
      vscode.postMessage({ type: 'send', text });
    }
    button.addEventListener('click', () => {
      if (busy) vscode.postMessage({ type: 'cancel' });
      else send();
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
        return;
      }
      if (event.key === 'ArrowUp' && input.selectionStart === 0 && input.selectionEnd === 0 && history.length) {
        event.preventDefault();
        historyIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
        input.value = history[historyIndex];
        input.setSelectionRange(0, 0);
      } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
        event.preventDefault();
        historyIndex++;
        if (historyIndex >= history.length) { historyIndex = -1; input.value = ''; }
        else input.value = history[historyIndex];
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
    const saved = vscode.getState();
    if (saved && Array.isArray(saved.history)) history = saved.history;
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'busy') setBusy(Boolean(message.value));
      else if (message.type === 'reply') addMessage('assistant', message.text || '');
      else if (message.type === 'focus') input.focus();
    });
  </script>
</body>
</html>`;
  }
}
