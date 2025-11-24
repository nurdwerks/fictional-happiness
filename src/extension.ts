import * as vscode from 'vscode';
import { GitService } from './extension/gitService';
import { CollaborationClient } from './extension/client';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	console.log('Collab Code is active!');

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const gitService = new GitService(rootPath);

	const provider = new CollabViewProvider(context.extensionUri, context, gitService);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CollabViewProvider.viewType, provider)
	);
}

class CollabViewProvider implements vscode.WebviewViewProvider {

	public static readonly viewType = 'collabCodeView';
	private _view?: vscode.WebviewView;
    private client?: CollaborationClient;

	constructor(
		private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        private readonly _gitService: GitService
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

        // Initialize Client
        this.client = new CollaborationClient(this._context, { webview: webviewView.webview } as any, this._gitService);
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

export function deactivate() {}
