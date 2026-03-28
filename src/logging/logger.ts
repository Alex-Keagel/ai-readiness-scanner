import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('AI Readiness Scanner');
  context.subscriptions.push(outputChannel);
}

export function getOutputChannel(): vscode.OutputChannel | undefined {
  return outputChannel;
}

export const logger = {
  debug(msg: string, data?: Record<string, unknown>): void {
    const line = `[DEBUG ${ts()}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    outputChannel?.appendLine(line);
  },
  info(msg: string, data?: Record<string, unknown>): void {
    const line = `[INFO  ${ts()}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    outputChannel?.appendLine(line);
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    const line = `[WARN  ${ts()}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
    outputChannel?.appendLine(line);
    console.warn(line);
  },
  error(msg: string, error?: unknown, data?: Record<string, unknown>): void {
    const errMsg = error instanceof Error ? error.message : String(error || '');
    const line = `[ERROR ${ts()}] ${msg}${errMsg ? ': ' + errMsg : ''}${data ? ' ' + JSON.stringify(data) : ''}`;
    outputChannel?.appendLine(line);
    console.error(line);
  },
  time(label: string): () => void {
    const start = Date.now();
    return () => {
      const ms = Date.now() - start;
      outputChannel?.appendLine(`[PERF  ${ts()}] ${label}: ${ms}ms`);
    };
  },
};

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
