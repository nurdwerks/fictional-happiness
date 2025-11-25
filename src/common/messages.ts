// Message types shared between Client and Server

export type MessageType =
  | 'join'
  | 'welcome'
  | 'user-joined'
  | 'user-left'
  | 'user-list'
  | 'chat-message'
  | 'text-operation'
  | 'cursor-selection'
  | 'file-create'
  | 'file-delete'
  | 'file-init' // Server sending initial file content to client
  | 'webrtc-signal'
  | 'ack' // Acknowledgment for joining
  | 'error'
  | 'terminal-create' // Shared Terminal
  | 'terminal-data'
  | 'terminal-resize'
  | 'terminal-close'
  | 'follow-user' // Follow mode
  | 'jump-to-user' // New: Jump to user
  | 'user-request' // New: Request to join (Host view)
  | 'approve-request' // New: Host approves
  | 'reject-request' // New: Host rejects
  | 'kick-user'; // New: Host kicks

export interface BaseMessage {
  type: MessageType;
  sessionId?: string; // Client ID
  file?: string; // File path (relative to workspace root)
}

export interface JoinMessage extends BaseMessage {
  type: 'join';
  username: string;
}

export interface TextOperationMessage extends BaseMessage {
  type: 'text-operation';
  version: number; // Document version based on OT
  ops: any[]; // OT operations
}

export interface CursorSelectionMessage extends BaseMessage {
  type: 'cursor-selection';
  start: number; // Offset
  end: number;
  cursorLine?: number; // New
  cursorChar?: number; // New
  color?: string;
  username?: string;
}

export interface WebRTCSignalMessage extends BaseMessage {
  type: 'webrtc-signal';
  signal: any;
  targetSessionId?: string; // If directing to a specific peer (optional if broadcast)
}

export interface FileCreateMessage extends BaseMessage {
    type: 'file-create';
    content: string;
}

export interface FileDeleteMessage extends BaseMessage {
    type: 'file-delete';
}

export interface ErrorMessage extends BaseMessage {
    type: 'error';
    message: string;
}

export interface FileInitMessage extends BaseMessage {
    type: 'file-init';
    content: string;
    version: number;
}

export interface CodeReference {
    file: string;
    startLine: number;
    endLine: number;
    content: string;
}

export interface ChatMessage extends BaseMessage {
    type: 'chat-message';
    text: string;
    username: string;
    color?: string;
    timestamp?: number;
    reference?: CodeReference;
}

export interface UserListMessage extends BaseMessage {
    type: 'user-list';
    users: {
        sessionId: string;
        username: string;
        color: string;
        activeFile?: string;
        cursorLine?: number;
        cursorChar?: number;
    }[];
}

export interface UserLeftMessage extends BaseMessage {
    type: 'user-left';
    sessionId: string;
    username?: string;
}

// --- Shared Terminal Messages ---

export interface TerminalCreateMessage extends BaseMessage {
    type: 'terminal-create';
    termId: string;
    name: string;
}

export interface TerminalDataMessage extends BaseMessage {
    type: 'terminal-data';
    termId: string;
    data: string;
}

export interface TerminalResizeMessage extends BaseMessage {
    type: 'terminal-resize';
    termId: string;
    cols: number;
    rows: number;
}

export interface TerminalCloseMessage extends BaseMessage {
    type: 'terminal-close';
    termId: string;
}

export interface FollowUserMessage extends BaseMessage {
    type: 'follow-user';
    targetSessionId: string | null; // null to stop following
}

export interface JumpToUserMessage extends BaseMessage {
    type: 'jump-to-user';
    targetSessionId: string;
    file?: string;
    line?: number;
    char?: number;
}

// --- Host Approval Messages ---

export interface UserRequestMessage extends BaseMessage {
    type: 'user-request';
    username: string;
    sessionId: string;
}

export interface ApproveRequestMessage extends BaseMessage {
    type: 'approve-request';
    targetSessionId: string;
}

export interface RejectRequestMessage extends BaseMessage {
    type: 'reject-request';
    targetSessionId: string;
}

export interface KickUserMessage extends BaseMessage {
    type: 'kick-user';
    targetSessionId: string;
}
