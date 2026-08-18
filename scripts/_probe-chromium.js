// TEMPORARY probe — deleted before the PR. Can Chromium launch here at all?
const { chromium } = require('playwright');
(async () => {
  try {
    const b = await chromium.launch({ headless: true });
    const p = await b.newPage();
    await p.setContent('<h1 id="x">hello</h1>');
    const t = await p.textContent('#x');
    const ver = b.version();
    await b.close();
    console.log('CHROMIUM_OK version=' + ver + ' text=' + t);
  } catch (e) {
    console.log('CHROMIUM_FAIL ' + e.message);
  }
})();
