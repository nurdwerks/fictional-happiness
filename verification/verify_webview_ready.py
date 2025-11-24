from playwright.sync_api import sync_playwright, Page, expect
import os
import time

def test_webview_retry(page: Page):
    # Mock acquireVsCodeApi
    page.add_init_script("""
        window.messages = [];
        window.acquireVsCodeApi = () => {
            return {
                postMessage: (msg) => {
                    window.messages.push(msg);
                    console.log('Message posted:', msg);
                },
                setState: () => {},
                getState: () => {}
            };
        };

        // Helper to receive messages from "extension"
        window.receiveMessage = (msg) => {
            window.dispatchEvent(new MessageEvent('message', { data: msg }));
        };
    """)

    # Load the page
    cwd = os.getcwd()
    file_path = f"file://{cwd}/dist/index.html"
    print(f"Loading {file_path}")
    page.goto(file_path)

    # Wait for the first 'ready' message
    print("Waiting for first ready message...")
    page.wait_for_function("window.messages.length > 0")

    # Check if first message is ready
    messages = page.evaluate("window.messages")
    print("Messages:", messages)
    assert messages[0]['command'] == 'ready'

    # Wait for > 1 second to see if it retries (interval is 1000ms)
    print("Waiting for retry...")
    time.sleep(1.5)

    count_before = page.evaluate("window.messages.length")
    print(f"Message count after delay: {count_before}")
    assert count_before >= 2, "Should have retried sending ready"

    # Now send identity to stop the interval
    print("Sending identity...")
    page.evaluate("""
        window.receiveMessage({
            type: 'identity',
            username: 'Test User'
        });
    """)

    # Verify UI update
    expect(page.locator("#username-display")).to_have_text("Logged in as: Test User")

    # Wait another 1.5 seconds to ensure no more messages
    print("Waiting to verify retry stopped...")
    time.sleep(1.5)

    count_after = page.evaluate("window.messages.length")
    print(f"Message count final: {count_after}")

    # It might send one more if the interval fired just before clearing?
    # But roughly it should stop.
    # Actually, we can check if the count increased by much less than expected if it continued.
    # If it continued, in 1.5s we'd expect +1 or +2.
    # If stopped, +0.

    assert count_after == count_before or count_after == count_before + 1, "Should stop sending ready after identity"

    # Take screenshot
    page.screenshot(path="verification/webview_ready.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            test_webview_retry(page)
            print("Test passed!")
        except Exception as e:
            print(f"Test failed: {e}")
            page.screenshot(path="verification/failure.png")
            raise e
        finally:
            browser.close()
