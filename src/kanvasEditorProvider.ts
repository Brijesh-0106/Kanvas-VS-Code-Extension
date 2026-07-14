import * as vscode from 'vscode';
import { KanvasDocument, KanvasScene } from './kanvasDocument';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class KanvasEditorProvider implements vscode.CustomEditorProvider<KanvasDocument> {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new KanvasEditorProvider(context);
    const registration = vscode.window.registerCustomEditorProvider(
      KanvasEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );

    const exportPng = vscode.commands.registerCommand('kanvas.exportPng', () => {
      provider.requestExport('png');
    });
    const exportSvg = vscode.commands.registerCommand('kanvas.exportSvg', () => {
      provider.requestExport('svg');
    });
    const newKanvas = vscode.commands.registerCommand('kanvas.new', async () => {
      const target = await vscode.window.showSaveDialog({
        filters: { Kanvas: ['kanvas'] },
        saveLabel: 'Create Kanvas'
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify({ elements: [], appState: {} }, null, 2), 'utf8'));
      await vscode.commands.executeCommand('vscode.openWith', target, KanvasEditorProvider.viewType);
    });

    return vscode.Disposable.from(registration, exportPng, exportSvg, newKanvas);
  }

  private static readonly viewType = 'kanvas.canvas';

  private activeWebviewPanel: vscode.WebviewPanel | undefined;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<KanvasDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<KanvasDocument> {
    const document = await KanvasDocument.create(uri, openContext.backupId);

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
    document: KanvasDocument,
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
          const scene: KanvasScene = msg.body;
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

  async saveCustomDocument(document: KanvasDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await document.save(cancellation);
  }

  async saveCustomDocumentAs(document: KanvasDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    await document.saveAs(destination, cancellation);
  }

  async revertCustomDocument(document: KanvasDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    await document.revert();
  }

  async backupCustomDocument(
    document: KanvasDocument,
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
      vscode.window.showWarningMessage('Open a .kanvas file first.');
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
  <title>Kanvas</title>
</head>
<body>
  <div id="container">
    <!-- Top central toolbar for tool selection -->
    <div id="toolbar">
      <div class="tool-group">
        <button data-tool="selection" class="tool-btn active" title="Select (V)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l3.057 15.657a.5.5 0 0 0 .914.156l3.393-5.817 6.136 3.1a.5.5 0 0 0 .666-.665l-3.1-6.136 5.817-3.393a.5.5 0 0 0-.156-.914L5 3z"/></svg>
        </button>
        <button data-tool="rectangle" class="tool-btn" title="Rectangle (R)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
        </button>
        <button data-tool="ellipse" class="tool-btn" title="Ellipse (O)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
        </button>
        <button data-tool="diamond" class="tool-btn" title="Diamond (D)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2"><path d="M12 2L2 12l10 10 10-10z"/></svg>
        </button>
        <button data-tool="arrow" class="tool-btn" title="Arrow (A)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </button>
        <button data-tool="line" class="tool-btn" title="Line (L)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>
        </button>
        <button data-tool="draw" class="tool-btn" title="Freehand (P)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button data-tool="text" class="tool-btn" title="Text (T)">
          <span style="font-weight: bold; font-size: 16px;">T</span>
        </button>
        <button data-tool="image" class="tool-btn" title="Image (I)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
        </button>
        <button data-tool="eraser" class="tool-btn" title="Eraser (E)">
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 20H7L3 16C2 15 2 13 3 12L13 2L22 11L20 20Z"/>
            <path d="M17 17H22"/>
            <circle cx="18" cy="18" r="2" />
          </svg>
        </button>
      </div>
      <span class="sep"></span>
      <div class="history-group">
        <button id="toggleStylePanelBtn" title="Toggle Styles (S)" class="active">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 14.7255 3.09032 17.1962 4.85857 19C5.03345 20.2592 6.0468 21.2827 7.30722 21.4396C7.76077 21.496 8.21957 21.3643 8.57245 21.0772C8.94825 21.6575 9.59345 22 10.3204 22H12Z"/><circle cx="7.5" cy="10.5" r="1.5" fill="currentColor"/><circle cx="11.5" cy="7.5" r="1.5" fill="currentColor"/><circle cx="16.5" cy="9.5" r="1.5" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1.5" fill="currentColor"/></svg>
        </button>
        <span class="sep" style="height: 18px; margin: 0 4px; align-self: center;"></span>
        <button id="undoBtn" title="Undo (Ctrl+Z)">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
        </button>
        <button id="redoBtn" title="Redo (Ctrl+Y)">
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></svg>
        </button>
      </div>
    </div>

    <!-- Left side style options panel -->
    <div id="style-panel" class="floating-panel visible">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.8;">Styles</h3>
        <button id="closeStylePanelBtn" title="Close Styles" style="background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; border-radius: 6px; transition: all 0.15s ease;">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      
      <div class="panel-section">
        <label>Stroke Color</label>
        <div class="color-palette" id="stroke-palette">
          <button class="color-swatch active" data-color="#ffffff" style="background-color: #ffffff; border: 1px solid #666;" title="White"></button>
          <button class="color-swatch" data-color="#e03131" style="background-color: #e03131;" title="Red"></button>
          <button class="color-swatch" data-color="#2f9e44" style="background-color: #2f9e44;" title="Green"></button>
          <button class="color-swatch" data-color="#1971c2" style="background-color: #1971c2;" title="Blue"></button>
          <button class="color-swatch" data-color="#f08c00" style="background-color: #f08c00;" title="Yellow"></button>
          <button class="color-swatch" data-color="#9c36b5" style="background-color: #9c36b5;" title="Purple"></button>
          <div class="custom-color-container">
            <input type="color" id="strokeColor" value="#ffffff" title="Custom Stroke Color" />
          </div>
        </div>
      </div>

      <div class="panel-section">
        <label>Fill Color</label>
        <div class="color-palette" id="fill-palette">
          <button class="color-swatch active" data-color="transparent" style="background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 8px 8px; background-position: 0 0, 0 4px, 4px -4px, -4px 0px; border: 1px solid #666;" title="Transparent"></button>
          <button class="color-swatch" data-color="rgba(224, 49, 49, 0.2)" style="background-color: rgba(224, 49, 49, 0.45);" title="Red Tint"></button>
          <button class="color-swatch" data-color="rgba(47, 158, 68, 0.2)" style="background-color: rgba(47, 158, 68, 0.45);" title="Green Tint"></button>
          <button class="color-swatch" data-color="rgba(25, 113, 194, 0.2)" style="background-color: rgba(25, 113, 194, 0.45);" title="Blue Tint"></button>
          <button class="color-swatch" data-color="rgba(240, 140, 0, 0.2)" style="background-color: rgba(240, 140, 0, 0.45);" title="Yellow Tint"></button>
          <button class="color-swatch" data-color="rgba(156, 54, 181, 0.2)" style="background-color: rgba(156, 54, 181, 0.45);" title="Purple Tint"></button>
          <div class="custom-color-container">
            <input type="color" id="fillColor" value="#000000" title="Custom Fill Color" />
          </div>
        </div>
      </div>

      <div class="panel-section">
        <label>Stroke Width</label>
        <div class="toggle-group" id="stroke-width-group">
          <button data-val="1" class="toggle-btn" title="Thin">Thin</button>
          <button data-val="2" class="toggle-btn active" title="Medium">Medium</button>
          <button data-val="4" class="toggle-btn" title="Thick">Thick</button>
        </div>
      </div>

      <div class="panel-section">
        <label>Stroke Style</label>
        <div class="toggle-group" id="stroke-style-group">
          <button data-val="solid" class="toggle-btn active" title="Solid">Solid</button>
          <button data-val="dashed" class="toggle-btn" title="Dashed">Dashed</button>
          <button data-val="dotted" class="toggle-btn" title="Dotted">Dotted</button>
        </div>
      </div>

      <div class="panel-section">
        <label>Fill Style</label>
        <div class="toggle-group" id="fill-style-group">
          <button data-val="hachure" class="toggle-btn active" title="Hachure">Hachure</button>
          <button data-val="cross-hatch" class="toggle-btn" title="Cross-Hatch">Cross</button>
          <button data-val="solid" class="toggle-btn" title="Solid">Solid</button>
        </div>
      </div>

      <div class="panel-section">
        <label>Sloppiness</label>
        <div class="toggle-group" id="sloppiness-group">
          <button data-val="0.5" class="toggle-btn" title="Neat">Neat</button>
          <button data-val="1.5" class="toggle-btn active" title="Artist">Artist</button>
          <button data-val="3.0" class="toggle-btn" title="Cartoon">Cartoon</button>
        </div>
      </div>

      <div class="panel-section brush-section" style="display: none;">
        <label>Brush Type</label>
        <div class="toggle-group" id="brush-type-group">
          <button data-val="pencil" class="toggle-btn active" title="Pencil">Pencil</button>
          <button data-val="highlighter" class="toggle-btn" title="Highlighter">Highlight</button>
        </div>
      </div>

      <div class="panel-section font-section" style="display: none;">
        <label>Font Family</label>
        <div class="toggle-group" id="font-family-group">
          <button data-val="handwritten" class="toggle-btn active" title="Handwritten">Hand</button>
          <button data-val="sans-serif" class="toggle-btn" title="Normal">Normal</button>
          <button data-val="monospace" class="toggle-btn" title="Code">Code</button>
        </div>
      </div>

      <div class="panel-section actions-section">
        <label>Layers / Actions</label>
        <div class="action-buttons">
          <button id="sendBackBtn" class="action-btn" title="Send to back (Ctrl+[)">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg> Back
          </button>
          <button id="bringFrontBtn" class="action-btn" title="Bring to front (Ctrl+])">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" style="stroke-dasharray: 3,3;"/><path d="M12 7L2 12l10 5 10-5-10-5z"/></svg> Front
          </button>
          <button id="deleteBtn" class="action-btn danger" title="Delete selected (Del)">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> Delete
          </button>
        </div>
      </div>
    </div>

    <!-- Bottom Left Logo & Help info -->
    <div id="brand-info">
      <div class="logo">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: middle;"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.52285 22 12 22Z"/><path d="M12 8L16 12L12 16L8 12Z" fill="currentColor"/></svg>
        <span>Kanvas</span>
      </div>
    </div>

    <!-- Bottom Right controls: Zoom and Grid -->
    <div id="canvas-controls">
      <button id="zoomOutBtn" class="control-btn" title="Zoom Out (Ctrl+-)">-</button>
      <span id="zoomVal">100%</span>
      <button id="zoomInBtn" class="control-btn" title="Zoom In (Ctrl+=)">+</button>
      <span class="sep"></span>
      <button id="gridToggleBtn" class="control-btn active" title="Toggle Grid (G)">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
      </button>
      <button id="clearAllBtn" class="control-btn danger" title="Clear Canvas">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
      </button>
    </div>

    <!-- Canvas area -->
    <div id="canvas-wrap">
      <canvas id="kanvasCanvas"></canvas>
      <textarea id="textInput" spellcheck="false"></textarea>
      <input type="file" id="imageLoader" accept="image/*" style="display: none;" />
    </div>
  </div>

  <script nonce="${nonce}" src="${roughUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
