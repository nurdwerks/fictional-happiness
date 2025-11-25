// Webview Logic (Running in Browser)
// This file will be bundled to dist/webview.js

declare function acquireVsCodeApi(): any;

const vscode = acquireVsCodeApi();

// Retry mechanism for connection
const sendReady = () => vscode.postMessage({ command: 'ready' });
sendReady(); // Send immediately
const readyInterval = setInterval(sendReady, 1000);

let isConnected = false;
let isHost = false; // Track if we are the host
let isExternalConnection = false; // Track if we joined externally
let localStream: MediaStream | null = null;
let username: string | null = null;
let mySessionId: string | null = null; // Store my own session ID

// Map to store peer connections for mesh topology
const peers = new Map<string, RTCPeerConnection>();

// UI Elements
const statusDisplay = document.getElementById('status-display')!;
const usernameDisplay = document.getElementById('username-display')!;
// Renamed btn-start-server to btn-start-host logic
const btnStart = document.getElementById('btn-start-server') as HTMLButtonElement;
// Note: We'll rename the ID in HTML, but here we can keep variable name or change it.
// Let's assume we update HTML ID to 'btn-start-host' and here too.
const btnJoin = document.getElementById('btn-join-server') as HTMLButtonElement;
const btnDisconnect = document.getElementById('btn-disconnect') as HTMLButtonElement;
const inputPort = document.getElementById('local-port') as HTMLInputElement;
const inputAddress = document.getElementById('remote-address') as HTMLInputElement;
const voiceSection = document.getElementById('voice-section')!;
const voiceToggle = document.getElementById('voice-toggle') as HTMLInputElement;
const voiceStatus = document.getElementById('voice-status')!;
const iceServersInput = document.getElementById('ice-servers') as HTMLTextAreaElement;

const participantsSection = document.getElementById('participants-section')!;
const participantsList = document.getElementById('participants-list')!;
const pendingSection = document.getElementById('pending-section')!;
const pendingList = document.getElementById('pending-list')!;
const chatSection = document.getElementById('chat-section')!;
const chatMessages = document.getElementById('chat-messages')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const btnSendChat = document.getElementById('btn-send-chat') as HTMLButtonElement;

// REST Status UI
const serverStatusSection = document.getElementById('server-status-section')!;
const btnCheckStatus = document.getElementById('btn-check-status') as HTMLButtonElement;
const btnListClients = document.getElementById('btn-list-clients') as HTMLButtonElement;
const serverStatusOutput = document.getElementById('server-status-output')!;

// Terminal UI
const terminalSection = document.getElementById('terminal-section')!;
const terminalOutput = document.getElementById('terminal-output')!;

// Follow Mode State
let followingSessionId: string | null = null;

// Mentions State
let mentionActive = false;
let mentionFilter = '';
let mentionIndex = 0;
const mentionList = document.createElement('ul');
mentionList.id = 'mention-suggestions';
mentionList.style.position = 'absolute';
mentionList.style.display = 'none';
mentionList.style.backgroundColor = 'var(--vscode-editor-background)';
mentionList.style.border = '1px solid var(--vscode-widget-border)';
mentionList.style.listStyle = 'none';
mentionList.style.padding = '0';
mentionList.style.margin = '0';
mentionList.style.zIndex = '1000';
document.body.appendChild(mentionList);

// Participants Data
interface Participant {
    sessionId: string;
    username: string;
    color: string;
    activeFile?: string;
    cursorLine?: number;
    cursorChar?: number;
}
const participants: Participant[] = [];

// Helper to update UI state
function updateState(connected: boolean, hostStatus?: any) {
    isConnected = connected;
    statusDisplay.className = connected ? 'status connected' : 'status disconnected';
    statusDisplay.textContent = connected ? 'Connected' : 'Disconnected';

    // Host specific logic
    if (hostStatus) {
        if (hostStatus.wsEnabled) {
            btnStartHost.textContent = 'Allow External Connections';
            btnStartHost.title = 'Your collaboration server is running and accepting local connections. Click to allow external connections.';
        } else {
            btnStartHost.textContent = 'Start Hosting';
            btnStartHost.title = 'Start your collaboration server.';
        }
    }

    const startServerUI = document.getElementById('start-server-ui')!;
    const joinServerUI = document.getElementById('join-server-ui')!;
    const divider = document.querySelector('.section div.divider') as HTMLElement; // The "OR"

    if (connected) {
        // If connected externally, hide start host logic
        if (isExternalConnection) {
            startServerUI.style.display = 'none';
            joinServerUI.style.display = 'none';
            if (divider) {divider.style.display = 'none';}
            btnDisconnect.style.display = 'block';
        } else {
            // Connected locally. Show Start Host (to enable external). Hide Join.
            startServerUI.style.display = 'block';
            joinServerUI.style.display = 'none';
            if (divider) {divider.style.display = 'none';}
            btnDisconnect.style.display = 'none'; // Can't disconnect from local server easily or maybe we shouldn't?
            // Actually, if we disconnect local, we kill the server connection.
            // Let's allow disconnect if user wants to stop everything?
            // But if we are connected locally, we are just "ready".
            // The "Start Host" button is what we want focused.
        }

        voiceSection.style.display = 'block';
        participantsSection.style.display = 'block';
        chatSection.style.display = 'block';
        terminalSection.style.display = 'block';
        serverStatusSection.style.display = 'block';

    } else {
        // Disconnected
        startServerUI.style.display = 'block';
        joinServerUI.style.display = 'block';
        if (divider) {divider.style.display = 'block';}
        btnDisconnect.style.display = 'none';

        voiceSection.style.display = 'none';
        participantsSection.style.display = 'none';
        chatSection.style.display = 'none';
        terminalSection.style.display = 'none';
        pendingSection.style.display = 'none';
        serverStatusSection.style.display = 'none';

        stopVoice();
        voiceToggle.checked = false;
        participantsList.innerHTML = '';
        pendingList.innerHTML = '';
        chatMessages.innerHTML = '';
        terminalOutput.textContent = '';
        participants.length = 0;
        isHost = false;
        isExternalConnection = false;
    }
}

// Handlers
// IMPORTANT: ID will be changed to btn-start-host in HTML
const btnStartHost = document.getElementById('btn-start-server') as HTMLButtonElement;

btnStartHost.addEventListener('click', async () => {
    const port = inputPort.value ? parseInt(inputPort.value) : 3000;

    // Call REST API to start/enable host
    try {
        let url = `${getRestBaseUrl()}/start`;
        const body = JSON.stringify({ port });

        let res;
        try {
            res = await fetch(url, { method: 'POST', body });
        } catch (e) {
            // If failed, retry with localhost:3000 just in case user changed port input but server is still on 3000
            if (inputPort.value !== '3000') {
                 res = await fetch(`http://localhost:3000/start`, { method: 'POST', body });
            } else {
                throw e;
            }
        }

        if (res && res.ok) {
            const data = await res.json();
            if (data.newPort) {
                inputPort.value = data.newPort;
                // Wait for server restart?
                await new Promise(r => setTimeout(r, 1000));
            }
            // Now connect WebSocket
            const wsUrl = `ws://localhost:${inputPort.value}`;
            vscode.postMessage({ command: 'joinServer', address: wsUrl });
            isExternalConnection = false;
        } else {
            alert('Failed to start host: ' + (res ? res.statusText : 'Network Error'));
        }
    } catch (e) {
        alert(`Failed to call start endpoint: ${(e as any).message}`);
    }
});

btnJoin.addEventListener('click', () => {
    const address = inputAddress.value;
    vscode.postMessage({ command: 'joinServer', address });
    isExternalConnection = true;
});

btnDisconnect.addEventListener('click', () => {
    vscode.postMessage({ command: 'disconnect' });
    isExternalConnection = false;
});

voiceToggle.addEventListener('change', async () => {
    if (voiceToggle.checked) {
        await startVoice();
    } else {
        stopVoice();
    }
});

btnSendChat.addEventListener('click', () => {
    const text = chatInput.value;
    if (text) {
        vscode.postMessage({ command: 'chat-message', text });
        chatInput.value = '';
    }
});

function getRestBaseUrl() {
    let baseUrl = '';
    if (isExternalConnection) {
        // inputAddress.value is ws(s)://...
        baseUrl = inputAddress.value.replace(/^ws/, 'http');
    } else {
        // Localhost: check inputPort (if we started it) or defaultPort logic
        const port = inputPort.value || '3000';
        baseUrl = `http://localhost:${port}`;
    }
    // Remove trailing slash if present
    if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }
    return baseUrl;
}

btnCheckStatus.addEventListener('click', async () => {
    try {
        const url = `${getRestBaseUrl()}/status`;
        serverStatusOutput.textContent = `Fetching ${url}...`;
        const res = await fetch(url);
        if (!res.ok) { throw new Error(`Status ${res.status}`); }
        const data = await res.json();
        serverStatusOutput.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
        serverStatusOutput.textContent = `Error: ${(e as any).message}`;
    }
});

btnListClients.addEventListener('click', async () => {
    try {
        const url = `${getRestBaseUrl()}/clients`;
        serverStatusOutput.textContent = `Fetching ${url}...`;
        const res = await fetch(url);
        if (!res.ok) { throw new Error(`Status ${res.status}`); }
        const data = await res.json();
        serverStatusOutput.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
        serverStatusOutput.textContent = `Error: ${(e as any).message}`;
    }
});

chatInput.addEventListener('keydown', (e) => {
    if (mentionActive) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            mentionIndex++;
            renderMentions();
            return;
        } else if (e.key === 'ArrowUp') {
             e.preventDefault();
             mentionIndex--;
             renderMentions();
             return;
        } else if (e.key === 'Enter' || e.key === 'Tab') {
             e.preventDefault();
             applyMention();
             return;
        } else if (e.key === 'Escape') {
            closeMentions();
            return;
        }
    }

    if (e.key === 'Enter' && !mentionActive) {
        const text = chatInput.value;
        if (text) {
            vscode.postMessage({ command: 'chat-message', text });
            chatInput.value = '';
        }
    }
});

chatInput.addEventListener('input', () => {
    const text = chatInput.value;
    const cursor = chatInput.selectionStart || 0;

    // Check for @ symbol before cursor
    const lastAt = text.lastIndexOf('@', cursor - 1);

    if (lastAt !== -1) {
        // Check if there are spaces between @ and cursor
        const query = text.substring(lastAt + 1, cursor);
        if (!query.includes(' ')) {
            mentionActive = true;
            mentionFilter = query;
            renderMentions();
            // Position popup
            const rect = chatInput.getBoundingClientRect();
            mentionList.style.display = 'block';

            const topPos = rect.top - mentionList.offsetHeight;
            mentionList.style.top = `${topPos}px`;
            mentionList.style.left = `${rect.left}px`;
            mentionList.style.width = `${rect.width}px`;

            return;
        }
    }

    closeMentions();
});

function closeMentions() {
    mentionActive = false;
    mentionList.style.display = 'none';
}

function renderMentions() {
    mentionList.innerHTML = '';
    const matches = participants.filter(p => p.username.toLowerCase().startsWith(mentionFilter.toLowerCase()));

    if (matches.length === 0) {
        closeMentions();
        return;
    }

    if (mentionIndex >= matches.length) {mentionIndex = 0;}
    if (mentionIndex < 0) {mentionIndex = matches.length - 1;}

    matches.forEach((p, i) => {
        const li = document.createElement('li');
        li.textContent = p.username;
        li.style.padding = '5px';
        li.style.cursor = 'pointer';
        li.style.color = 'var(--vscode-editor-foreground)';
        if (i === mentionIndex) {
            li.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
            li.style.color = 'var(--vscode-list-activeSelectionForeground)';
        } else {
             li.style.backgroundColor = 'var(--vscode-editor-background)';
        }

        li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            mentionIndex = i;
            applyMention();
        });

        mentionList.appendChild(li);
    });

    const rect = chatInput.getBoundingClientRect();
    const topPos = rect.top - mentionList.offsetHeight;
    mentionList.style.top = `${topPos}px`;
    mentionList.style.left = `${rect.left}px`;
    mentionList.style.width = `${rect.width}px`;
}

function applyMention() {
    const matches = participants.filter(p => p.username.toLowerCase().startsWith(mentionFilter.toLowerCase()));
    if (matches[mentionIndex]) {
        const user = matches[mentionIndex].username;
        const text = chatInput.value;
        const cursor = chatInput.selectionStart || 0;
        const lastAt = text.lastIndexOf('@', cursor - 1);

        const newText = text.substring(0, lastAt) + '@' + user + ' ' + text.substring(cursor);
        chatInput.value = newText;
        chatInput.focus();
        closeMentions();
    }
}

// Message Listener
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'identity':
            clearInterval(readyInterval);
            username = message.username;
            usernameDisplay.textContent = username ? `Logged in as: ${username}` : 'Error: git config user.name not set.';

            if (message.iceServers) {
                 const formatted = message.iceServers.map((url: string) => ({ urls: url }));
                 iceServersInput.value = JSON.stringify(formatted);
            }

            if (message.defaultPort) {
                inputPort.value = message.defaultPort;
                if (inputAddress.getAttribute('placeholder') === "ws://localhost:3000") {
                    inputAddress.placeholder = `ws://localhost:${message.defaultPort}`;
                    inputAddress.value = `ws://localhost:${message.defaultPort}`;
                }
            }

            if (!username) {
                btnStartHost.disabled = true;
                btnJoin.disabled = true;
            }

            // After getting identity, check server status
            checkIdentityAndStatus();
            break;
        case 'connected':
            updateState(true);
            break;
        case 'disconnected':
            updateState(false);
            break;
        case 'webrtc-signal':
            handleWebRTCSignalRefined(message.signal, message.senderId);
            break;
        case 'user-joined':
            addUserToUI(message.sessionId, message.username, message.color, message.activeFile, message.cursorLine, message.cursorChar);
            initiateConnection(message.sessionId);
            break;
        case 'user-list':
            participantsList.innerHTML = '';
            participants.length = 0;
            message.users.forEach((u: any) => addUserToUI(u.sessionId, u.username, u.color, u.activeFile, u.cursorLine, u.cursorChar));
            break;
        case 'user-left':
            removeUserFromUI(message.sessionId);
            break;
        case 'cursor-selection':
             updateUserCursor(message.sessionId, message.file, message.cursorLine, message.cursorChar);
             break;
        case 'chat-message':
            addChatMessage(message);
            break;
        case 'terminal-data':
            appendTerminalData(message.data);
            break;
        case 'my-session-id':
             mySessionId = message.sessionId;
             break;
        case 'is-host':
             isHost = message.value;
             if (isHost) {
                 usernameDisplay.textContent += " (HOST)";
             }
             break;
        case 'user-request':
             if (isHost) {
                 pendingSection.style.display = 'block';
                 addPendingUser(message.sessionId, message.username);
             }
             break;
    }
});

async function checkIdentityAndStatus() {
    // 1. Check if server has our identity
    const identityUrl = `${getRestBaseUrl()}/identity`;
    let hasIdentity = false;
    try {
        const res = await fetch(identityUrl);
        if (res.ok) {
            const data = await res.json();
            if (data && data.username) {
                hasIdentity = true;
            }
        }
    } catch (e) {
        // Ignore, probably server not running yet.
    }

    // 2. If not, and we have one, send it
    if (!hasIdentity && username) {
        try {
            await fetch(identityUrl, {
                method: 'POST',
                body: JSON.stringify({ username })
            });
        } catch (e) {
            // Ignore
        }
    }

    // 3. Get host status
    try {
        const statusUrl = `${getRestBaseUrl()}/status`;
        const res = await fetch(statusUrl);
        if (res.ok) {
            const data = await res.json();
            // Update UI based on host status.
            updateState(false, data); // We are not websocket-connected yet.
        }
    } catch (e) {
        // Server likely not running, which is fine.
    }
}

function addUserToUI(sessionId: string, name: string, color: string, activeFile?: string, cursorLine?: number, cursorChar?: number) {
    let participant = participants.find(p => p.sessionId === sessionId);
    if (!participant) {
        participant = { sessionId, username: name, color, activeFile, cursorLine, cursorChar };
        participants.push(participant);
    } else {
        // Update existing just in case
        participant.username = name;
        participant.color = color;
        if (activeFile) { participant.activeFile = activeFile; }
        if (cursorLine !== undefined) { participant.cursorLine = cursorLine; }
        if (cursorChar !== undefined) { participant.cursorChar = cursorChar; }
    }

    let li = document.getElementById(`user-${sessionId}`);
    if (!li) {
        li = document.createElement('li');
        li.id = `user-${sessionId}`;
        li.className = 'participant-item';
        // Click to jump
        li.style.cursor = 'pointer';
        li.title = "Click to jump to user's cursor";
        li.addEventListener('click', (e) => {
            // Prevent if clicking button
            if ((e.target as HTMLElement).tagName === 'BUTTON') { return; }

            const p = participants.find(part => part.sessionId === sessionId);
            if (p && p.activeFile) {
                vscode.postMessage({
                    command: 'jump-to-user',
                    targetSessionId: sessionId,
                    file: p.activeFile,
                    line: p.cursorLine,
                    char: p.cursorChar
                });
            } else {
                // Should show message?
                // alert("User has no active file.");
            }
        });

        participantsList.appendChild(li);
    }

    // Update Content
    renderUserItem(li, participant);
}

function renderUserItem(li: HTMLElement, p: Participant) {
    li.innerHTML = ''; // Clear and rebuild

    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.width = '100%';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.justifyContent = 'space-between';
    topRow.style.alignItems = 'center';

    const nameSpan = document.createElement('span');
    nameSpan.style.color = p.color;
    nameSpan.style.fontWeight = 'bold';
    nameSpan.textContent = `${p.username} (${p.sessionId.substring(0, 6)})`;
    topRow.appendChild(nameSpan);

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '5px';

    if (p.username !== username) {
        const followBtn = document.createElement('button');
        followBtn.className = 'follow-btn';
        followBtn.textContent = 'Follow';
        followBtn.onclick = (e) => {
            e.stopPropagation();
            toggleFollow(p.sessionId, followBtn);
        };

        if (followingSessionId === p.sessionId) {
            followBtn.textContent = 'Unfollow';
            followBtn.classList.add('following');
        }
        controls.appendChild(followBtn);
    }

    if (isHost && p.username !== username) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = 'Kick';
        kickBtn.title = 'Kick user';
        kickBtn.onclick = (e) => {
             e.stopPropagation();
             vscode.postMessage({ command: 'kick-user', targetSessionId: p.sessionId });
        };
        controls.appendChild(kickBtn);
    }

    topRow.appendChild(controls);
    container.appendChild(topRow);

    // File info row
    if (p.activeFile) {
        const infoRow = document.createElement('div');
        infoRow.style.fontSize = '0.85em';
        infoRow.style.color = 'var(--vscode-descriptionForeground)';
        infoRow.style.marginTop = '2px';
        infoRow.style.whiteSpace = 'nowrap';
        infoRow.style.overflow = 'hidden';
        infoRow.style.textOverflow = 'ellipsis';

        const lineInfo = p.cursorLine !== undefined ? `:${p.cursorLine + 1}` : '';
        infoRow.textContent = `${p.activeFile}${lineInfo}`;
        infoRow.title = `${p.activeFile} (Line ${p.cursorLine !== undefined ? p.cursorLine + 1 : '?'})`;

        container.appendChild(infoRow);
    }

    li.appendChild(container);
}

function updateUserCursor(sessionId: string, file?: string, line?: number, char?: number) {
    const p = participants.find(part => part.sessionId === sessionId);
    if (!p) { return; }

    let changed = false;
    if (file && p.activeFile !== file) {
        p.activeFile = file;
        changed = true;
    }
    if (line !== undefined && p.cursorLine !== line) {
        p.cursorLine = line;
        changed = true;
    }
    if (char !== undefined) {
        p.cursorChar = char;
    }

    if (changed) {
        const li = document.getElementById(`user-${sessionId}`);
        if (li) {
            renderUserItem(li, p);
        }
    }
}

function removeUserFromUI(sessionId: string) {
    const el = document.getElementById(`user-${sessionId}`);
    if (el) {el.remove();}
    const idx = participants.findIndex(p => p.sessionId === sessionId);
    if (idx !== -1) { participants.splice(idx, 1); }

    if (followingSessionId === sessionId) {
        followingSessionId = null;
        vscode.postMessage({ command: 'follow-user', targetSessionId: null });
    }
}

function addPendingUser(sessionId: string, name: string) {
    if (document.getElementById(`pending-${sessionId}`)) { return; }

    const div = document.createElement('div');
    div.id = `pending-${sessionId}`;
    div.className = 'pending-request';
    div.textContent = `${name} (${sessionId.substring(0, 6)}) wants to join.`;

    const btnContainer = document.createElement('div');
    btnContainer.style.marginTop = '5px';
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '5px';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'approve-btn';
    approveBtn.textContent = 'Approve';
    approveBtn.onclick = () => {
        vscode.postMessage({ command: 'approve-request', targetSessionId: sessionId });
        div.remove();
        checkPendingEmpty();
    };

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.onclick = () => {
        vscode.postMessage({ command: 'reject-request', targetSessionId: sessionId });
        div.remove();
        checkPendingEmpty();
    };

    btnContainer.appendChild(approveBtn);
    btnContainer.appendChild(rejectBtn);
    div.appendChild(btnContainer);

    pendingList.appendChild(div);
}

function checkPendingEmpty() {
    if (pendingList.children.length === 0) {
        pendingSection.style.display = 'none';
    }
}

function toggleFollow(sessionId: string, btn: HTMLButtonElement) {
    if (followingSessionId === sessionId) {
        followingSessionId = null;
        btn.textContent = 'Follow';
        btn.classList.remove('following');
        vscode.postMessage({ command: 'follow-user', targetSessionId: null });
    } else {
        if (followingSessionId) {
             const prevBtn = document.querySelector(`#user-${followingSessionId} .follow-btn`);
             if (prevBtn) {
                 prevBtn.textContent = 'Follow';
                 prevBtn.classList.remove('following');
             }
        }

        followingSessionId = sessionId;
        btn.textContent = 'Unfollow';
        btn.classList.add('following');
        vscode.postMessage({ command: 'follow-user', targetSessionId: sessionId });
    }
}

function addChatMessage(message: any) {
    const sender = message.username;
    const text = message.text;
    const color = message.color;
    const timestamp = message.timestamp;
    const reference = message.reference;

    const div = document.createElement('div');
    div.style.marginBottom = '5px';
    const time = new Date(timestamp).toLocaleTimeString();

    const senderSpan = document.createElement('span');
    senderSpan.style.color = color;
    senderSpan.style.fontWeight = 'bold';
    senderSpan.textContent = sender;

    const timeSpan = document.createElement('span');
    timeSpan.style.fontSize = '0.8em';
    timeSpan.style.color = 'var(--vscode-descriptionForeground)';
    timeSpan.style.marginLeft = '5px';
    timeSpan.textContent = time;

    const textDiv = document.createElement('div');
    if (text) {
        textDiv.textContent = text;
        textDiv.style.marginLeft = '10px';
    }

    div.appendChild(senderSpan);
    div.appendChild(timeSpan);
    if (text) {
        div.appendChild(textDiv);
    }

    if (reference) {
        const refDiv = document.createElement('div');
        refDiv.style.marginLeft = '10px';
        refDiv.style.marginTop = '5px';
        refDiv.style.border = '1px solid var(--vscode-textBlockQuote-border)';
        refDiv.style.backgroundColor = 'var(--vscode-textBlockQuote-background)';
        refDiv.style.padding = '5px';

        const header = document.createElement('div');
        header.style.marginBottom = '5px';

        const link = document.createElement('a');
        link.textContent = `${reference.file}:${reference.startLine + 1}`;
        link.href = '#';
        link.style.color = 'var(--vscode-textLink-foreground)';
        link.style.textDecoration = 'underline';
        link.onclick = (e) => {
            e.preventDefault();
            vscode.postMessage({
                command: 'openReference',
                file: reference.file,
                startLine: reference.startLine,
                endLine: reference.endLine
            });
        };
        header.appendChild(link);
        refDiv.appendChild(header);

        const lines = reference.content.split('\n');
        const isMultiLine = lines.length > 1;

        if (isMultiLine) {
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = `Code (${lines.length} lines)`;
            summary.style.cursor = 'pointer';

            const pre = document.createElement('pre');
            pre.style.margin = '5px 0 0 0';
            pre.style.fontFamily = 'monospace';
            pre.textContent = reference.content;

            details.appendChild(summary);
            details.appendChild(pre);
            refDiv.appendChild(details);
        } else {
             const pre = document.createElement('pre');
             pre.style.margin = '0';
             pre.style.fontFamily = 'monospace';
             pre.textContent = reference.content;
             refDiv.appendChild(pre);
        }

        div.appendChild(refDiv);
    }

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendTerminalData(data: string) {
    const span = document.createElement('span');
    span.textContent = data;
    terminalOutput.appendChild(span);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// --- WebRTC Logic ---

async function startVoice() {
    try {
        voiceStatus.textContent = "Voice: Requesting Mic...";
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        voiceStatus.textContent = "Voice: Active (Waiting for peers)";
    } catch (e) {
        console.error("Failed to start voice", e);
        voiceStatus.textContent = "Voice: Error (Check permissions)";
        voiceToggle.checked = false;
    }
}

function stopVoice() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    peers.forEach(pc => pc.close());
    peers.clear();

    voiceStatus.textContent = "Voice: Off";
}

async function getOrCreatePeer(senderId: string) {
    if (peers.has(senderId)) {return peers.get(senderId)!;}

    let iceServers = [];
    try {
        iceServers = JSON.parse(iceServersInput.value);
    } catch (e) { }

    const newPc = new RTCPeerConnection({ iceServers });

    if (localStream) {
        localStream.getTracks().forEach(track => newPc.addTrack(track, localStream!));
    }

    newPc.ontrack = (event) => {
        const remoteAudio = new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.autoplay = true;
    };

    newPc.onicecandidate = (event) => {
        if (event.candidate) {
            vscode.postMessage({
                command: 'webrtc-signal',
                targetSessionId: senderId,
                signal: { type: 'candidate', candidate: event.candidate }
            });
        }
    };

    peers.set(senderId, newPc);
    return newPc;
}

async function handleWebRTCSignalRefined(signal: any, senderId: string) {
    if (!voiceToggle.checked) {return;}

    const peer = await getOrCreatePeer(senderId);

    if (signal.type === 'offer') {
        await peer.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        vscode.postMessage({
            command: 'webrtc-signal',
            targetSessionId: senderId,
            signal: { type: 'answer', sdp: peer.localDescription }
        });
    } else if (signal.type === 'answer') {
        await peer.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'candidate') {
        await peer.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
}

async function initiateConnection(targetId: string) {
    if (!voiceToggle.checked) {return;}
    const peer = await getOrCreatePeer(targetId);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    vscode.postMessage({
        command: 'webrtc-signal',
        targetSessionId: targetId,
        signal: { type: 'offer', sdp: peer.localDescription }
    });
}
