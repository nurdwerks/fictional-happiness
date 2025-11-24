import * as vscode from 'vscode';
import { GitService } from './extension/gitService';
import { CollaborationClient } from './extension/client';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	console.log('Collab Code is active!');

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const gitService = new GitService(rootPath);

    // Initialize Client immediately to start server
    const client = new CollaborationClient(context, gitService);

	const provider = new CollabViewProvider(context.extensionUri, context, gitService, client);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CollabViewProvider.viewType, provider)
	);

    // If auto-join file exists, force open the view
    if (rootPath) {
        const joinFile = path.join(rootPath, '.collab-join.json');
        const fs = require('fs');
        if (fs.existsSync(joinFile)) {
            vscode.commands.executeCommand('collabCodeView.focus');
            // Check for auto-join
            checkForAutoJoin(client);
        }
    }
}

function checkForAutoJoin(client: CollaborationClient) {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) { return; }

    const joinFile = path.join(rootPath, '.collab-join.json');
    const fs = require('fs');
    if (fs.existsSync(joinFile)) {
            try {
                const content = JSON.parse(fs.readFileSync(joinFile, 'utf8'));
                if (content.autoJoin && content.address) {
                    setTimeout(() => {
                    client.connect(content.address);
                    }, 1000);
                }
            } catch (e) {
                console.error("Failed to read auto-join config", e);
            }
    }
}


class CollabViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'collabCodeView';
	private _view?: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        private readonly _gitService: GitService,
        private readonly _client: CollaborationClient
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri
			]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Update Client with Webview
        this._client.updateWebview(webviewView as any); // Type cast due to minor mismatch in interface if any, or just WebviewView vs WebviewPanel.
        // Note: Client expects WebviewPanel (has .webview), WebviewView also has .webview.
        // Client.updateWebview arg type should be compatible or adjusted.
        // In client.ts I typed it as WebviewPanel, but it mostly uses .webview.
        // Actually WebviewView doesn't have all properties of WebviewPanel but it has webview.
        // Let's check client.ts usage. It uses `webviewPanel.webview.postMessage`.
        // So `{ webview: webviewView.webview }` object would suffice if type allows.
        // I will pass `webviewView` but I might need to cast it or adjust client.ts type.
        // `webviewView` matches `{ webview: vscode.Webview }`.
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js'));

        // Read the HTML file from the 'dist' folder where it is copied during build
        const fs = require('fs');
        const htmlFilePath = path.join(this._extensionUri.fsPath, 'dist', 'index.html');

        let htmlContent = "";
        try {
             htmlContent = fs.readFileSync(htmlFilePath, 'utf8');
        } catch (e) {
            console.error("Failed to load HTML from dist:", e);
            htmlContent = `<html><body>Error loading HTML: ${(e as any).message}</body></html>`;
        }

        // Replace script src
        htmlContent = htmlContent.replace('src="webview.js"', `src="${scriptUri}"`);

		return htmlContent;
	}
}

export function deactivate() {
    // Cleanup temp dir if auto-join
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (rootPath) {
        const joinFile = path.join(rootPath, '.collab-join.json');
        const fs = require('fs');
        if (fs.existsSync(joinFile)) {
             try {
                 // If we are in a temp dir created by us (starts with collab-code-)
                 // and contains .collab-join.json
                 if (path.basename(rootPath).startsWith('collab-code-')) {
                     // Try to delete the directory.
                     // Note: VS Code might still have a lock, but we can try deleting files.
                     fs.rmSync(rootPath, { recursive: true, force: true });
                 }
             } catch (e) {
                 console.error("Failed to cleanup temp dir", e);
             }
        }
    }
}
