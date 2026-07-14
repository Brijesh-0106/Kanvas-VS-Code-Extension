import * as vscode from 'vscode';
import { KanvasEditorProvider } from './kanvasEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(KanvasEditorProvider.register(context));
}

export function deactivate(): void {
  // no-op
}
