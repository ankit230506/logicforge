// llm.ts – LLM client interface and HTTP implementation

import * as vscode from 'vscode';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  finishReason: string;
}

export interface LlmClient {
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmResult>;
}

/**
 * Gemini API client. The endpoint is fixed; users only need to provide an API key.
 */
export class GeminiLlmClient implements LlmClient {
  constructor(
    private model: string,
    private apiKey: string,
    private defaultMaxTokens: number = 4096
  ) {}

  async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const systemMessage = messages.find(message => message.role === 'system');
    const contents = messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
    const body = {
      ...(systemMessage ? { systemInstruction: { parts: [{ text: systemMessage.content }] } } : {}),
      contents,
      generationConfig: {
        temperature: opts?.temperature ?? 0.3,
        maxOutputTokens: opts?.maxTokens ?? this.defaultMaxTokens,
      },
    };

    let lastError: Error | null = null;
    const maxRetries = 3; // initial + 2 retries

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: opts?.signal,
        });

        if (!response.ok) {
          const status = response.status;
          // Never retry 400/401/403/404
          if (status === 400 || status === 401 || status === 403 || status === 404) {
            if (status === 401) {
              throw new Error('Authentication failed. Please check your API key.');
            }
            const text = await response.text().catch(() => '');
            throw new Error(`API error ${status}: ${text.substring(0, 200)}`);
          }
          // Retry 429/5xx
          if (status === 429 || status >= 500) {
            if (attempt < maxRetries - 1) {
              const delay = attempt === 0 ? 500 : 1000;
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            throw new Error(`API error ${status} after ${maxRetries} attempts`);
          }
          throw new Error(`API error ${status}`);
        }

        const json = await response.json() as {
          candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
          error?: { message?: string };
        };
        const candidate = json.candidates?.[0];
        return {
          text: candidate?.content?.parts?.map(part => part.text || '').join('') || '',
          finishReason: candidate?.finishReason || 'stop',
        };
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          throw new Error('Request cancelled');
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxRetries - 1) {
          // Only retry on network errors or retryable statuses
          const delay = attempt === 0 ? 500 : 1000;
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }

    throw lastError || new Error('LLM request failed');
  }
}

/**
 * Get or prompt for the API key from secrets storage.
 */
export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return await secrets.get('logicforge.apiKey');
}

export async function promptApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    prompt: 'Enter your Gemini API key for LogicForge',
    password: true,
    placeHolder: 'AIza...',
    ignoreFocusOut: true,
  });
  if (key) {
    await secrets.store('logicforge.apiKey', key);
  }
  return key;
}
