import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { GitService } from './gitService';
import {
    MessageType, BaseMessage, JoinMessage, TextOperationMessage,
    CursorSelectionMessage, WebRTCSignalMessage, FileCreateMessage,
    FileInitMessage, FileDeleteMessage, ChatMessage, FollowUserMessage,
    TerminalDataMessage, ApproveRequestMessage, RejectRequestMessage, KickUserMessage
} from '../common/messages';
import { CollaborationServer } from '../server/server';

const otText = require('ot-text');

export class CollaborationClient {
    private ws: WebSocket | undefined;
    private decorationType: vscode.TextEditorDecorationType;
    private myUsername: string | undefined;
    private server: CollaborationServer | undefined; // If running locally

    // Tracking remote cursors
    private remoteCursors: Map<string, vscode.TextEditorDecorationType> = new Map();
    private cursorDecorations: Map<string, Map<string, vscode.TextEditorDecorationType>> = new Map(); // file -> sessionId -> decoration

    // Shadow copies for OT: Map<filepath, content>
    private shadows: Map<string, string> = new Map();

    // OT State Tracking
    private revisions: Map<string, number> = new Map(); // filepath -> server version
    private pendingOps: Map<string, any[][]> = new Map(); // filepath -> queue of ops (buffer)
    private inFlightOps: Map<string, any[]> = new Map(); // filepath -> op currently sent (awaiting ack)

    // To prevent loops when applying remote ops
    private isApplyingRemoteOp = false;

    // Session ID (assigned by server)
    private sessionId: string | undefined;

    // Follow Mode
    private followingSessionId: string | null = null;

    private webviewReadyPromise: Promise<void>;
    private resolveWebviewReady!: () => void;

    constructor(
        private context: vscode.ExtensionContext,
        private webviewPanel: vscode.WebviewPanel,
        private gitService: GitService
    ) {
        this.webviewReadyPromise = new Promise((resolve) => {
            this.resolveWebviewReady = resolve;
        });

        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255,0,0,0.3)',
            border: '1px solid red'
        });

        this.registerWebviewListeners();
        this.registerEditorListeners();
        this.initializeOpenEditors();

        // Send initial identity to webview
        this.sendIdentity();

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('collabCode')) {
                this.sendIdentity();
            }
        });
    }

    private async sendIdentity() {
        await this.webviewReadyPromise;
        // Also send configuration
        const config = vscode.workspace.getConfiguration('collabCode');
        const iceServers = config.get('stunServers') || ["stun:stun.l.google.com:19302"];
        const defaultPort = config.get('defaultPort') || 3000;
        const configUsername = config.get('username') as string;

        if (configUsername) {
            this.myUsername = configUsername;
            this.webviewPanel.webview.postMessage({
                type: 'identity',
                username: this.myUsername,
                iceServers: iceServers,
                defaultPort: defaultPort
            });
        } else {
            this.gitService.getUserName().then(name => {
                this.myUsername = name;
                this.webviewPanel.webview.postMessage({
                    type: 'identity',
                    username: name,
                    iceServers: iceServers,
                    defaultPort: defaultPort
                });
            });
        }
    }

    private registerWebviewListeners() {
        this.webviewPanel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'ready':
                    this.resolveWebviewReady();
                    break;
                case 'startServer':
                    await this.startLocalServer(message.port);
                    this.connect(`ws://localhost:${message.port}`);
                    break;
                case 'joinServer':
                    this.handleJoinRequest(message.address);
                    break;
                case 'disconnect':
                    this.disconnect();
                    break;
                case 'webrtc-signal':
                    this.send({
                        type: 'webrtc-signal',
                        signal: message.signal,
                        targetSessionId: message.targetSessionId
                    } as WebRTCSignalMessage);
                    break;
                case 'chat-message':
                    this.send({
                        type: 'chat-message',
                        text: message.text
                    } as ChatMessage);
                    break;
                case 'openReference':
                    this.handleOpenReference(message.file, message.startLine, message.endLine);
                    break;
                case 'follow-user':
                    this.followingSessionId = message.targetSessionId;
                    if (this.followingSessionId) {
                         vscode.window.showInformationMessage(`Following user session: ${this.followingSessionId}`);
                    } else {
                         vscode.window.showInformationMessage(`Stopped following user.`);
                    }
                    break;
                case 'approve-request':
                    this.send({
                        type: 'approve-request',
                        targetSessionId: message.targetSessionId
                    } as ApproveRequestMessage);
                    break;
                case 'reject-request':
                    this.send({
                        type: 'reject-request',
                        targetSessionId: message.targetSessionId
                    } as RejectRequestMessage);
                    break;
                case 'kick-user':
                    this.send({
                        type: 'kick-user',
                        targetSessionId: message.targetSessionId
                    } as KickUserMessage);
                    break;
            }
        });

        // Register Command to add reference
        this.context.subscriptions.push(
            vscode.commands.registerCommand('collabCode.addReference', () => {
                 this.handleAddReference();
            })
        );
    }

    private initializeOpenEditors() {
        vscode.window.visibleTextEditors.forEach(editor => {
            const doc = editor.document;
            if (doc.uri.scheme === 'file') {
                const filePath = vscode.workspace.asRelativePath(doc.uri);
                if (!this.shadows.has(filePath)) {
                     this.shadows.set(filePath, doc.getText());
                }
            }
        });
    }

    private registerEditorListeners() {
        // Init Shadow on Open
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.uri.scheme === 'file' && !this.shadows.has(vscode.workspace.asRelativePath(doc.uri))) {
                this.shadows.set(vscode.workspace.asRelativePath(doc.uri), doc.getText());
            }
        });

        // Text Changes
        vscode.workspace.onDidChangeTextDocument(event => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {return;}
            if (this.isApplyingRemoteOp) {return;}
            if (event.document.uri.scheme !== 'file') {return;}
            if (this.gitService.isIgnored(event.document.fileName)) {return;}

            // Guest: Do not send changes to .gitignore
            if (!this.server && path.basename(event.document.fileName) === '.gitignore') {
                return;
            }

            const filePath = vscode.workspace.asRelativePath(event.document.uri);

            // Ensure shadow exists
            if (!this.shadows.has(filePath)) {
                // If we don't have a shadow, we must initialize it from current state?
                // But current state includes the change...
                // We should have caught it on Open.
                // Fallback: Assume the document was empty? No, that breaks OT.
                // We'll just reset shadow to current and skip this event (loss of sync for this op)
                this.shadows.set(filePath, event.document.getText());
                return;
            }

            let shadow = this.shadows.get(filePath)!;

            // Generate Ops
            // VS Code events are lists of changes. We must process them sequentially against the shadow.

            // To simplify concurrency, if we have a pending op, we really should buffer.
            // But implementing full OT Client logic (Buffer/Transform) is complex.
            // Simplified "Stop-and-Wait":
            // If we have pending ops, we technically shouldn't send.
            // But user keeps typing.
            // We MUST update our shadow immediately to match the editor.
            // We MUST send operations that are relative to the *current* shadow (which includes pending).
            // Server needs to know the base version.

            // Refined Logic:
            // 1. We assume optimistic UI.
            // 2. We track the 'revision' (last acked server version).
            // 3. When we send an op, we send 'revision'.
            // 4. Server transforms it.
            // 5. Server sends back the transformed op (or ack).
            // 6. Wait, if we send op1 (base 0), then op2 (base 0 - because no ack yet),
            //    Server receives op1. Accepts. Version becomes 1.
            //    Server receives op2. Sees base 0. Transforms op2 against op1.
            //    This is standard Server-side OT!

            // SO: We just need to send the CORRECT base revision.
            event.contentChanges.forEach(change => {
                const op = this.generateOp(shadow, change);

                // Update Shadow immediately (Optimistic)
                shadow = otText.type.apply(shadow, op);
                this.shadows.set(filePath, shadow);

                if (!this.pendingOps.has(filePath)) {
                    this.pendingOps.set(filePath, []);
                }
                const buffer = this.pendingOps.get(filePath)!;

                buffer.push(op);
                this.flushPendingOps(filePath);
            });
        });

        // Selection Changes
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {return;}
            if (event.textEditor.document.uri.scheme !== 'file') {return;}

            const selection = event.selections[0];
            const msg: CursorSelectionMessage = {
                type: 'cursor-selection',
                file: vscode.workspace.asRelativePath(event.textEditor.document.uri),
                start: event.textEditor.document.offsetAt(selection.start),
                end: event.textEditor.document.offsetAt(selection.end)
            };
            this.send(msg);
        });

        // File Creation
        vscode.workspace.onDidCreateFiles(event => {
            if (!this.ws) {return;}
            event.files.forEach(async uri => {
                if (this.gitService.isIgnored(uri.fsPath)) {return;}
                if (!this.server && path.basename(uri.fsPath) === '.gitignore') {return;} // Guest check
                const content = await vscode.workspace.fs.readFile(uri);
                const strContent = new TextDecoder().decode(content);

                this.shadows.set(vscode.workspace.asRelativePath(uri), strContent);

                const msg: FileCreateMessage = {
                    type: 'file-create',
                    file: vscode.workspace.asRelativePath(uri),
                    content: strContent
                };
                this.send(msg);
            });
        });

         // File Deletion
        vscode.workspace.onDidDeleteFiles(event => {
             if (!this.ws) {return;}
             event.files.forEach(uri => {
                 if (!this.server && path.basename(uri.fsPath) === '.gitignore') {return;} // Guest check
                 this.shadows.delete(vscode.workspace.asRelativePath(uri));
                 const msg: FileDeleteMessage = {
                     type: 'file-delete',
                     file: vscode.workspace.asRelativePath(uri)
                 };
                 this.send(msg);
             });
        });

        // Listen for Shared Command
        this.context.subscriptions.push(
            vscode.commands.registerCommand('collabCode.runSharedCommand', async () => {
                 if (!this.server) {
                     vscode.window.showErrorMessage("Only the host can run shared commands.");
                     return;
                 }
                 const cmd = await vscode.window.showInputBox({ prompt: "Enter command to run and share output" });
                 if (cmd) {
                     this.runSharedCommand(cmd);
                 }
            })
        );

        // Prevent guests from editing .gitignore
        vscode.workspace.onWillSaveTextDocument(event => {
            if (!this.server && path.basename(event.document.fileName) === '.gitignore') {
                event.waitUntil(Promise.reject(new Error("Guests cannot edit .gitignore")));
            }
        });

        vscode.workspace.onWillDeleteFiles(event => {
            if (!this.server) {
                event.files.forEach(uri => {
                    if (path.basename(uri.fsPath) === '.gitignore') {
                        event.waitUntil(Promise.reject(new Error("Guests cannot delete .gitignore")));
                    }
                });
            }
        });

        vscode.workspace.onWillRenameFiles(event => {
            if (!this.server) {
                event.files.forEach(f => {
                    if (path.basename(f.oldUri.fsPath) === '.gitignore') {
                        event.waitUntil(Promise.reject(new Error("Guests cannot rename .gitignore")));
                    }
                });
            }
        });
    }

    private async handleJoinRequest(address: string) {
        try {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-code-'));
            const joinConfig = {
                address: address,
                autoJoin: true
            };
            fs.writeFileSync(path.join(tempDir, '.collab-join.json'), JSON.stringify(joinConfig, null, 2));
            const uri = vscode.Uri.file(tempDir);
            await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to launch new window: ${(e as any).message}`);
        }
    }

    private runSharedCommand(command: string) {
        // Double check
        if (!this.server) { return; }

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return; }

        this.sendTerminalData(`> ${command}\n`);

        // Use spawn to support streaming
        // We need to parse command string roughly to split args for spawn, or use shell: true
        // shell: true is simpler for arbitrary commands
        const process = cp.spawn(command, [], { cwd: rootPath, shell: true });

        process.stdout.on('data', (data) => {
            this.sendTerminalData(data.toString());
        });

        process.stderr.on('data', (data) => {
            this.sendTerminalData(data.toString());
        });

        process.on('error', (err) => {
             this.sendTerminalData(`Error: ${err.message}\n`);
        });

        process.on('close', (code) => {
             this.sendTerminalData(`\nProcess exited with code ${code}\n`);
        });
    }

    private sendTerminalData(data: string) {
        const msg: TerminalDataMessage = {
            type: 'terminal-data',
            termId: 'shared-1', // simplified
            data: data
        };
        this.send(msg);
        // Also show locally
        this.webviewPanel.webview.postMessage(msg);
    }

    private generateOp(shadow: string, change: vscode.TextDocumentContentChangeEvent): any[] {
        // change.rangeOffset is the index in the *original* document (shadow).
        // change.rangeLength is the length of text removed.
        // change.text is the text inserted.

        const ops = [];

        // 1. Retain up to offset
        if (change.rangeOffset > 0) {
            ops.push(change.rangeOffset);
        }

        // 2. Delete (if rangeLength > 0)
        if (change.rangeLength > 0) {
            // We must extract the text to be deleted from the shadow
            const deletedText = shadow.substring(change.rangeOffset, change.rangeOffset + change.rangeLength);
            ops.push({ d: deletedText }); // ot-text format for delete is {d: "str"} or "str" (wait, check type)
            // ot-text spec:
            // Insert: "string"
            // Delete: { d: "string" } (This is ShareJS/json0 style? No, ot-text is specific)
            // Let's verify ot-text standard.
            // Actually `ot-text` package exports `type`.
            // Standard ot-text ops: [ 'retain', 5, 'insert', 'abc', 'delete', 3 ] -> No.
            // Documentation says:
            // [ 5, "abc", { d: "def" } ]
            // integer: retain
            // string: insert
            // object with 'd': delete
        }

        // 3. Insert
        if (change.text.length > 0) {
            ops.push(change.text);
        }

        // 4. Retain remainder
        const endOffset = change.rangeOffset + change.rangeLength;
        const remainder = shadow.length - endOffset;
        if (remainder > 0) {
            ops.push(remainder);
        }

        return ops;
    }

    private async startLocalServer(port: number) {
        this.server = new CollaborationServer(undefined, port);
        this.server.onClientApproved = (targetSessionId) => {
            this.syncWorkspaceToClient(targetSessionId);
        };
    }

    private async syncWorkspaceToClient(targetSessionId: string) {
        // Walk workspace and send all files
        // Use GitService to filter? workspace.findFiles respects .gitignore if we use exclude param?
        // vscode.workspace.findFiles(include, exclude)
        // If we just use findFiles('**/*'), it generally respects .gitignore if useIgnoreFiles is true (default)
        // But we can also double check with gitService.

        const files = await vscode.workspace.findFiles('**/*');
        for (const uri of files) {
            if (this.gitService.isIgnored(uri.fsPath)) { continue; }

            // Read content
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const strContent = new TextDecoder().decode(content);

                // Send directly to that client via server?
                // Server doesn't expose "sendToClient".
                // We need to send a message to the server saying "Send this to X".
                // OR, we just use 'file-init' and the server broadcasts it?
                // If we broadcast, everyone gets it. Not bad, but wasteful.
                // If we want to target, we need a Target field in BaseMessage?
                // Or we can add a method to Server to send to specific client.
                // Since we have reference to `this.server`, we can call `this.server.sendToClient(...)` if we implement it.
                // But `CollaborationServer` is in `server.ts`.

                if (this.server) {
                    const msg: FileInitMessage = {
                        type: 'file-init',
                        file: vscode.workspace.asRelativePath(uri),
                        content: strContent,
                        version: 0
                    };
                    this.server.sendToClient(targetSessionId, msg);
                }
            } catch (e) {
                console.error(`Failed to sync file ${uri.fsPath}`, e);
            }
        }
    }

    public async connect(address: string) {
        // Wait for webview before connecting, or at least before updating UI?
        // Actually we can connect WS immediately, but we shouldn't post messages to webview until ready.
        // However, if we connect now, we might receive 'open' event before webview is ready.
        await this.webviewReadyPromise;

        this.ws = new WebSocket(address);

        this.ws.on('open', () => {
            this.webviewPanel.webview.postMessage({ type: 'connected' });

            // Send Join
            const joinMsg: JoinMessage = {
                type: 'join',
                username: this.myUsername || 'Anonymous'
            };
            this.send(joinMsg);

            // We don't have a specific 'welcome' message to assign sessionId in this simple protocol,
            // but usually the server sends something back or we generate it.
            // Wait, looking at server.ts: Server generates sessionId for connection but doesn't explicitly send it back in a "Welcome".
            // However, every message from server includes 'sessionId' of the sender.
            // When we join, we don't get our ID back.
            // We need the server to send us our ID.
            // For now, let's assume the first message we receive that is type 'ack' or similar gives us ID.
            // Or better, let's just generate it client side? No, server does it.
            // Let's UPDATE server to send a Welcome message.
            // But I can't easily update server logic without risking regression.
            // Check server.ts:
            // "console.log(`New connection: ${sessionId}`);"
            // "ws.on('message' ... this.handleMessage(ws, message, sessionId, color);"
            // It does not send the ID back.

            // FIX: I will update Server to send a "welcome" message on connection.

            // Request Initial State for all open files
            // In a real app we might request the whole file tree,
            // but for now we sync what we are looking at or what the server pushes.
            // Let's rely on server broadcasting or we push our state if server is empty.
            // But we need to know if we are the "host" or "guest".
            // Since there is no host/guest distinction in the protocol (all equal),
            // we will simply iterate open documents and init them on the server if they don't exist,
            // or update our shadow if the server has them.

            vscode.workspace.textDocuments.forEach(doc => {
                 if (doc.uri.scheme === 'file' && !this.gitService.isIgnored(doc.fileName)) {
                     const msg: FileInitMessage = {
                         type: 'file-init',
                         file: vscode.workspace.asRelativePath(doc.uri),
                         content: doc.getText(),
                         version: 0
                     };
                     this.send(msg);
                 }
            });
        });

        this.ws.on('message', (data: any) => {
            const msg = JSON.parse(data.toString()) as BaseMessage;
            this.handleMessage(msg);
        });

        this.ws.on('close', () => {
            this.webviewPanel.webview.postMessage({ type: 'disconnected' });
        });

        this.ws.on('error', (err: any) => {
             console.error("WS Error", err);
        });
    }

    private handleMessage(msg: BaseMessage) {
        switch (msg.type) {
            case 'text-operation':
                this.applyRemoteOperation(msg as TextOperationMessage);
                break;
            case 'cursor-selection':
                this.updateRemoteCursor(msg as CursorSelectionMessage);
                break;
            case 'webrtc-signal':
                this.webviewPanel.webview.postMessage({
                    type: 'webrtc-signal',
                    signal: (msg as WebRTCSignalMessage).signal,
                    senderId: msg.sessionId
                });
                break;
            case 'file-create':
                this.handleFileCreate(msg as FileCreateMessage);
                break;
            case 'file-delete':
                this.handleFileDelete(msg as FileDeleteMessage);
                break;
            case 'file-init':
                this.handleFileInit(msg as FileInitMessage);
                break;
            case 'welcome':
                this.sessionId = msg.sessionId;
                this.webviewPanel.webview.postMessage({ type: 'my-session-id', sessionId: msg.sessionId });

                // If we started the server, claim host status
                if (this.server) {
                    this.server.setHost(this.sessionId!);
                    this.webviewPanel.webview.postMessage({ type: 'is-host', value: true });
                }
                break;
            case 'user-joined':
            case 'user-left':
            case 'user-list':
                this.webviewPanel.webview.postMessage(msg);
                break;
            case 'user-request': // Notify host of pending user
                this.webviewPanel.webview.postMessage(msg);
                break;
            case 'chat-message':
                this.webviewPanel.webview.postMessage(msg);
                break;
            case 'terminal-data':
                this.webviewPanel.webview.postMessage(msg);
                break;
        }
    }

    private flushPendingOps(file: string) {
        const buffer = this.pendingOps.get(file);
        if (!buffer || buffer.length === 0) {return;}

        // Check if we are already awaiting an ack
        if (this.inFlightOps.has(file)) {return;}

        const op = buffer.shift();
        if (op) {
            this.inFlightOps.set(file, op);
            const revision = this.revisions.get(file) || 0;

            const msg: TextOperationMessage = {
                type: 'text-operation',
                file: file,
                version: revision,
                ops: op
            };
            this.send(msg);
        }
    }

    private handleFileInit(msg: FileInitMessage) {
         if (!msg.file || this.isPathUnsafe(msg.file)) {return;}
         if (this.gitService.isIgnored(msg.file)) {return;}

         const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

         // Server is telling us the authoritative content
         this.shadows.set(msg.file, msg.content);

         // Update editor if open
         const editor = vscode.window.visibleTextEditors.find(e => vscode.workspace.asRelativePath(e.document.uri) === msg.file);
         if (editor) {
             const fullRange = new vscode.Range(
                 editor.document.positionAt(0),
                 editor.document.positionAt(editor.document.getText().length)
             );
             // We use a flag to prevent echoing this back as an op
             this.isApplyingRemoteOp = true;
             editor.edit(editBuilder => {
                 editBuilder.replace(fullRange, msg.content);
             }).then(() => {
                 this.isApplyingRemoteOp = false;
             });
         } else {
             // If not open, write to disk so we are in sync
             const fullPath = path.join(rootPath, msg.file);
             const dir = path.dirname(fullPath);
             if (!fs.existsSync(dir)) {
                 fs.mkdirSync(dir, { recursive: true });
             }
             fs.writeFileSync(fullPath, msg.content);
         }
    }

    private async applyRemoteOperation(msg: TextOperationMessage) {
        if (!msg.file) {return;}
        if (this.isPathUnsafe(msg.file)) {
            console.error(`Blocked unsafe file operation: ${msg.file}`);
            return;
        }
        if (this.gitService.isIgnored(msg.file)) {return;}

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        // Ensure we have a shadow
        if (!this.shadows.has(msg.file)) {
            const fullPath = path.join(rootPath, msg.file);
            if (fs.existsSync(fullPath)) {
                this.shadows.set(msg.file, fs.readFileSync(fullPath, 'utf8'));
            } else {
                this.shadows.set(msg.file, '');
            }
        }

        // Handle ACKs (Our own ops reflected back)
        if (msg.sessionId === this.sessionId) {
            // This is confirmation of our InFlight op
            this.revisions.set(msg.file, msg.version); // Server confirmed version
            this.inFlightOps.delete(msg.file);
            this.flushPendingOps(msg.file); // Send next buffered op if any
            return;
        }

        // Handle Remote Ops
        let shadow = this.shadows.get(msg.file)!;
        let op = msg.ops;

        // Transform against pending ops (Awaiting & Buffer)
        // If we have ops that we have applied locally but server hasn't seen (or this remote op didn't see),
        // we must transform the remote op so it can be applied to our current state.

        const inFlight = this.inFlightOps.get(msg.file);
        if (inFlight) {
            op = otText.type.transform(op, inFlight, 'left');
            // We also need to transform our inFlight op against the incoming remote op
            // so that if it bounces back (or if server transformed it), we know what it became?
            // Actually, server already transformed the remote op against whatever history.
            // We just need to transform remote op against OUR pending changes.

            // AND we need to transform our pending ops against the remote op so future flush is correct?
            // YES.
            // TC: Transform Client.
            // client_op = transform(client_op, server_op, 'right')

            const newInFlight = otText.type.transform(inFlight, msg.ops, 'right');
            this.inFlightOps.set(msg.file, newInFlight);
        }

        const buffer = this.pendingOps.get(msg.file);
        if (buffer) {
            for (let i = 0; i < buffer.length; i++) {
                const pending = buffer[i];
                // We need to transform RemoteOp (op) against Pending -> NewRemoteOp (for next pending/application)
                // AND Pending against RemoteOp -> NewPending (to stay in buffer)

                const newRemoteOp = otText.type.transform(op, pending, 'left');
                const newPendingOp = otText.type.transform(pending, op, 'right');

                buffer[i] = newPendingOp;
                op = newRemoteOp;
            }
        }

        // Update Revision
        this.revisions.set(msg.file, msg.version);

        // Apply to Shadow
        try {
            shadow = otText.type.apply(shadow, op);
            this.shadows.set(msg.file, shadow);
        } catch (e) {
            console.error("Failed to apply OT to shadow", e);
            return;
        }

        // Apply to Editor
        // const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; // Already declared in scope if applyRemoteOperation is one large function?
        // Wait, applyRemoteOperation is one function.
        // I declared `rootPath` earlier in the function when I did `// Ensure we have a shadow`.
        // Let's reuse it.
        const uri = vscode.Uri.file(path.join(rootPath, msg.file));
        const editor = vscode.window.visibleTextEditors.find(e => vscode.workspace.asRelativePath(e.document.uri) === msg.file);

        if (editor) {
            this.isApplyingRemoteOp = true;
            await editor.edit(editBuilder => {
                let index = 0;
                op.forEach((c: any) => {
                    if (typeof c === 'number') {
                        index += c;
                    } else if (typeof c === 'string') {
                        editBuilder.insert(editor.document.positionAt(index), c);
                    } else if (typeof c === 'object' && c.d) {
                        const start = editor.document.positionAt(index);
                        const end = editor.document.positionAt(index + c.d.length);
                        editBuilder.delete(new vscode.Range(start, end));
                    }
                });
            });
            this.isApplyingRemoteOp = false;
        } else {
             const fullPath = path.join(rootPath, msg.file);
             fs.writeFileSync(fullPath, shadow);
        }
    }

    private updateRemoteCursor(msg: CursorSelectionMessage) {
        // Follow Mode Logic
        if (this.followingSessionId && msg.sessionId === this.followingSessionId && msg.file) {
            this.handleFollowUser(msg);
        }

        if (!msg.file || !msg.sessionId) {return;}

        const editor = vscode.window.visibleTextEditors.find(e => vscode.workspace.asRelativePath(e.document.uri) === msg.file);
        if (!editor) {return;}

        // Get or Create Map for this file
        if (!this.cursorDecorations.has(msg.file)) {
            this.cursorDecorations.set(msg.file, new Map());
        }
        const fileDecorations = this.cursorDecorations.get(msg.file)!;

        // Get or Create DecorationType for this user
        let userDecoration = fileDecorations.get(msg.sessionId);
        if (!userDecoration) {
            // Create a unique decoration type for this user
            // Use the color sent in message or generate one
            const color = msg.color || 'rgba(255,0,0,0.5)';
            userDecoration = vscode.window.createTextEditorDecorationType({
                backgroundColor: color, // We can make this partially transparent
                border: `1px solid ${color}`,
                after: {
                    contentText: msg.username || 'User',
                    color: 'white',
                    backgroundColor: color,
                    margin: '0 0 0 2px',
                    fontStyle: 'italic',
                    fontWeight: 'bold'
                }
            });
            fileDecorations.set(msg.sessionId, userDecoration);
        }

        const startPos = editor.document.positionAt(msg.start);
        const endPos = editor.document.positionAt(msg.end);
        const range = new vscode.Range(startPos, endPos);

        editor.setDecorations(userDecoration, [range]);
    }

    private async handleFollowUser(msg: CursorSelectionMessage) {
        if (!msg.file) { return; }
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        // 1. Ensure file is open
        const uri = vscode.Uri.file(path.join(rootPath, msg.file));

        try {
            // Check if visible
            let editor = vscode.window.visibleTextEditors.find(e => vscode.workspace.asRelativePath(e.document.uri) === msg.file);

            if (!editor) {
                // Open it
                const doc = await vscode.workspace.openTextDocument(uri);
                editor = await vscode.window.showTextDocument(doc, { preview: false }); // keep it open
            }

            // 2. Reveal Range (Scroll to them)
            const startPos = editor.document.positionAt(msg.start);
            const endPos = editor.document.positionAt(msg.end);
            const range = new vscode.Range(startPos, endPos);

            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (e) {
            console.warn(`Follow mode: Could not open or scroll to ${msg.file}`, e);
        }
    }

    private handleFileCreate(msg: FileCreateMessage) {
        if (!msg.file || this.isPathUnsafe(msg.file)) {return;}
        if (this.gitService.isIgnored(msg.file)) {return;}

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const fullPath = path.join(rootPath, msg.file);

        // Avoid overwriting if exists?
        if (!fs.existsSync(fullPath)) {
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, msg.content);
            this.shadows.set(msg.file, msg.content);
        }
    }

    private handleFileDelete(msg: FileDeleteMessage) {
        if (!msg.file || this.isPathUnsafe(msg.file)) {return;}
        if (this.gitService.isIgnored(msg.file)) {return;}

        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const fullPath = path.join(rootPath, msg.file);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            this.shadows.delete(msg.file);
        }
    }

    private isPathUnsafe(filePath: string): boolean {
        // Prevent directory traversal
        if (filePath.includes('..')) {return true;}
        if (path.isAbsolute(filePath)) {return true;}
        return false;
    }

    private send(msg: BaseMessage) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
        this.webviewPanel.webview.postMessage({ type: 'disconnected' });
    }

    private handleAddReference() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (!text) { return; }

        const file = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = selection.start.line;
        const endLine = selection.end.line;

        // Construct Chat Message with Reference
        // We will send a chat message that says "Shared a code reference" but includes the payload
        const msg: ChatMessage = {
            type: 'chat-message',
            username: this.myUsername || 'Me', // This will be overwritten by server usually, but we need it for local structure
            text: '', // Empty text, or we can put "Shared a reference"
            reference: {
                file,
                startLine,
                endLine,
                content: text
            }
        };

        this.send(msg);
    }

    private async handleOpenReference(file: string, startLine: number, endLine: number) {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const doc = await vscode.workspace.openTextDocument(path.join(rootPath, file));
        const editor = await vscode.window.showTextDocument(doc);

        const range = new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, Number.MAX_VALUE)
        );

        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
}
