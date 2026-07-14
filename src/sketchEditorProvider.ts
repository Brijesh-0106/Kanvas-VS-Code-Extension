import * as vscode from 'vscode';
import { SketchDocument, SketchScene } from './sketchDocument';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class SketchEditorProvider implements vscode.CustomEditorProvider<SketchDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new SketchEditorProvider(context);
    const registration = vscode.window.registerCustomEditorProvider(
      SketchEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );

    const exportPng = vscode.commands.registerCommand('sketchEditor.exportPng', () => {
      provider.requestExport('png');
    });
    const exportSvg = vscode.commands.registerCommand('sketchEditor.exportSvg', () => {
      provider.requestExport('svg');
    });
    const newSketch = vscode.commands.registerCommand('sketchEditor.new', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: ''
      });
      // Prompt for a save location so it gets a .sketch extension, then open with our editor.
      const target = await vscode.window.showSaveDialog({
        filters: { Sketch: ['sketch'] },
        saveLabel: 'Create Sketch'
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify({ elements: [], appState: {} }, null, 2), 'utf8'));
      await vscode.commands.executeCommand('vscode.openWith', target, SketchEditorProvider.viewType);
    });

    return vscode.Disposable.from(registration, exportPng, exportSvg, newSketch);
  }

  private static readonly viewType = 'sketchEditor.canvas';

  private activeWebviewPanel: vscode.WebviewPanel | undefined;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SketchDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<SketchDocument> {
    const document = await SketchDocument.create(uri, openContext.backupId);

    document.onDidChangeContent(e => {
      this._onDidChangeCustomDocument.fire({
        document,
        label: e.label,
        undo: e.undo,
        redo: e.redo
      });
    });

    document.onDidChangeSceneForWebview(scene => {
      this.postMessage({ type: 'sceneUpdate', body: scene });
    });

    return document;
  }

  async resolveCustomEditor(
    document: SketchDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.activeWebviewPanel = webviewPanel;
    webviewPanel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) {
        this.activeWebviewPanel = e.webviewPanel;
      }
    });

    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          this.post(webviewPanel, { type: 'init', body: document.scene });
          break;
        }
        case 'edit': {
          const scene: SketchScene = msg.body;
          document.makeEdit(scene, msg.label ?? 'Edit');
          break;
        }
        case 'exportResult': {
          await this.handleExportResult(msg.body);
          break;
        }
        case 'requestUndo': {
          await vscode.commands.executeCommand('undo');
          break;
        }
        case 'requestRedo': {
          await vscode.commands.executeCommand('redo');
          break;
        }
      }
    });
  }

  async saveCustomDocument(document: SketchDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await document.save(cancellation);
  }

  async saveCustomDocumentAs(document: SketchDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    await document.saveAs(destination, cancellation);
  }

  async revertCustomDocument(document: SketchDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    await document.revert();
  }

  async backupCustomDocument(
    document: SketchDocument,
    context: vscode.CustomDocumentBackupContext,
    cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation);
  }

  private post(panel: vscode.WebviewPanel, message: unknown) {
    panel.webview.postMessage(message);
  }

  private postMessage(message: unknown) {
    if (this.activeWebviewPanel) {
      this.activeWebviewPanel.webview.postMessage(message);
    }
  }

  private requestExport(format: 'png' | 'svg') {
    if (!this.activeWebviewPanel) {
      vscode.window.showWarningMessage('Open a .sketch file first.');
      return;
    }
    this.post(this.activeWebviewPanel, { type: 'requestExport', body: { format } });
  }

  private async handleExportResult(body: { format: 'png' | 'svg'; data: string }) {
    const { format, data } = body;
    const filters: { [name: string]: string[] } =
      format === 'png' ? { Images: ['png'] } : { 'SVG Files': ['svg'] };
    const target = await vscode.window.showSaveDialog({ filters, saveLabel: 'Export' });
    if (!target) {
      return;
    }
    if (format === 'png') {
      const base64 = data.replace(/^data:image\/png;base64,/, '');
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
    } else {
      await vscode.workspace.fs.writeFile(target, Buffer.from(data, 'utf8'));
    }
    vscode.window.showInformationMessage(`Exported ${format.toUpperCase()} to ${target.fsPath}`);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css'));
    const roughUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'rough.js'));
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Sketch</title>
</head>
<body>
  <div id="toolbar">
    <button data-tool="selection" class="tool-btn active" title="Select (V)">&#9995;</button>
    <button data-tool="rectangle" class="tool-btn" title="Rectangle (R)">&#9634;</button>
    <button data-tool="ellipse" class="tool-btn" title="Ellipse (O)">&#9711;</button>
    <button data-tool="diamond" class="tool-btn" title="Diamond (D)">&#9670;</button>
    <button data-tool="arrow" class="tool-btn" title="Arrow (A)">&#8594;</button>
    <button data-tool="line" class="tool-btn" title="Line (L)">&#9585;</button>
    <button data-tool="draw" class="tool-btn" title="Freehand (P)">&#9998;</button>
    <button data-tool="text" class="tool-btn" title="Text (T)">T</button>
    <button data-tool="eraser" class="tool-btn" title="Eraser (E)">&#9003;</button>
    <span class="sep"></span>
    <button id="undoBtn" title="Undo (Ctrl+Z)">&#8630;</button>
    <button id="redoBtn" title="Redo (Ctrl+Y)">&#8631;</button>
    <span class="sep"></span>
    <input type="color" id="strokeColor" value="#e9e9e9" title="Stroke color" />
    <input type="color" id="fillColor" value="#00000000" title="Fill color" />
    <select id="strokeWidth" title="Stroke width">
      <option value="1">Thin</option>
      <option value="2" selected>Medium</option>
      <option value="4">Thick</option>
    </select>
    <span class="sep"></span>
    <button id="deleteBtn" title="Delete selected (Del)">&#128465;</button>
  </div>
  <div id="canvas-wrap">
    <canvas id="sketchCanvas"></canvas>
    <textarea id="textInput" spellcheck="false"></textarea>
  </div>
  <script nonce="${nonce}" src="${roughUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
