"""Take the 4 FERROLINE screenshots in headless Chromium and report console errors."""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8090"
SHOTS = [
    ("1-start.jpg", "?shot=start&seed=1"),
    ("2-play.jpg", "?shot=play&seed=1"),
    ("3-buy.jpg", "?shot=buy&seed=1"),
    ("4-end.jpg", "?shot=end&seed=1"),
]
OUT = "/home/hatch/workspace/makefun-vm/threejs-fps-01/screenshots"

errors = []
failed_requests = []


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--enable-unsafe-swiftshader",
                "--use-angle=swiftshader",
                "--disable-gpu-sandbox",
                "--no-sandbox",
            ],
        )
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: failed_requests.append(f"{r.url} :: {r.failure}"))

        # Plain load first: the menu must render with no errors.
        page.goto(BASE + "/", wait_until="load")
        page.wait_for_timeout(2500)
        webgl = page.evaluate("() => { const c = document.createElement('canvas'); return !!c.getContext('webgl2'); }")
        print("webgl2 available:", webgl)
        print("menu overlay visible:", page.evaluate("() => !document.getElementById('overlay').hidden"))

        for name, query in SHOTS:
            page.goto(BASE + "/" + query, wait_until="load")
            try:
                page.wait_for_function("() => window.__shotReady === true", timeout=90000)
            except Exception as exc:
                print(f"{name}: SHOT NOT READY: {exc}")
                continue
            page.wait_for_timeout(300)
            page.screenshot(path=f"{OUT}/{name}", type="jpeg", quality=88)
            print(f"{name}: saved")

        # Let the live loop run a bit in shot mode off: check the rAF loop stays clean.
        page.goto(BASE + "/?shot=play&seed=1", wait_until="load")
        page.wait_for_function("() => window.__shotReady === true", timeout=90000)
        page.wait_for_timeout(1000)
        browser.close()

    print("\n--- console errors/warnings ---")
    print("\n".join(errors) if errors else "(none)")
    print("--- failed requests ---")
    print("\n".join(failed_requests) if failed_requests else "(none)")


if __name__ == "__main__":
    main()
