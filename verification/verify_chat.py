
from playwright.sync_api import Page, expect, sync_playwright
import os

def test_chat_ui(page: Page):
    """
    Verifies the chat UI, mentions, and code references.
    Since we cannot easily launch VS Code's webview in this environment,
    we will load the index.html directly and mock the vscode API.
    """

    # Path to the HTML file
    cwd = os.getcwd()
    html_path = f"file://{cwd}/dist/index.html"

    # Go to the page
    page.goto(html_path)

    # Inject a mock vscode API
    page.evaluate("""
        window.acquireVsCodeApi = () => {
            return {
                postMessage: (msg) => {
                    console.log('Message sent:', msg);
                    window.lastMessage = msg;
                },
                setState: () => {},
                getState: () => ({})
            };
        };
        // Re-run the script logic that might have failed because acquireVsCodeApi was missing
        // Actually, webview.js is loaded at end of body.
        // We need to reload the page or ensure the script runs after we inject.
        // But the script executes immediately.
        // We might need to mock it BEFORE navigation or use add_init_script.
    """)

    # Reload to apply the mock before the script runs?
    # No, add_init_script is better.

def run_test():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()

        # Mock VS Code API
        context.add_init_script("""
            window.acquireVsCodeApi = () => {
                return {
                    postMessage: (msg) => {
                        console.log('Message sent:', msg);
                        window.lastMessage = msg;

                        // Simulate server response for testing UI
                        if (msg.command === 'joinServer') {
                            window.postMessage({ type: 'connected' }, '*');
                            window.postMessage({
                                type: 'user-joined',
                                sessionId: 'user1',
                                username: 'Alice',
                                color: 'red'
                            }, '*');
                            window.postMessage({
                                type: 'user-joined',
                                sessionId: 'user2',
                                username: 'Bob',
                                color: 'blue'
                            }, '*');
                        }

                        if (msg.command === 'chat-message') {
                            // Echo back
                            window.postMessage({
                                type: 'chat-message',
                                username: 'Me',
                                text: msg.text,
                                color: 'green',
                                timestamp: Date.now()
                            }, '*');
                        }
                    },
                    setState: () => {},
                    getState: () => ({})
                };
            };
        """)

        page = context.new_page()

        cwd = os.getcwd()
        # Ensure we point to the built file which has the script injected (or not?)
        # The built file is in dist/index.html but references webview.js.
        # We need to make sure webview.js is available.
        # webpack outputs to dist/webview.js.

        html_path = f"file://{cwd}/dist/index.html"
        page.goto(html_path)

        # 1. Simulate Connection
        page.fill("#remote-address", "ws://mock-server")
        page.click("#btn-join-server")

        # Verify connected state
        expect(page.locator("#status-display")).to_have_class("status connected")

        # 2. Verify Mentions
        # Type '@'
        page.fill("#chat-input", "@")
        # Trigger input event manually if fill doesn't? Fill does.

        # Check if suggestion list appears
        # It's added to body
        suggestion_list = page.locator("#mention-suggestions")
        expect(suggestion_list).to_be_visible()

        # Check content
        expect(suggestion_list).to_contain_text("Alice")
        expect(suggestion_list).to_contain_text("Bob")

        # Select Alice (ArrowDown + Enter)
        # Assuming list order: Alice, Bob.
        # Initial index 0. ArrowDown -> 1 (Bob).
        # We want Alice?
        # If I type @, and Alice and Bob are in the list.
        # Filter is empty. Both show.
        # Mention Index is 0.
        # If I press ArrowDown, it goes to 1 (Bob).
        # If I press Enter, it selects Bob.

        # I want to select Alice. Alice is at 0.
        # So I should NOT press ArrowDown if I want Alice.
        # Or I should press ArrowDown twice to wrap around?

        # Let's just select the first one (Alice) by NOT pressing ArrowDown.
        page.press("#chat-input", "Enter")

        # Check input value
        expect(page.locator("#chat-input")).to_have_value("@Alice ")

        # 3. Verify Code Reference Rendering
        # Simulate receiving a message with code reference
        page.evaluate("""
            window.postMessage({
                type: 'chat-message',
                username: 'Bob',
                text: 'Check this out',
                color: 'blue',
                timestamp: Date.now(),
                reference: {
                    file: 'src/main.ts',
                    startLine: 10,
                    endLine: 15,
                    content: 'function test() {\\n  console.log("hello");\\n  return true;\\n}'
                }
            }, '*');
        """)

        # Check if message appeared
        chat_messages = page.locator("#chat-messages")
        expect(chat_messages).to_contain_text("Check this out")

        # Check for code block details
        details = chat_messages.locator("details")
        expect(details).to_be_visible()
        expect(details).to_contain_text("Code (4 lines)")

        # Expand
        details.click()
        expect(chat_messages.locator("pre")).to_contain_text("function test()")

        # Take Screenshot
        # Use relative path since home might differ
        cwd = os.getcwd()
        path = os.path.join(cwd, "verification/verification.png")
        page.screenshot(path=path)
        print(f"Screenshot taken at {path}")

        browser.close()

if __name__ == "__main__":
    run_test()
