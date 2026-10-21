"""
verify/ui-harness/shot.py — 截图 + 收集 JS 错误（用 intake venv 里的 playwright）
"""

import asyncio, os, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "shots")
os.makedirs(OUT, exist_ok=True)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7791


async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        # 用本机 Chrome（headless_shell 没装，且不想为截图再下个浏览器）
        browser = await p.chromium.launch(channel="chrome")
        page = await browser.new_page(viewport={"width": 1400, "height": 900}, device_scale_factor=2)

        errors = []
        page.on("console", lambda m: errors.append("[console." + m.type + "] " + m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("[pageerror] " + str(e)))

        targets = [
            ("studio.html", "studio-notes.png"),
            ("panel.html", "panel.png"),
            ("settings.html", "settings.png"),
        ]

        for f, out in targets:
            errors.clear()
            await page.goto(f"http://127.0.0.1:{PORT}/{f}", wait_until="networkidle")
            await page.wait_for_timeout(900)
            await page.screenshot(path=os.path.join(OUT, out))
            print(f"\n=== {f} -> {out} ===")
            if errors:
                for e in errors:
                    print("  X " + e[:200])
            else:
                print("  OK 无 JS 错误")

        # 主卡切页签
        await page.goto(f"http://127.0.0.1:{PORT}/studio.html", wait_until="networkidle")
        await page.wait_for_timeout(700)
        for tab in ("rhythm", "ledger", "setup"):
            el = await page.query_selector(f'nav.tabs a[data-tab="{tab}"]')
            if not el:
                print(f"\n=== tab {tab} === 找不到页签")
                continue
            await el.click()
            await page.wait_for_timeout(400)
            await page.screenshot(path=os.path.join(OUT, f"tab-{tab}.png"))
            print(f"\n=== tab {tab} === 已截图")

        await browser.close()
        print("\n截图目录:", OUT)

asyncio.run(main())
