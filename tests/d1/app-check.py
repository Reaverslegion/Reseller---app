# Opens the EXACT phone app page of version 2.0.122 (built from commit 490a27e) in a browser, connected to the isolated TEST
# Scan service, which has a simulated eBay pause. Checks that the existing app shows the pause clearly. No eBay requests.
# Run: TEST_SVC_URL=... TEST_SVC_KEY=... python3 tests/d1/app-check.py app-122.html results/
import os, re, sys
from playwright.sync_api import sync_playwright
APP, OUT = sys.argv[1], sys.argv[2]; URL, KEY = os.environ["TEST_SVC_URL"], os.environ["TEST_SVC_KEY"]
MSG = re.compile(r"eBay's daily limit is reached: eBay searches and checks paused until \d\d:\d\d \(UK time\), when eBay resets it")
os.makedirs(OUT, exist_ok=True); res = []
def add(name, ok, detail=""): res.append(ok); print(("PASS " if ok else "FAIL ") + name + (f"  — {detail}" if detail else ""), flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 412, "height": 900})
    pg.goto("file://" + os.path.abspath(APP)); pg.wait_for_function("typeof render==='function'")
    add("the page is the installed version (2.0.122 build)", "VER" in pg.content())
    pg.evaluate("""([u,k])=>{localStorage.setItem('flipscout_seen_v2','1');S.set.url=u;S.set.key=k;S.set.admin=true;
      const h=H();if(!h.cats.length)h.cats=[{id:'27386',name:'Graphics Cards'}];save();}""", [URL, KEY])
    pg.reload(); pg.wait_for_function("typeof render==='function'")
    pg.evaluate("()=>{try{document.getElementById('onb').style.display='none'}catch(e){} tab='deals';HD.busy=false;loadDeals().then(render)}")
    pg.wait_for_function("(HD.deals||[]).length>0 || !!HD.err", timeout=60000); pg.wait_for_timeout(1500)
    t = pg.inner_text("#app")
    add("deals load from the test Scan service while paused", pg.evaluate("(HD.deals||[]).length") > 0, f"{pg.evaluate('(HD.deals||[]).length')} deals")
    add("Deals screen (admin) shows the pause message", bool(MSG.search(t)))
    add("header shows the last real scan ('Scanned 3h ago')", "Scanned 3h ago" in t)
    add("no misleading 'Couldn't refresh'", "Couldn't refresh" not in t)
    pg.screenshot(path=OUT + "/1-deals-top.png")
    pos = pg.evaluate("""()=>{const el=[...document.querySelectorAll('.hint.warn')].find(e=>/paused until/.test(e.innerText));if(!el)return null;
      const r=el.getBoundingClientRect();return {y:Math.round(r.top+scrollY),page:document.body.scrollHeight,cardsAbove:[...document.querySelectorAll('.dcard')].filter(c=>c.getBoundingClientRect().top<r.top).length}}""")
    print("   where the message is:", pos, flush=True)
    if pos: pg.evaluate("(y)=>scrollTo(0,y-400)", pos["y"]); pg.wait_for_timeout(300); pg.screenshot(path=OUT + "/2-deals-message.png")
    pg.evaluate("()=>{scrollTo(0,0);huntNow()}")
    try: pg.wait_for_function("document.body.innerText.includes('Check had problems')", timeout=20000)
    except Exception: pass
    body = pg.inner_text("body")
    add("Scan now shows 'Check had problems: <pause message>'", bool(re.search(r"Check had problems: " + MSG.pattern, body)))
    add("Scan now doesn't show 'Couldn't refresh'", "Couldn't refresh" not in body)
    pg.screenshot(path=OUT + "/3-scan-now.png")
    pg.evaluate("()=>{S.base=[{id:9,name:'RTX 3080',q:'rtx 3080',med:330,cons:0,post:5,pack:1,cat:'27386'}];save();runScan(S.base,'test')}"); pg.wait_for_timeout(8000)
    body = pg.inner_text("body")
    add("price-book search shows the pause message (not 'service error')", bool(MSG.search(body)) and "service error" not in body)
    pg.screenshot(path=OUT + "/4-price-search.png")
    b.close()
sys.exit(0 if all(res) else 1)
