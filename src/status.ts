// status.ts – Status bar management

import * as vscode from 'vscode';
import { Mode } from './budget';

export class StatusBar {
  private item: vscode.StatusBarItem;
  private spinning = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'logicforge.setMode';
    this.item.show();
  }

  update(mode: Mode, hours: number, demoMode: boolean, busy: boolean): void {
    const modeStr = mode.charAt(0).toUpperCase() + mode.slice(1);
    const hoursStr = hours > 0 ? `${hours}h` : '∞';
    const demoStr = demoMode ? ' · DEMO' : '';
    const icon = busy ? '$(sync~spin)' : '$(symbol-misc)';
    this.item.text = `${icon} LogicForge: ${modeStr} · ${hoursStr}${demoStr}`;
    this.spinning = busy;
  }

  dispose(): void {
    this.item.dispose();
  }
}
