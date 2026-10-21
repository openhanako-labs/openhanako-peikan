import asyncio
import sys

sys.path.insert(0, r"C:\Users\Administrator\.hanako\app-data\bilibili-intake-v2\.runtime\venv-win\Lib\site-packages")
from patchright.async_api import async_playwright

PORT = 7801


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1280, "height": 1200}, device_scale_factor=2)

        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(f"pageerror: {e}"))

        await page.goto(f"http://127.0.0.1:{PORT}/studio.html")
        await page.wait_for_timeout(4000)

        # 笔记本页：检查封面
        info = await page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('#notes-list img[data-cover]')];
          const loaded = imgs.filter(i => i.dataset.loaded === '1');
          const visible = imgs.filter(i => i.offsetParent !== null);
          const broken = imgs.filter(i => i.dataset.loaded !== '1' && i.offsetParent !== null);

          // 前几条的标题和 meta
          const items = [...document.querySelectorAll('#notes-list > li')].slice(0, 6).map(li => ({
            标题: (li.querySelector('h3') || {}).textContent || '',
            meta: (li.querySelector('.meta') || {}).textContent || '',
            有封面: !!li.querySelector('.cover img[data-loaded="1"]'),
          }));

          return {
            总图数: imgs.length,
            已加载: loaded.length,
            可见: visible.length,
            加载失败: broken.length,
            前几条: items,
          };
        }""")

        print("=== 笔记本页 ===")
        print(f"  图片节点 {info['总图数']} · 已加载 {info['已加载']} · 失败 {info['加载失败']}")
        print()
        for x in info["前几条"]:
            mark = "✓" if x["有封面"] else "✗"
            print(f"  [{mark}] {x['标题'][:24]:26s} | {x['meta'][:52]}")

        await page.screenshot(path="shots/_final-notes.png")

        print()
        print("控制台错误:", errs[:5] if errs else "无")
        await b.close()


asyncio.run(main())
