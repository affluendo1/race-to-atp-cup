from __future__ import annotations
import asyncio, json, os, re
from pathlib import Path
from playwright.async_api import async_playwright

URL = "https://www.trols.org.au/brta/results.php"
OUT = Path("debug/trols")
OUT.mkdir(parents=True, exist_ok=True)

async def dump(page, label):
    html = await page.content()
    (OUT / f"{label}.html").write_text(html, encoding="utf-8")
    (OUT / f"{label}.txt").write_text((await page.locator("body").inner_text())[:100000], encoding="utf-8")
    info = []
    for i in range(await page.locator("select").count()):
        s = page.locator("select").nth(i)
        info.append({
            "index": i,
            "name": await s.get_attribute("name"),
            "id": await s.get_attribute("id"),
            "options": await s.locator("option").all_text_contents(),
            "values": await s.locator("option").evaluate_all("(els)=>els.map(e=>e.value)")
        })
    links = []
    for i in range(min(await page.locator("a").count(), 400)):
        a = page.locator("a").nth(i)
        links.append({"text": (await a.inner_text()).strip(), "href": await a.get_attribute("href")})
    payload = {"url": page.url, "title": await page.title(), "selects": info, "links": links}
    (OUT / f"{label}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("\n===", label, "===")
    print(json.dumps(payload, indent=2)[:30000])

async def choose_matching_option(page, patterns):
    for si in range(await page.locator("select").count()):
        s = page.locator("select").nth(si)
        opts = await s.locator("option").all_text_contents()
        vals = await s.locator("option").evaluate_all("(els)=>els.map(e=>e.value)")
        for pat in patterns:
            for oi, text in enumerate(opts):
                if re.search(pat, text, re.I):
                    print("Selecting", repr(text), "value", repr(vals[oi]), "from select", si)
                    before = page.url
                    try:
                        async with page.expect_navigation(timeout=6000):
                            await s.select_option(index=oi)
                    except Exception:
                        await s.select_option(index=oi)
                        await page.wait_for_timeout(2500)
                    print("URL:", before, "->", page.url)
                    return True
    return False

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36"
        )
        page = await context.new_page()
        page.set_default_timeout(12000)
        await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        await dump(page, "00-results")

        # TROLS remembers competition choice in cookies. Prefer the current
        # Sunday AM 2026 competition, with Spring 2026 first if available.
        picked = await choose_matching_option(page, [
            r"Sunday\s*AM.*Spring\s*2026",
            r"Sunday\s*AM.*2026",
            r"Sunday\s*AM"
        ])
        if picked:
            await page.wait_for_timeout(2000)
            await dump(page, "01-competition")

        # If the page exposes a section selector, choose Section 6.
        picked_section = await choose_matching_option(page, [r"Sets 6"])
        if picked_section:
            await page.wait_for_timeout(2000)
            await dump(page, "02-section6")
            try:
                fn = await page.evaluate("open_match.toString()")
                print("OPEN_MATCH_FUNCTION:", fn)
                (OUT / "open_match.js").write_text(fn, encoding="utf-8")
            except Exception as e:
                print("Could not inspect open_match:", e)
            # Open one known completed scorecard so we can inspect its DOM.
            try:
                await page.goto("https://www.trols.org.au/brta/match_popup.php?matchid=UA009094&seasonid=", wait_until="domcontentloaded")
                await page.wait_for_timeout(1500)
                await dump(page, "03-scorecard")
            except Exception as e:
                print("Could not open sample scorecard:", e)

        # Save cookies because they reveal which state TROLS uses.
        (OUT / "cookies.json").write_text(json.dumps(await context.cookies(), indent=2), encoding="utf-8")
        await page.screenshot(path=str(OUT / "page.png"), full_page=True)
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
