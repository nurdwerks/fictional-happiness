# Collab Code OT

A real-time collaboration extension for VS Code using Operational Transformation (OT) and WebRTC for voice chat. This extension allows developers to collaborate on code in real-time, share terminal output, and communicate via text and voice, all within VS Code.

## Features

*   **Real-time Collaboration:** Edit files simultaneously with other users. Changes are synchronized using Operational Transformation to ensure consistency.
*   **Presence:** See other users' cursors and selections in real-time.
*   **Voice Chat:** Built-in WebRTC voice chat to talk while you code.
*   **Chat:** Text chat with support for mentions and code references.
*   **Code References:** Easily share a link to a specific block of code in the chat.
*   **Shared Terminal Output:** Broadcast the output of shell commands to all connected users.
*   **Follow Mode:** Click "Follow" on a user in the participant list to automatically scroll to their location.

## Usage

### Getting Started

1.  Open the **Collab Code** view from the Activity Bar (icon looks like a person).
2.  **Identity:** The extension tries to use your Git username. You can override this in settings if needed.

### Hosting a Session

1.  In the **Connection** section, enter a **Port** (default is 3000).
2.  Click **Start Local Server**.
3.  The server starts locally on your machine. You need to share your IP address (and ensure the port is open) or use a tunneling service (like ngrok) to let others join.
    *   *Note: If you are on the same local network, your local IP will work.*

### Joining a Session

1.  In the **Connection** section, enter the **Address** of the host (e.g., `ws://192.168.1.5:3000` or `wss://your-tunnel.ngrok.io`).
2.  Click **Join Server**.

### During a Session

*   **Editing:** Just edit files as normal. Changes are synced.
*   **Chat:** Use the chat box at the bottom of the sidebar.
    *   Type `@` to mention a user.
    *   Right-click in the editor and select **Add Code Reference to Chat** to share code snippets.
*   **Voice:** Toggle "Enable Voice Chat" to join the voice channel.
*   **Follow Mode:** In the "Participants" list, click "Follow" next to a user's name to track their movement.
*   **Shared Terminal:**
    *   Run the command `Collab Code: Run Shared Command (Broadcast Output)` from the Command Palette (`Ctrl+Shift+P`).
    *   Enter a shell command (e.g., `npm test`, `ls -la`).
    *   The output will be shown in the "Shared Output" section of the sidebar for all users.

## Configuration

This extension can be configured via VS Code Settings (`Ctrl+,`).

| Setting | Default | Description |
| :--- | :--- | :--- |
| `collabCode.defaultPort` | `3000` | The default port used when starting a local server. |
| `collabCode.username` | `""` | Override your display name. If empty, it defaults to your Git `user.name`. |
| `collabCode.stunServers` | `["stun:stun.l.google.com:19302"]` | List of STUN servers to use for WebRTC (Voice Chat). |
| `collabCode.turnServers` | `[]` | List of TURN servers to use for WebRTC (required if behind strict firewalls). |

## Commands

*   `collabCode.addReference`: Adds a reference to the currently selected code into the chat.
*   `collabCode.runSharedCommand`: Runs a shell command and broadcasts the output to all connected users.

## Requirements

*   Node.js (for the extension host).
*   Network connectivity between host and clients.

## Known Issues

*   This is a proof-of-concept OT implementation. Conflict resolution in complex scenarios might have edge cases.
*   File creation/deletion synchronization is basic.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](LICENSE)
