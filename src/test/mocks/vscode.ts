// Minimal VS Code API mock for unit testing outside the extension host

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(scheme: string, authority: string, path: string, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  static file(path: string): Uri {
    return new Uri('file', '', path);
  }

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(':', ''), url.hostname, url.pathname);
    } catch {
      return new Uri('file', '', value);
    }
  }

  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const joined = [base.path, ...pathSegments].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, base.authority, joined);
  }

  static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query, components.fragment);
  }
}

export class RelativePattern {
  base: string;
  pattern: string;
  constructor(base: Uri | string, pattern: string) {
    this.base = typeof base === 'string' ? base : base.fsPath;
    this.pattern = pattern;
  }
}

export class EventEmitter<T = void> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter(l => l !== listener);
    });
  };
  fire(data: T): void {
    for (const l of this.listeners) { l(data); }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  private _callOnDispose: () => void;
  constructor(callOnDispose: () => void) {
    this._callOnDispose = callOnDispose;
  }
  dispose(): void {
    this._callOnDispose();
  }
  static from(...disposables: { dispose: () => void }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: (_fn: () => void) => new Disposable(() => {}) };
  cancel(): void { this.token.isCancellationRequested = true; }
  dispose(): void {}
}

export const LanguageModelChatMessage = {
  User: (content: string) => ({ role: 'user', content }),
  Assistant: (content: string) => ({ role: 'assistant', content }),
};

export const workspace = {
  workspaceFolders: [{ uri: Uri.file('/mock-workspace'), name: 'mock', index: 0 }],
  findFiles: async (_include: unknown, _exclude?: unknown, _maxResults?: number): Promise<Uri[]> => [],
  openTextDocument: async (uri: Uri | string) => ({
    getText: () => '',
    uri: typeof uri === 'string' ? Uri.file(uri) : uri,
    lineCount: 0,
  }),
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T) => defaultValue,
    update: async () => {},
    has: () => false,
    inspect: () => undefined,
  }),
  fs: {
    readFile: async (_uri: Uri) => new Uint8Array(),
    writeFile: async (_uri: Uri, _content: Uint8Array) => {},
    stat: async (_uri: Uri) => ({ type: 2, ctime: 0, mtime: 0, size: 0 }),
    readDirectory: async (_uri: Uri) => [],
    createDirectory: async (_uri: Uri) => {},
    delete: async (_uri: Uri) => {},
    rename: async (_oldUri: Uri, _newUri: Uri) => {},
  },
  createFileSystemWatcher: (_glob: unknown) => ({
    onDidChange: new EventEmitter().event,
    onDidCreate: new EventEmitter().event,
    onDidDelete: new EventEmitter().event,
    dispose: () => {},
  }),
  onDidChangeConfiguration: new EventEmitter().event,
};

export const window = {
  showInformationMessage: async <T extends string>(_msg: string, ..._items: T[]): Promise<T | undefined> => undefined,
  showErrorMessage: async <T extends string>(_msg: string, ..._items: T[]): Promise<T | undefined> => undefined,
  showWarningMessage: async <T extends string>(_msg: string, ..._items: T[]): Promise<T | undefined> => undefined,
  showQuickPick: async <T extends { label: string }>(_items: T[], _options?: unknown): Promise<T | undefined> => undefined,
  createWebviewPanel: (_viewType: string, _title: string, _showOptions: unknown, _options?: unknown) => ({
    webview: {
      html: '',
      onDidReceiveMessage: new EventEmitter().event,
      postMessage: async () => true,
      asWebviewUri: (uri: Uri) => uri,
    },
    onDidDispose: new EventEmitter().event,
    dispose: () => {},
    reveal: () => {},
    visible: true,
  }),
  showTextDocument: async (_doc: unknown) => ({}),
  activeTextEditor: undefined,
  createOutputChannel: (_name: string) => ({
    appendLine: () => {},
    append: () => {},
    clear: () => {},
    show: () => {},
    dispose: () => {},
  }),
};

export const commands = {
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown): Disposable =>
    new Disposable(() => {}),
  executeCommand: async <T>(_command: string, ..._rest: unknown[]): Promise<T | undefined> => undefined,
};

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export default {
  Uri,
  RelativePattern,
  EventEmitter,
  Disposable,
  CancellationTokenSource,
  LanguageModelChatMessage,
  workspace,
  window,
  commands,
  ViewColumn,
  FileType,
};
