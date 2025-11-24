import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';
import {
    MessageType, BaseMessage, JoinMessage, TextOperationMessage,
    CursorSelectionMessage, WebRTCSignalMessage, FileCreateMessage,
    FileDeleteMessage, FileInitMessage, ChatMessage, UserListMessage, UserLeftMessage,
    UserRequestMessage, ApproveRequestMessage, RejectRequestMessage, KickUserMessage
} from '../common/messages';

// OT types
const otText = require('ot-text');

interface Client {
    ws: WebSocket;
    sessionId: string;
    username: string;
    color: string;
    status: 'pending' | 'approved';
}

interface DocumentState {
    content: string;
    version: number; // Current version of the document
    history: any[]; // History of operations for OT transformation
}

const COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];

export class CollaborationServer {
    private wss: WebSocketServer;
    private httpServer: http.Server | undefined;
    private clients: Map<string, Client> = new Map();
    private documents: Map<string, DocumentState> = new Map(); // filepath -> state
    private hostSessionId: string | null = null;
    private allowExternalConnections = false;
    private wsEnabled = false; // WebSocket disabled by default

    // Event hook for extension to populate files
    public onClientApproved?: (sessionId: string) => void;
    public onPortChange?: (newPort: number) => void;
    private logger?: (msg: string) => void;
    private port: number | undefined;

    constructor(server?: http.Server, port?: number, logger?: (msg: string) => void) {
        this.logger = logger;
        this.port = port;
        this.wss = new WebSocketServer({ noServer: true });

        if (server) {
            this.httpServer = server;
        } else if (port) {
            this.httpServer = http.createServer((req, res) => this.handleRestRequest(req, res));
            this.httpServer.listen(port);
        } else {
            throw new Error("Either server or port must be provided");
        }

        this.httpServer.on('upgrade', (request, socket, head) => {
            if (!this.wsEnabled) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.wss.emit('connection', ws, request);
            });
        });

        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
        this.log(`Collab Server started (WS Enabled: ${this.wsEnabled})`);
    }

    private handleRestRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // Set CORS headers to allow Webview to access
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);

        if (req.method === 'POST' && url.pathname === '/start') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const requestedPort = data.port ? parseInt(data.port) : this.port;

                    if (requestedPort && requestedPort !== this.port) {
                        // Port change requested
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ message: 'Restarting on new port', newPort: requestedPort }), () => {
                            if (this.onPortChange) {
                                this.onPortChange(requestedPort);
                            }
                        });
                    } else {
                        // Enable WS on current port
                        this.wsEnabled = true;
                        this.enableExternalConnections();
                        this.log("WebSocket enabled via REST");
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ status: 'started', port: this.port }));
                    }
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }

        if (req.method === 'GET') {
            if (url.pathname === '/status') {
                const status = {
                    clientCount: this.clients.size,
                    hostSessionId: this.hostSessionId,
                    isHostOnline: this.hostSessionId ? this.clients.has(this.hostSessionId) : false,
                    allowExternalConnections: this.allowExternalConnections,
                    documents: this.documents.size,
                    wsEnabled: this.wsEnabled,
                    port: this.port
                };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
                return;
            }

            if (url.pathname === '/clients') {
                const clientList = Array.from(this.clients.values()).map(c => ({
                    sessionId: c.sessionId,
                    username: c.username,
                    color: c.color,
                    status: c.status,
                    isHost: c.sessionId === this.hostSessionId
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(clientList));
                return;
            }
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }

    public enableExternalConnections() {
        this.allowExternalConnections = true;
        this.log("External connections enabled.");
    }

    private log(msg: string) {
        if (this.logger) {
            this.logger(msg);
        } else {
            console.log(msg);
        }
    }

    private logError(msg: string, error?: any) {
        const fullMsg = error ? `${msg} ${error}` : msg;
        if (this.logger) {
            this.logger(`ERROR: ${fullMsg}`);
        } else {
            console.error(msg, error);
        }
    }

    public setHost(sessionId: string) {
        this.hostSessionId = sessionId;
        this.log(`Host set to: ${sessionId}`);
        const client = this.clients.get(sessionId);
        if (client) {
            client.status = 'approved';
        }
    }

    public sendToClient(sessionId: string, msg: BaseMessage) {
        const client = this.clients.get(sessionId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(msg));
        }
    }

    private handleConnection(ws: WebSocket, req: http.IncomingMessage) {
        const remoteAddress = req.socket.remoteAddress;

        // Simple localhost check. IPv6 ::1 or IPv4 127.0.0.1 or ::ffff:127.0.0.1
        const isLocal = remoteAddress === '::1' || remoteAddress === '127.0.0.1' || remoteAddress?.includes('127.0.0.1');

        if (!isLocal && !this.allowExternalConnections) {
            this.log(`Rejected external connection from ${remoteAddress}`);
            ws.close();
            return;
        }

        const sessionId = uuidv4();
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];

        this.log(`New connection: ${sessionId} (from ${remoteAddress})`);

        // Send Welcome with SessionID
        const welcomeMsg = {
            type: 'welcome',
            sessionId: sessionId,
            color: color
        };
        ws.send(JSON.stringify(welcomeMsg));

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString()) as BaseMessage;
                // Stamp message with sessionId if not present (trust the socket)
                message.sessionId = sessionId;
                this.handleMessage(ws, message, sessionId, color);
            } catch (e) {
                this.logError("Error parsing message", e);
            }
        });

        ws.on('close', () => {
            this.log(`Connection closed: ${sessionId}`);
            const client = this.clients.get(sessionId);
            this.clients.delete(sessionId);

            if (client && client.status === 'approved') {
                 // Notify others they left
                 this.broadcast(ws, {
                     type: 'user-left',
                     sessionId: sessionId,
                     username: client.username
                 } as any);
            }

            if (sessionId === this.hostSessionId) {
                this.hostSessionId = null;
                // If host leaves, maybe disconnect everyone or warn them?
            }
        });
    }

    private handleMessage(ws: WebSocket, message: BaseMessage, sessionId: string, color: string) {
        // If client is pending, they can only send 'join' (or if they are the host claiming to be host)
        // Actually, 'join' is the first thing they send.

        // Host Override: If this is the Host session, allow commands even if status is pending (though setHost should fix status)
        const isHost = (this.hostSessionId === sessionId);

        const client = this.clients.get(sessionId);
        if (client && client.status === 'pending' && message.type !== 'join') {
            // Ignore other messages from pending users
            return;
        }

        switch (message.type) {
            case 'join':
                const joinMsg = message as JoinMessage;
                const status = (sessionId === this.hostSessionId) ? 'approved' : 'pending';

                this.clients.set(sessionId, {
                    ws,
                    sessionId,
                    username: joinMsg.username,
                    color,
                    status: status
                });
                this.log(`User ${joinMsg.username} joined. Status: ${status}`);

                if (status === 'approved') {
                    this.approveClient(sessionId);
                } else {
                    // Notify Host
                    if (this.hostSessionId) {
                        const hostClient = this.clients.get(this.hostSessionId);
                        if (hostClient && hostClient.ws.readyState === WebSocket.OPEN) {
                            const reqMsg: UserRequestMessage = {
                                type: 'user-request',
                                username: joinMsg.username,
                                sessionId: sessionId
                            };
                            hostClient.ws.send(JSON.stringify(reqMsg));
                        }
                    } else {
                        // No host? Maybe this IS the host but we haven't called setHost yet.
                        // Wait for setHost to be called by extension.
                        // If it's a remote user and no host is online, they just hang in pending.
                    }
                }
                break;

            case 'approve-request':
                if (isHost) {
                    const approveMsg = message as ApproveRequestMessage;
                    this.approveClient(approveMsg.targetSessionId);
                }
                break;

            case 'reject-request':
                if (isHost) {
                    const rejectMsg = message as RejectRequestMessage;
                    this.rejectClient(rejectMsg.targetSessionId);
                }
                break;

            case 'kick-user':
                if (isHost) {
                    const kickMsg = message as KickUserMessage;
                    this.rejectClient(kickMsg.targetSessionId);
                }
                break;

            case 'chat-message':
                const chatMsg = message as ChatMessage;
                // Add timestamp and broadcast
                chatMsg.timestamp = Date.now();
                // Ensure correct username/color from server state
                if (client) {
                    chatMsg.username = client.username;
                    chatMsg.color = client.color;
                    this.broadcast(ws, chatMsg);
                    // Also echo back to sender so they see it confirmed
                    ws.send(JSON.stringify(chatMsg));
                }
                break;

            case 'text-operation':
                this.handleTextOperation(ws, message as TextOperationMessage);
                break;

            case 'cursor-selection':
                // Simply broadcast to others
                const cursorMsg = message as CursorSelectionMessage;
                // Attach metadata so clients know who it is
                if (client) {
                    cursorMsg.color = client.color;
                    cursorMsg.username = client.username;
                    this.broadcast(ws, cursorMsg);
                }
                break;

            case 'webrtc-signal':
                // Relay signal to all other clients (mesh) or specific target
                // For simplicity, broadcasting to all others.
                // In a real mesh, we might want to target specific peers.
                this.broadcast(ws, message as WebRTCSignalMessage);
                break;

            case 'file-create':
            case 'file-delete':
                // Broadcast file events
                this.broadcast(ws, message);
                break;

            case 'file-init':
                 // Client requesting or sending initial state?
                 // In this simple model, let's assume client asks for state or pushes it.
                 // For now, if a client sends 'file-init' (pushes content), we set it.
                 // Realistically:
                 // 1. Client opens file. Sends "Request Init".
                 // 2. Server sends "FileInit" with content.
                 // If Server has no content, maybe Client sends "FileInit" with their content.
                 this.handleFileInit(ws, message as FileInitMessage);
                 break;
        }
    }

    private approveClient(sessionId: string) {
        const client = this.clients.get(sessionId);
        if (!client) { return; }

        client.status = 'approved';

        // Send current user list to the new user
        const userList: UserListMessage = {
            type: 'user-list',
            users: Array.from(this.clients.values())
                .filter(c => c.status === 'approved')
                .map(c => ({
                    sessionId: c.sessionId,
                    username: c.username,
                    color: c.color
                }))
        };
        client.ws.send(JSON.stringify(userList));

        // Broadcast user-joined
        this.broadcast(client.ws, {
            type: 'user-joined',
            sessionId: sessionId,
            username: client.username
        } as any);

        // Notify Host extension to send full file list
        if (this.onClientApproved) {
            this.onClientApproved(sessionId);
        }

        // Send currently known in-memory docs as fallback/fast-path
        this.documents.forEach((doc, filepath) => {
             const msg: FileInitMessage = {
                 type: 'file-init',
                 file: filepath,
                 content: doc.content,
                 version: doc.version
             };
             client.ws.send(JSON.stringify(msg));
        });
    }

    private rejectClient(sessionId: string) {
        const client = this.clients.get(sessionId);
        if (client) {
            client.ws.close();
            this.clients.delete(sessionId);

            if (client.status === 'approved') {
                 // Notify others they left
                 this.broadcast(client.ws, {
                     type: 'user-left',
                     sessionId: sessionId,
                     username: client.username
                 } as any);
            }
        }
    }

    private handleTextOperation(senderWs: WebSocket, msg: TextOperationMessage) {
        if (!msg.file) {return;}

        let doc = this.documents.get(msg.file);
        if (!doc) {
            // Should verify if this is valid, but for now create empty
            doc = { content: '', version: 0, history: [] };
            this.documents.set(msg.file, doc);
        }

        if (msg.version < 0) {
             // Initial load request usually.
             return;
        }

        // OT Transformation
        // If msg.version == doc.version, we can apply directly.
        // If msg.version < doc.version, we must transform against history.

        if (msg.version > doc.version) {
            // Future version? Error.
            return;
        }

        let op = msg.ops;

        // Transform against all operations that happened since msg.version
        if (msg.version < doc.version) {
             // Standard OT logic:
             // Client sends op at version V. Server is at V+k.
             // We need to transform op against ops V, V+1, ... V+k-1.

             for (const pastOp of doc.history.slice(msg.version)) {
                 // transform(op, pastOp, 'left') -> client's op is the new one coming in
                 op = otText.type.transform(op, pastOp, 'left');
             }
        }

        // Apply to content
        doc.content = otText.type.apply(doc.content, op);
        doc.history.push(op);
        doc.version++;

        // Broadcast the *transformed* op to everyone else
        // They need to apply it as version 'doc.version - 1' -> 'doc.version'
        // Actually, we send the new op and the NEW version number it produced?
        // Typically server sends: "Here is op that transitions V -> V+1"

        const broadcastMsg: TextOperationMessage = {
            type: 'text-operation',
            file: msg.file,
            version: doc.version, // The version this op produces? Or the version it applies to?
            // Usually we send the version it applies to.
            // Let's say it applies to V_current-1.
            // The clients verify they are at V_current-1.

            // To be consistent: The message contains the op that WAS applied.
            // The clients should track the server version.
            // We can send the current server version (which is post-op).
            // Clients seeing this op know it updates server version (msg.version-1) to (msg.version).
            ops: op,
            sessionId: msg.sessionId
        };

        // We really should send the version of the document *before* the op, so clients check validity.
        // But let's send the *new* version number.
        // Simplified: Client tracks server version.

        // Broadcast to others
        this.broadcast(senderWs, broadcastMsg);

        // Send back to sender (ACK) so they can confirm their op and advance revision
        // We send the same message. The client checks sessionId to know it's an ACK.
        if (senderWs.readyState === WebSocket.OPEN) {
             senderWs.send(JSON.stringify(broadcastMsg));
        }
    }

    private handleFileInit(ws: WebSocket, msg: FileInitMessage) {
        if (!msg.file) {return;}
        if (!this.documents.has(msg.file)) {
            // If server doesn't have it, accept client's version
            this.documents.set(msg.file, {
                content: msg.content,
                version: 0,
                history: []
            });
        } else {
            // Server has it, send server version to client
            const doc = this.documents.get(msg.file)!;
            const response: FileInitMessage = {
                type: 'file-init',
                file: msg.file,
                content: doc.content,
                version: doc.version
            };
            ws.send(JSON.stringify(response));
        }
    }

    private broadcast(senderWs: WebSocket, msg: BaseMessage) {
        const data = JSON.stringify(msg);
        this.clients.forEach((client) => {
            if (client.ws !== senderWs && client.ws.readyState === WebSocket.OPEN && client.status === 'approved') {
                client.ws.send(data);
            }
        });
    }

    public close() {
        this.wss.close();
        if (this.httpServer) {
            this.httpServer.close();
        }
    }
}
