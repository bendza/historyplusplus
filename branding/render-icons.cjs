const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
// Needs Playwright (`npm i -D playwright`) and a Chromium; set CHROMIUM_PATH or use Playwright's bundled one.
const EXE = process.env.CHROMIUM_PATH || undefined;
const big = fs.readFileSync(path.join(ROOT, 'branding/icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(ROOT, 'branding/icon-small.svg'), 'utf8');
const b64 = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');
(async () => {
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  fs.mkdirSync(path.join(ROOT, 'public/icon'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'branding/store'), { recursive: true });
  // Toolbar / manifest icons. 128: artwork 96 px inside a 16 px transparent margin (Chrome Web Store guideline).
  const icons = [[16, small, 0], [32, big, 0], [48, big, 2], [128, big, 16]];
  for (const [n, svg, pad] of icons) {
    await page.setViewportSize({ width: n, height: n });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${b64(svg)}" style="display:block;margin:${pad}px;width:${n - 2 * pad}px;height:${n - 2 * pad}px"></body></html>`);
    await page.screenshot({ path: path.join(ROOT, `public/icon/${n}.png`), omitBackground: true });
  }
  fs.copyFileSync(path.join(ROOT, 'public/icon/128.png'), path.join(ROOT, 'branding/store/icon-128.png'));
  // Promo tiles.
  const tile = (w, h, iconPx, wordPx, tagPx) => `<html><head><style>@font-face{font-family:Figtree;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'public/fonts/figtree-latin-wght.woff2')).toString('base64')}) format('woff2-variations');font-weight:300 900}
    body{margin:0;width:${w}px;height:${h}px;background:#2b2f86;font-family:Figtree,sans-serif;display:flex;align-items:center;justify-content:center;gap:${Math.round(iconPx * 0.35)}px;color:#fff}
    .t{display:flex;flex-direction:column;gap:${Math.round(tagPx * 0.5)}px}.w{font-weight:800;font-size:${wordPx}px;letter-spacing:-0.03em;line-height:1}.g{font-size:${tagPx}px;color:#d9dcff;font-weight:500;max-width:${Math.round(w * 0.5)}px;line-height:1.3}</style></head>
    <body><img src="${b64(big)}" width="${iconPx}" height="${iconPx}"><div class="t"><div class="w">history++</div><div class="g">Every page you visit, kept forever on your computer. Find it by what it was about.</div></div></body></html>`;
  for (const [name, w, h, i, wd, tg] of [['promo-small-440x280', 440, 280, 96, 40, 13], ['marquee-1400x560', 1400, 560, 240, 104, 30]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(tile(w, h, i, wd, tg), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, `branding/store/${name}.png`) });
  }
  await browser.close();
  console.log(fs.readdirSync(path.join(ROOT, 'public/icon')).join(' '), '|', fs.readdirSync(path.join(ROOT, 'branding/store')).join(' '));
})();
