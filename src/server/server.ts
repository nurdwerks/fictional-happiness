import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';
import {
    MessageType, BaseMessage, JoinMessage, TextOperationMessage,
    CursorSelectionMessage, WebRTCSignalMessage, FileCreateMessage,
    FileDeleteMessage, FileInitMessage
} from '../common/messages';

// OT types
const otText = require('ot-text');

interface Client {
    ws: WebSocket;
    sessionId: string;
    username: string;
    color: string;
}

interface DocumentState {
    content: string;
    version: number; // Current version of the document
    history: any[]; // History of operations for OT transformation
}

const COLORS = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];

export class CollaborationServer {
    private wss: WebSocketServer;
    private clients: Map<string, Client> = new Map();
    private documents: Map<string, DocumentState> = new Map(); // filepath -> state

    constructor(server?: http.Server, port?: number) {
        if (server) {
            this.wss = new WebSocketServer({ server });
        } else if (port) {
            this.wss = new WebSocketServer({ port });
        } else {
            throw new Error("Either server or port must be provided");
        }

        this.wss.on('connection', (ws) => this.handleConnection(ws));
        console.log(`Collab Server started.`);
    }

    private handleConnection(ws: WebSocket) {
        const sessionId = uuidv4();
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];

        console.log(`New connection: ${sessionId}`);

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
                console.error("Error parsing message", e);
            }
        });

        ws.on('close', () => {
            console.log(`Connection closed: ${sessionId}`);
            this.clients.delete(sessionId);
            // Broadcast disconnect?
        });
    }

    private handleMessage(ws: WebSocket, message: BaseMessage, sessionId: string, color: string) {
        switch (message.type) {
            case 'join':
                const joinMsg = message as JoinMessage;
                this.clients.set(sessionId, {
                    ws,
                    sessionId,
                    username: joinMsg.username,
                    color
                });
                console.log(`User ${joinMsg.username} joined.`);

                // Broadcast user-joined for WebRTC discovery
                this.broadcast(ws, {
                    type: 'user-joined',
                    sessionId: sessionId,
                    username: joinMsg.username
                } as any);
                break;

            case 'text-operation':
                this.handleTextOperation(ws, message as TextOperationMessage);
                break;

            case 'cursor-selection':
                // Simply broadcast to others
                const cursorMsg = message as CursorSelectionMessage;
                // Attach metadata so clients know who it is
                const client = this.clients.get(sessionId);
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

    private handleTextOperation(senderWs: WebSocket, msg: TextOperationMessage) {
        if (!msg.file) return;

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
        if (!msg.file) return;
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
            if (client.ws !== senderWs && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
            }
        });
    }

    public close() {
        this.wss.close();
    }
}
