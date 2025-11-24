from playwright.sync_api import sync_playwright

def verify_frontend():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # Inject the mock acquireVsCodeApi before the page loads
        page.add_init_script("""
            window.acquireVsCodeApi = () => ({
                postMessage: (msg) => {
                    console.log('Message sent:', msg);
                    window.lastMessage = msg;
                }
            });
        """)

        # Load the local HTML file
        # Note: We need absolute path for file://
        import os
        cwd = os.getcwd()
        file_path = f"file://{cwd}/dist/index.html"
        page.goto(file_path)

        # 1. Verify "Pending Requests" section is hidden initially
        pending_section = page.locator("#pending-section")
        if pending_section.is_visible():
             print("Error: Pending section should be hidden initially")

        # 2. Simulate "Is Host" message
        page.evaluate("""
            window.postMessage({ type: 'is-host', value: true }, '*');
        """)

        # 3. Simulate "User Request" message
        page.evaluate("""
            window.postMessage({ type: 'user-request', sessionId: 'user-123', username: 'GuestUser' }, '*');
        """)

        # 4. Verify Pending Section appears with correct user
        pending_section.wait_for(state="visible")
        user_request = page.locator("#pending-user-123")
        # I didn't create id `pending-user-123`, I created `pending-{sessionId}`
        user_request = page.locator("#pending-user-123")

        # Wait, looking at webview.ts:
        # div.id = `pending-${sessionId}`;

        user_request = page.locator("#pending-user-123")
        if user_request.count() == 0:
             print("User request element found?")

        # Check text
        if "GuestUser wants to join" not in page.content():
             print("Text not found")

        # 5. Take Screenshot
        page.screenshot(path="verification/frontend_verification.png")
        print("Screenshot taken")

        browser.close()

if __name__ == "__main__":
    verify_frontend()
