// config.ts – VS Code configuration adapter

import * as vscode from 'vscode';
import { Mode } from './budget';

export interface LogicForgeConfig {
  model: string;
  maxTokens: number;
  mode: Mode;
  agentName: string;
  timeBudgetHours: number;
  contextMaxChars: number;
  keepWhyComments: boolean;
  demoMode: boolean;
}

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('logicforge');
}

export function readConfig(): LogicForgeConfig {
  const cfg = getConfig();
  const modeRaw = (cfg.get<string>('mode') || 'balanced').toLowerCase();
  let mode: Mode = 'balanced';
  if (modeRaw === 'sprint' || modeRaw === 'balanced' || modeRaw === 'learn') {
    mode = modeRaw;
  }

  return {
    model: cfg.get<string>('model') || 'gemini-3.6-flash',
    maxTokens: cfg.get<number>('maxTokens') || 4096,
    mode,
    agentName: cfg.get<string>('agentName') || 'LogicForge',
    timeBudgetHours: cfg.get<number>('timeBudgetHours') || 0,
    contextMaxChars: cfg.get<number>('contextMaxChars') || 12000,
    keepWhyComments: cfg.get<boolean>('checkpoint.keepWhyComments') !== false,
    demoMode: cfg.get<boolean>('demoMode') === true,
  };
}

export async function updateConfig(key: string, value: unknown): Promise<void> {
  const cfg = getConfig();
  await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
}
