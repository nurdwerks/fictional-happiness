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
    } else {
        btnStart.parentElement!.style.display = 'block';
        btnJoin.parentElement!.style.display = 'block';
        (document.querySelector('.section div:nth-child(2)') as HTMLElement).style.display = 'block';
        btnDisconnect.style.display = 'none';
        voiceSection.style.display = 'none';

        stopVoice();
        voiceToggle.checked = false;
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
            initiateConnection(message.sessionId);
            break;
    }
});

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
    if (peers.has(senderId)) return peers.get(senderId)!;

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
    if (!voiceToggle.checked) return; // Ignore if voice disabled

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
    if (!voiceToggle.checked) return;
    const peer = await getOrCreatePeer(targetId);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    vscode.postMessage({
        command: 'webrtc-signal',
        targetSessionId: targetId,
        signal: { type: 'offer', sdp: peer.localDescription }
    });
}
