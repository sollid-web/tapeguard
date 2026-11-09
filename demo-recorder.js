/**
 * TapeGuardian Demo Video Recorder
 * Uses Playwright to navigate the live site and ffmpeg to stitch a video.
 *
 * Run:  node demo-recorder.js
 * Output: demo.mp4  (in the same directory)
 */

const { chromium } = require('playwright');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const URL = 'https://tapeguard.tapeguard.workers.dev';
const OUT_DIR = path.join(__dirname, 'frames');
const VIDEO_OUT = path.join(__dirname, 'demo.mp4');
const W = 1280, H = 800;
const FPS = 10; // screenshots per second of "real time"

let frameIndex = 0;
let page;

if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR);

/* ── helpers ─────────────────────────────────────────────────────────── */
async function shot(durationMs = 1000) {
  const count = Math.max(1, Math.round((durationMs / 1000) * FPS));
  for (let i = 0; i < count; i++) {
    const name = path.join(OUT_DIR, `frame_${String(frameIndex).padStart(6,'0')}.png`);
    await page.screenshot({ path: name });
    frameIndex++;
    await sleep(1000 / FPS);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function clickTab(label) {
  await page.click(`button.tab[data-view="${label}"]`);
  await sleep(600);
}

async function scrollTo(selector) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, selector);
  await sleep(500);
}

async function typeOverlay(text) {
  // inject a floating caption
  await page.evaluate(t => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      el.style.cssText = `
        position:fixed;bottom:32px;left:50%;transform:translateX(-50%);
        background:rgba(0,0,0,0.78);color:#fff;font-size:17px;font-family:sans-serif;
        padding:10px 22px;border-radius:8px;z-index:99999;max-width:720px;
        text-align:center;line-height:1.4;pointer-events:none;
      `;
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = t ? 'block' : 'none';
  }, text);
}

/* ── main ────────────────────────────────────────────────────────────── */
(async () => {
  console.log('Launching browser…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: H } });
  page = await context.newPage();

  /* ── SCENE 1: The Problem (0:00–0:20) ─────────────────────────────── */
  console.log('Scene 1: loading site…');
  await typeOverlay('');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  await typeOverlay('An always-on trading agent — but the bot never holds a private key.');
  await shot(4000);

  /* scroll to show daemon live badge */
  await scrollTo('.status-bar, header, .chip');
  await sleep(500);
  await typeOverlay('daemon live · LIVE CONTRACTS · X Layer Testnet · Chain 1952');
  await shot(3000);

  /* ── SCENE 2: Overview — verified contracts ────────────────────────── */
  console.log('Scene 2: Overview tab…');
  await clickTab('overview');
  await typeOverlay('Two contracts deployed and verified on X Layer testnet.');
  await shot(4000);

  /* ── SCENE 3: Policy circuit tab — show limits ─────────────────────── */
  console.log('Scene 3: Policy circuit…');
  await clickTab('policy');
  await sleep(800);
  await typeOverlay('The rules: 1 OKB per trade · 5 OKB daily cap · whitelisted targets only.');
  await shot(4000);

  /* scroll down to Agent Mission Demo */
  await scrollTo('#demo-scenarios');
  await sleep(600);
  await typeOverlay('The agent proposes three actions. The PolicyCircuit decides.');
  await shot(2500);

  /* ── SCENE 4: Scenario 1 — APPROVED ───────────────────────────────── */
  console.log('Scene 4: Scenario 1 — valid trade…');
  await typeOverlay('Scenario 1: Small rebalance — 0.5 OKB. Within all limits.');
  await shot(2500);

  const btn1 = await page.$('.scenario-run[data-value="0.5"]');
  if (btn1) {
    await btn1.scrollIntoViewIfNeeded();
    await sleep(300);
    await btn1.click();
    await sleep(1200);
  }
  await typeOverlay('✅ APPROVED — all circuit rules passed. Trade would execute.');
  await shot(4000);

  /* ── SCENE 5: Scenario 2 — REJECTED per-trade cap ─────────────────── */
  console.log('Scene 5: Scenario 2 — oversized trade…');
  const btn2 = await page.$('.scenario-run[data-value="10"]');
  if (btn2) {
    await scrollTo('.demo-scenario[data-idx="1"]');
    await sleep(400);
    await typeOverlay('Scenario 2: Attacker tries 10 OKB — over the per-trade cap of 1 OKB.');
    await shot(2500);
    await btn2.click();
    await sleep(1200);
  }
  await typeOverlay('🔴 REJECTED: PER_ACTION_LIMIT — the contract blocked it. Server compromise changes nothing.');
  await shot(4000);

  /* ── SCENE 6: Scenario 3 — REJECTED rogue target ──────────────────── */
  console.log('Scene 6: Scenario 3 — rogue contract…');
  const btn3 = await page.$('.scenario-run[data-target-override]');
  if (btn3) {
    await scrollTo('.demo-scenario[data-idx="2"]');
    await sleep(400);
    await typeOverlay('Scenario 3: Rogue unlisted contract — not on the whitelist.');
    await shot(2500);
    await btn3.click();
    await sleep(1200);
  }
  await typeOverlay('🔴 REJECTED: TARGET_NOT_ALLOWED — only whitelisted addresses may be called.');
  await shot(4000);

  /* ── SCENE 7: Kill switch ──────────────────────────────────────────── */
  console.log('Scene 7: Kill switch on Autonomy tab…');
  await clickTab('autonomy');
  await sleep(600);
  await scrollTo('#btn-au-kill');
  await typeOverlay('Kill switch: one click stops all execution — no key to revoke, no server to shut down.');
  await shot(4000);

  /* ── SCENE 8: Evidence endpoint ───────────────────────────────────── */
  console.log('Scene 8: Evidence endpoint…');
  await typeOverlay('Every rule and every rejection is queryable on X Layer — no trust required.');
  await page.goto(URL + '/api/evidence', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2000);
  await typeOverlay('/api/evidence — full proof bundle: contracts, tx hashes, Sourcify links.');
  await shot(4000);

  /* ── SCENE 9: Close ────────────────────────────────────────────────── */
  console.log('Scene 9: Closing shot…');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(1500);
  await typeOverlay('TapeGuardian — the trading agent that physically cannot exceed your limits.');
  await shot(3000);
  await typeOverlay('AgentContainer + PolicyCircuit · Sourcify Verified · X Layer Testnet · tapeguard.tapeguard.workers.dev');
  await shot(4000);
  await typeOverlay('');
  await shot(1000);

  await browser.close();
  console.log(`Captured ${frameIndex} frames. Encoding video…`);

  /* ── stitch frames into mp4 ──────────────────────────────────────── */
  const ffmpegCmd = [
    'ffmpeg', '-y',
    '-framerate', String(FPS),
    '-i', path.join(OUT_DIR, 'frame_%06d.png'),
    '-vf', 'scale=1280:800',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '22',
    '-movflags', '+faststart',
    VIDEO_OUT
  ];

  console.log('Running:', ffmpegCmd.join(' '));
  execSync(ffmpegCmd.join(' '), { stdio: 'inherit' });

  console.log('\n✅ Done! Video saved to:', VIDEO_OUT);
  console.log('Duration:', (frameIndex / FPS).toFixed(1), 'seconds');
})().catch(err => { console.error(err); process.exit(1); });
