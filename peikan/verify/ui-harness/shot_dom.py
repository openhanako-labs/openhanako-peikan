import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1400, "height": 1200})
        await page.goto("http://127.0.0.1:7804/studio.html")
        await page.wait_for_timeout(3000)

        info = await page.evaluate("""() => {
          const lis = [...document.querySelectorAll('#notes-list li')];
          return {
            liCount: lis.length,
            firstLiHtml: lis[0] ? lis[0].innerHTML.slice(0, 400) : null,
            coverCount: document.querySelectorAll('.cover').length,
            imgCount: document.querySelectorAll('#notes-list img').length,
            notesHidden: document.getElementById('notes-empty')?.hidden,
            sub: document.getElementById('page-sub')?.textContent,
          };
        }""")
        for k, v in info.items():
            print(f"{k}: {v}")
        await b.close()

asyncio.run(main())
