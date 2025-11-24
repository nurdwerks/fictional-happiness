// Webview Logic (Running in Browser)
// This file will be bundled to dist/webview.js

declare function acquireVsCodeApi(): any;

const vscode = acquireVsCodeApi();

let isConnected = false;
let localStream: MediaStream | null = null;
let username: string | null = null;

// Map to store peer connections for mesh topology
const peers = new Map<string, RTCPeerConnection>();

// UI Elements
const statusDisplay = document.getElementById('status-display')!;
const usernameDisplay = document.getElementById('username-display')!;
const btnStart = document.getElementById('btn-start-server') as HTMLButtonElement;
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
const chatSection = document.getElementById('chat-section')!;
const chatMessages = document.getElementById('chat-messages')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const btnSendChat = document.getElementById('btn-send-chat') as HTMLButtonElement;

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

    if (connected) {
        btnStart.parentElement!.style.display = 'none';
        btnJoin.parentElement!.style.display = 'none';
        (document.querySelector('.section div:nth-child(2)') as HTMLElement).style.display = 'none'; // The "OR"
        btnDisconnect.style.display = 'block';
        voiceSection.style.display = 'block';
        participantsSection.style.display = 'block';
        chatSection.style.display = 'block';
    } else {
        btnStart.parentElement!.style.display = 'block';
        btnJoin.parentElement!.style.display = 'block';
        (document.querySelector('.section div:nth-child(2)') as HTMLElement).style.display = 'block';
        btnDisconnect.style.display = 'none';
        voiceSection.style.display = 'none';
        participantsSection.style.display = 'none';
        chatSection.style.display = 'none';

        stopVoice();
        voiceToggle.checked = false;
        // Clear participants and chat?
        participantsList.innerHTML = '';
        chatMessages.innerHTML = '';
    }
}

// Handlers
btnStart.addEventListener('click', () => {
    const port = parseInt(inputPort.value);
    vscode.postMessage({ command: 'startServer', port });
});

btnJoin.addEventListener('click', () => {
    const address = inputAddress.value;
    vscode.postMessage({ command: 'joinServer', address });
});

btnDisconnect.addEventListener('click', () => {
    vscode.postMessage({ command: 'disconnect' });
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
        // Check if there are spaces between @ and cursor (allow spaces in names? usually no for simple autocomplete)
        // Let's assume username has no spaces or we just match until cursor
        const query = text.substring(lastAt + 1, cursor);
        if (!query.includes(' ')) {
            mentionActive = true;
            mentionFilter = query;
            renderMentions();
            // Position popup
            const rect = chatInput.getBoundingClientRect();
            mentionList.style.display = 'block'; // Make it visible to calculate offsetHeight

            // Position above the input
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

        li.addEventListener('mousedown', (e) => { // mousedown happens before blur
            e.preventDefault();
            mentionIndex = i;
            applyMention();
        });

        mentionList.appendChild(li);
    });

    // Update position in case list height changed
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

// Message Listener (from Extension Host)
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
        case 'identity':
            username = message.username;
            usernameDisplay.textContent = username ? `Logged in as: ${username}` : 'Error: git config user.name not set';

            if (message.iceServers) {
                 // Format for our simple text area which expects JSON string
                 // Only using the first STUN server for simplicity in the UI default,
                 // but real logic should use the array.
                 // Actually, let's just populate the input.
                 // The input expects a JSON array of RTCIceServer objects OR just strings?
                 // The default text is `[{"urls":"stun:..."}]`.
                 // The extension passes an array of strings (from package.json default).

                 const formatted = message.iceServers.map((url: string) => ({ urls: url }));
                 iceServersInput.value = JSON.stringify(formatted);
            }

            if (!username) {
                btnStart.disabled = true;
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
            message.users.forEach((u: any) => addUserToUI(u.sessionId, u.username, u.color));
            break;
        case 'user-left':
            removeUserFromUI(message.sessionId);
            break;
        case 'chat-message':
            addChatMessage(message);
            break;
    }
});

function addUserToUI(sessionId: string, name: string, color: string) {
    if (document.getElementById(`user-${sessionId}`)) {return;}
    participants.push({ sessionId, username: name, color });
    const li = document.createElement('li');
    li.id = `user-${sessionId}`;
    li.style.color = color;
    li.style.fontWeight = 'bold';
    li.textContent = name;
    participantsList.appendChild(li);
}

function removeUserFromUI(sessionId: string) {
    const el = document.getElementById(`user-${sessionId}`);
    if (el) {el.remove();}
    const idx = participants.findIndex(p => p.sessionId === sessionId);
    if (idx !== -1) { participants.splice(idx, 1); }
}

function addChatMessage(message: any) {
    const sender = message.username;
    const text = message.text;
    const color = message.color;
    const timestamp = message.timestamp;
    const reference = message.reference; // { file, startLine, endLine, content }

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

    // Close all peers
    peers.forEach(pc => pc.close());
    peers.clear();

    voiceStatus.textContent = "Voice: Off";
}

async function getOrCreatePeer(senderId: string) {
    if (peers.has(senderId)) {return peers.get(senderId)!;}

    // Parse ICE servers
    let iceServers = [];
    try {
        iceServers = JSON.parse(iceServersInput.value);
    } catch (e) { }

    const newPc = new RTCPeerConnection({ iceServers });

    // Add local tracks
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
                targetSessionId: senderId, // Send specifically to this peer
                signal: { type: 'candidate', candidate: event.candidate }
            });
        }
    };

    peers.set(senderId, newPc);
    return newPc;
}

async function handleWebRTCSignalRefined(signal: any, senderId: string) {
    if (!voiceToggle.checked) {return;} // Ignore if voice disabled

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
