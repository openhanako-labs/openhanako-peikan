import asyncio

PORT = 7792

async def main():
    import sys
    sys.path.insert(0, r"C:\Users\Administrator\.hanako\app-data\bilibili-intake-v2\.runtime\venv-win\Lib\site-packages")
    from patchright.async_api import async_playwright

    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1280, "height": 1100}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))

        await page.goto(f"http://127.0.0.1:{PORT}/studio.html")
        await page.wait_for_timeout(2500)

        # 互动页
        await page.click('a[data-tab="inbox"]')
        await page.wait_for_timeout(1800)
        await page.screenshot(path="shots/_new-inbox.png")

        info_inbox = await page.evaluate("""() => {
          const q = (s) => document.querySelector(s);
          const rect = (s) => { const e = q(s); if (!e) return null; const r = e.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; };
          return {
            panelVisible: q('[data-panel="inbox"]')?.dataset.active === 'true' ||
                          q('[data-panel="inbox"]')?.offsetParent !== null,
            digestListChildren: q('#digest-list')?.children.length ?? -1,
            digestStatus: q('#digest-status')?.textContent ?? null,
            digestBtn: rect('#digest-run'),
            allowListChildren: q('#allow-list')?.children.length ?? -1,
            emptyHidden: q('#digest-empty')?.hidden,
          };
        }""")
        print("互动页:", info_inbox)

        # 学到页
        await page.click('a[data-tab="learned"]')
        await page.wait_for_timeout(1800)
        await page.screenshot(path="shots/_new-learned.png")

        info_learned = await page.evaluate("""() => {
          const q = (s) => document.querySelector(s);
          return {
            panelVisible: q('[data-panel="learned"]')?.offsetParent !== null,
            tasteGridChildren: q('#taste-grid')?.children.length ?? -1,
            tasteGridHTML: (q('#taste-grid')?.textContent || '').slice(0, 100),
            tasteListChildren: q('#taste-list')?.children.length ?? -1,
            silenceState: q('#silence-state')?.textContent ?? null,
            silenceQuota: q('#silence-quota')?.textContent ?? null,
            likesChildren: q('#likes-list')?.children.length ?? -1,
          };
        }""")
        print("学到页:", info_learned)

        # 账本页（撤回）
        await page.click('a[data-tab="ledger"]')
        await page.wait_for_timeout(1500)
        await page.screenshot(path="shots/_new-ledger.png")

        info_ledger = await page.evaluate("""() => {
          const q = (s) => document.querySelector(s);
          return {
            sentListChildren: q('#sent-list')?.children.length ?? -1,
            retractBtns: document.querySelectorAll('.js-retract').length,
            quotaGridChildren: q('#quota-grid')?.children.length ?? -1,
          };
        }""")
        print("账本页:", info_ledger)

        print("\n控制台错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
