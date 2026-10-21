import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1400, "height": 900})
        logs = []
        page.on("console", lambda m: logs.append((m.type, m.text)))
        page.on("pageerror", lambda e: logs.append(("PAGEERROR", str(e))))
        await page.goto("http://127.0.0.1:7804/studio.html")
        await page.wait_for_timeout(2500)
        for t, m in logs:
            if t in ("error", "PAGEERROR"):
                print(f"[{t}] {m[:300]}")
        if not any(t in ("error", "PAGEERROR") for t, _ in logs):
            print("无错误")
        await b.close()

asyncio.run(main())
