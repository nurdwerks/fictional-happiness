
import os
from playwright.sync_api import sync_playwright

def verify_webview_styling():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Get absolute path to index.html
        cwd = os.getcwd()
        html_path = os.path.join(cwd, 'src/webview/index.html')
        url = f'file://{html_path}'

        print(f"Navigating to {url}")
        page.goto(url)

        # Inject VS Code CSS variables to simulate the environment
        # We use default VS Code Dark Modern theme colors for verification
        css_vars = """
            :root {
                --vscode-font-family: "Segoe UI", "Helvetica Neue", sans-serif;
                --vscode-font-size: 13px;
                --vscode-font-weight: normal;
                --vscode-foreground: #cccccc;
                --vscode-editor-background: #1f1f1f;
                --vscode-widget-border: #454545;
                --vscode-input-background: #3c3c3c;
                --vscode-input-foreground: #cccccc;
                --vscode-input-border: #3c3c3c;
                --vscode-focusBorder: #007fd4;
                --vscode-input-placeholderForeground: #a6a6a6;
                --vscode-button-background: #0e639c;
                --vscode-button-foreground: #ffffff;
                --vscode-button-hoverBackground: #1177bb;
                --vscode-button-secondaryBackground: #3a3d41;
                --vscode-button-secondaryForeground: #ffffff;
                --vscode-button-secondaryHoverBackground: #45494e;
                --vscode-list-hoverBackground: #2a2d2e;
                --vscode-list-activeSelectionBackground: #37373d;
                --vscode-list-activeSelectionForeground: #ffffff;
                --vscode-errorForeground: #f14c4c;
                --vscode-testing-iconPassed: #73c991;
                --vscode-testing-iconFailed: #f14c4c;
                --vscode-terminal-background: #1e1e1e;
                --vscode-terminal-foreground: #cccccc;
                --vscode-panel-border: #80808059;
                --vscode-statusBar-background: #007fd4;
                --vscode-statusBar-foreground: #ffffff;
                --vscode-statusBar-noFolderBackground: #68217a;
                --vscode-statusBarItem-warningBackground: #e2c08d;
                --vscode-statusBarItem-warningForeground: #333333;
                --vscode-textLink-foreground: #3794ff;
                --vscode-textBlockQuote-border: #007fd4;
                --vscode-textBlockQuote-background: #007fd41a;
                --vscode-descriptionForeground: #ccccccb3;
                --vscode-scrollbarSlider-background: #79797966;
                --vscode-scrollbarSlider-hoverBackground: #646464b3;
                --vscode-scrollbarSlider-activeBackground: #bfbfbf66;
            }
        """

        page.add_style_tag(content=css_vars)

        # Simulate some state (connected) to show more UI
        # We need to mock `acquireVsCodeApi` or just manipulate DOM directly since the script won't run without it
        # We'll manipulate DOM to show sections

        page.evaluate("""
            () => {
                document.getElementById('status-display').className = 'status connected';
                document.getElementById('status-display').textContent = 'Connected';

                document.getElementById('connection-section').style.display = 'none'; // Hide connection

                document.getElementById('participants-section').style.display = 'block';
                const list = document.getElementById('participants-list');

                // Add mock participant
                const li = document.createElement('li');
                li.className = 'participant-item';
                li.innerHTML = `
                    <span style="color: #f0f;">User1</span>
                    <div>
                        <button class="follow-btn secondary">Follow</button>
                    </div>
                `;
                list.appendChild(li);

                document.getElementById('chat-section').style.display = 'block';
                const chat = document.getElementById('chat-messages');
                const msg = document.createElement('div');
                msg.textContent = 'User1: Hello world';
                chat.appendChild(msg);

                document.getElementById('pending-section').style.display = 'block';
                const pendingList = document.getElementById('pending-list');
                const pReq = document.createElement('div');
                pReq.className = 'pending-request';
                pReq.innerHTML = `
                    User2 wants to join.
                    <div style="margin-top: 5px; display: flex; gap: 5px;">
                        <button class="approve-btn">Approve</button>
                        <button class="reject-btn">Reject</button>
                    </div>
                `;
                pendingList.appendChild(pReq);
            }
        """)

        # Take screenshot
        output_path = os.path.join(cwd, 'verification/webview.png')
        page.screenshot(path=output_path, full_page=True)
        print(f"Screenshot saved to {output_path}")

if __name__ == "__main__":
    verify_webview_styling()
