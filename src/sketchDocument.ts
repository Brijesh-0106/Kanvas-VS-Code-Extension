import * as vscode from 'vscode';

export interface SketchScene {
  elements: any[];
  appState?: Record<string, any>;
}

interface SketchEdit {
  label: string;
  before: SketchScene;
  after: SketchScene;
}

function emptyScene(): SketchScene {
  return { elements: [], appState: {} };
}

export class SketchDocument implements vscode.CustomDocument {
  static async create(
    uri: vscode.Uri,
    backupId: string | undefined
  ): Promise<SketchDocument> {
    const dataUri = backupId ? vscode.Uri.parse(backupId) : uri;
    const scene = await SketchDocument.readFile(dataUri);
    return new SketchDocument(uri, scene);
  }

  private static async readFile(uri: vscode.Uri): Promise<SketchScene> {
    if (uri.scheme === 'untitled') {
      return emptyScene();
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8').trim();
      if (!text) {
        return emptyScene();
      }
      const parsed = JSON.parse(text);
      return { elements: parsed.elements ?? [], appState: parsed.appState ?? {} };
    } catch {
      return emptyScene();
    }
  }

  private readonly _uri: vscode.Uri;
  private _scene: SketchScene;
  private _edits: SketchEdit[] = [];
  private _savedSceneJson: string;

  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  private readonly _onDidChangeDocument = new vscode.EventEmitter<{
    readonly label: string;
    undo(): void;
    redo(): void;
  }>();
  public readonly onDidChangeContent = this._onDidChangeDocument.event;

  private readonly _onDidChangeSceneForWebview = new vscode.EventEmitter<SketchScene>();
  public readonly onDidChangeSceneForWebview = this._onDidChangeSceneForWebview.event;

  private constructor(uri: vscode.Uri, scene: SketchScene) {
    this._uri = uri;
    this._scene = scene;
    this._savedSceneJson = JSON.stringify(scene);
  }

  public get uri(): vscode.Uri {
    return this._uri;
  }

  public get scene(): SketchScene {
    return this._scene;
  }

  public get isDirty(): boolean {
    return JSON.stringify(this._scene) !== this._savedSceneJson;
  }

  dispose(): void {
    this._onDidDispose.fire();
  }

  /** Called when the webview reports a completed change (mouse-up after a draw/move/etc). */
  makeEdit(newScene: SketchScene, label = 'Edit'): void {
    const before = this._scene;
    const after = newScene;
    this._scene = after;
    this._edits.push({ label, before, after });

    this._onDidChangeDocument.fire({
      label,
      undo: () => {
        this._scene = before;
        this._onDidChangeSceneForWebview.fire(this._scene);
      },
      redo: () => {
        this._scene = after;
        this._onDidChangeSceneForWebview.fire(this._scene);
      }
    });
  }

  async save(cancellation: vscode.CancellationToken): Promise<void> {
    await this.saveAs(this._uri, cancellation);
    this._savedSceneJson = JSON.stringify(this._scene);
  }

  async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    const json = JSON.stringify(this._scene, null, 2);
    if (cancellation.isCancellationRequested) {
      return;
    }
    await vscode.workspace.fs.writeFile(targetResource, Buffer.from(json, 'utf8'));
  }

  async revert(): Promise<void> {
    const scene = await SketchDocument.readFile(this._uri);
    this._scene = scene;
    this._savedSceneJson = JSON.stringify(scene);
    this._onDidChangeSceneForWebview.fire(scene);
  }

  async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    await this.saveAs(destination, cancellation);
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // ignore
        }
      }
    };
  }
}
