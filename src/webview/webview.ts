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
const participants: { sessionId: string; username: string; color: string }[] = [];

// Helper to update UI state
function updateState(connected: boolean) {
    isConnected = connected;
    statusDisplay.className = connected ? 'status connected' : 'status disconnected';
    statusDisplay.textContent = connected ? 'Connected' : 'Disconnected';

    const startServerUI = document.getElementById('start-server-ui')!;
    const joinServerUI = document.getElementById('join-server-ui')!;
    const divider = document.querySelector('.section div.divider') as HTMLElement; // The "OR"

    if (connected) {
        // If connected externally, hide start host logic
        if (isExternalConnection) {
            startServerUI.style.display = 'none';
            joinServerUI.style.display = 'none';
            if (divider) divider.style.display = 'none';
            btnDisconnect.style.display = 'block';
        } else {
            // Connected locally. Show Start Host (to enable external). Hide Join.
            startServerUI.style.display = 'block';
            joinServerUI.style.display = 'none';
            if (divider) divider.style.display = 'none';
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

    } else {
        // Disconnected
        startServerUI.style.display = 'block';
        joinServerUI.style.display = 'block';
        if (divider) divider.style.display = 'block';
        btnDisconnect.style.display = 'none';

        voiceSection.style.display = 'none';
        participantsSection.style.display = 'none';
        chatSection.style.display = 'none';
        terminalSection.style.display = 'none';
        pendingSection.style.display = 'none';

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

btnStartHost.addEventListener('click', () => {
    // We are likely already connected locally.
    // Sending startHost enables external connections.
    const port = parseInt(inputPort.value);
    vscode.postMessage({ command: 'startHost', port });
    isExternalConnection = false;
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
            addUserToUI(message.sessionId, message.username, message.color);
            initiateConnection(message.sessionId);
            break;
        case 'user-list':
            participantsList.innerHTML = '';
            participants.length = 0;
            message.users.forEach((u: any) => addUserToUI(u.sessionId, u.username, u.color));
            break;
        case 'user-left':
            removeUserFromUI(message.sessionId);
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

function addUserToUI(sessionId: string, name: string, color: string) {
    if (document.getElementById(`user-${sessionId}`)) {return;}

    participants.push({ sessionId, username: name, color });

    const li = document.createElement('li');
    li.id = `user-${sessionId}`;
    li.className = 'participant-item';

    const nameSpan = document.createElement('span');
    nameSpan.style.color = color;
    nameSpan.style.fontWeight = 'bold';
    nameSpan.textContent = `${name} (${sessionId.substring(0, 6)})`;

    const controls = document.createElement('div');
    controls.style.display = 'flex';

    if (name !== username) {
        const followBtn = document.createElement('button');
        followBtn.className = 'follow-btn';
        followBtn.textContent = 'Follow';
        followBtn.onclick = () => toggleFollow(sessionId, followBtn);

        if (followingSessionId === sessionId) {
            followBtn.textContent = 'Unfollow';
            followBtn.classList.add('following');
        }
        controls.appendChild(followBtn);
    }

    if (isHost && name !== username) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick-btn';
        kickBtn.textContent = 'Kick';
        kickBtn.title = 'Kick user';
        kickBtn.onclick = () => {
             vscode.postMessage({ command: 'kick-user', targetSessionId: sessionId });
        };
        controls.appendChild(kickBtn);
    }

    li.appendChild(nameSpan);
    li.appendChild(controls);

    participantsList.appendChild(li);
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
