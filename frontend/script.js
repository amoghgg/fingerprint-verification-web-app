'use strict';

/* ==========================================================================
   BioVerify — Fingerprint Identification System
   Self-contained app. Backend optional — falls back to local HOG-based
   matching via localStorage when the Django server is unreachable.
   ========================================================================== */

// ── App State ──────────────────────────────────────────────────────────────
const S = {
  mode: 'enroll',      // 'enroll' | 'verify'
  phase: 'idle',       // 'idle' | 'scanning' | 'captured' | 'processing' | 'result'
  stream: null,
  qualityTimer: null,
  backendUrl: 'http://127.0.0.1:8000',
};

// ── DOM References ─────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const video          = $('camera');
const canvas         = $('canvas');
const preview        = $('preview');
const captureBtn     = $('capture-btn');
const badgeDot       = $('badge-dot');
const badgeLabel     = $('badge-label');
const qualityFill    = $('quality-fill');
const qualityPct     = $('quality-pct');
const scanBeam       = $('scan-beam');
const scannerFrame   = $('scanner-frame');
const resultPanel    = $('result-panel');
const resultIconWrap = $('result-icon-wrap');
const resultTitle    = $('result-title');
const resultDetail   = $('result-detail');
const scoreRingWrap  = $('score-ring-wrap');
const scoreArc       = $('score-arc');
const scoreNum       = $('score-num');
const retryBtn       = $('retry-btn');
const logStrip       = $('log-strip');
const userInput      = $('user-name');

// ── Logging ────────────────────────────────────────────────────────────────
function log(msg) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML =
    `<span class="log-time">${time}</span>` +
    `<span class="log-text">${escapeHtml(msg)}</span>`;
  logStrip.prepend(line);
  while (logStrip.children.length > 5) logStrip.removeChild(logStrip.lastChild);
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Particles ──────────────────────────────────────────────────────────────
function spawnParticles() {
  const container = $('particles');
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left              = `${Math.random() * 100}%`;
    p.style.animationDuration = `${6 + Math.random() * 10}s`;
    p.style.animationDelay    = `${Math.random() * 12}s`;
    const size = Math.random() < 0.2 ? '3px' : '2px';
    p.style.width = p.style.height = size;
    p.style.opacity = (0.12 + Math.random() * 0.38).toString();
    container.appendChild(p);
  }
}

// ── Camera Setup ───────────────────────────────────────────────────────────
async function setupCamera() {
  setBadge('active', 'Starting camera…');
  log('Requesting camera access');

  // Try progressively looser constraints
  const attempts = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 640 }, height: { ideal: 640 } } },
    { video: { facingMode: 'environment',            width: { ideal: 640 }, height: { ideal: 640 } } },
    { video: { width: { ideal: 640 }, height: { ideal: 640 } } },
    { video: true },
  ];

  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      S.stream = stream;
      video.srcObject = stream;
      await new Promise(resolve => { video.onloadedmetadata = resolve; });
      await video.play();
      S.phase = 'scanning';
      captureBtn.disabled = false;
      setBadge('active', 'Place thumb on camera');
      startQualityLoop();
      log('Camera ready — place thumb against lens');
      return;
    } catch (_) { /* try next */ }
  }

  setBadge('error', 'Camera access denied');
  log('ERROR: Could not access camera');
}

// ── Quality Analysis ───────────────────────────────────────────────────────
// Computes approximate Laplacian variance — measures image sharpness.
// Samples every 2nd pixel for performance.
function computeQuality(data, w, h) {
  const stride = w * 4;
  let sum = 0, count = 0;

  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const i  = y * stride + x * 4;
      const luma = (ch) => 0.299 * data[ch] + 0.587 * data[ch + 1] + 0.114 * data[ch + 2];
      const c  = luma(i);
      const n  = luma(i - stride);
      const ss = luma(i + stride);
      const ww = luma(i - 4);
      const e  = luma(i + 4);
      sum += Math.abs(4 * c - n - ss - ww - e);
      count++;
    }
  }

  return count > 0 ? sum / count : 0;
}

function startQualityLoop() {
  clearInterval(S.qualityTimer);

  // Offscreen canvas for sampling (avoids realloc each tick)
  const tmp = document.createElement('canvas');
  const tCtx = tmp.getContext('2d');

  S.qualityTimer = setInterval(() => {
    if (S.phase !== 'scanning') return;
    if (!video.videoWidth)      return;

    const w = Math.min(video.videoWidth,  320);
    const h = Math.min(video.videoHeight, 320);
    tmp.width = w; tmp.height = h;
    tCtx.drawImage(video, 0, 0, w, h);

    const imgData  = tCtx.getImageData(0, 0, w, h);
    const variance = computeQuality(imgData.data, w, h);
    const quality  = Math.min(100, Math.round(variance * 2.2));

    setQuality(quality);

    if      (quality < 25) setBadge('warn',   'Image too blurry — move closer');
    else if (quality < 55) setBadge('active', 'Acceptable — hold still');
    else                   setBadge('ready',  quality > 75 ? 'Excellent quality ✓' : 'Good quality ✓');

    if (quality >= 60 && S.phase === 'scanning') {
      log(`Auto-capture triggered (quality: ${quality}%)`);
      doCapture();
    }
  }, 500);
}

function setQuality(pct) {
  qualityFill.style.width      = pct + '%';
  qualityPct.textContent       = pct + '%';
  qualityFill.style.background =
    pct < 25  ? 'var(--red)'    :
    pct < 55  ? 'var(--yellow)' :
                'var(--green)';
}

// ── Image Enhancement ──────────────────────────────────────────────────────
// 1. Convert to grayscale
// 2. Histogram stretch (normalize contrast to full 0-255 range)
// 3. Unsharp mask (sharpen edges)
function enhanceFrame(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d       = imgData.data;

  // Pass 1: Grayscale
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }

  // Pass 2: Histogram stretch
  let minV = 255, maxV = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < minV) minV = gray[i];
    if (gray[i] > maxV) maxV = gray[i];
  }
  const range = maxV - minV || 1;
  const stretched = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    stretched[i] = Math.round(((gray[i] - minV) / range) * 255);
  }

  // Pass 3: Unsharp mask
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const blur = (
        stretched[idx - w - 1] + stretched[idx - w] + stretched[idx - w + 1] +
        stretched[idx - 1]                           + stretched[idx + 1]     +
        stretched[idx + w - 1] + stretched[idx + w] + stretched[idx + w + 1]
      ) / 8;
      const sharp = Math.min(255, Math.max(0, Math.round(2 * stretched[idx] - blur)));
      const di = idx * 4;
      d[di] = d[di + 1] = d[di + 2] = sharp;
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

// ── HOG Descriptor ─────────────────────────────────────────────────────────
// Histogram of Oriented Gradients — 128×128 input, 8×8 grid of 16×16 cells,
// 9 orientation bins per cell → 576-dimensional L2-normalized descriptor.
// Both enroll and verify resize to the same 128×128, so descriptors are
// always comparable regardless of camera resolution.
function extractHOG(sourceCanvas) {
  const SIZE = 128;
  const CELL = 16;
  const BINS = 9;
  const CELLS = SIZE / CELL; // 8

  // Resize to fixed 128×128
  const resized = document.createElement('canvas');
  resized.width = resized.height = SIZE;
  resized.getContext('2d').drawImage(sourceCanvas, 0, 0, SIZE, SIZE);

  const { data } = resized.getContext('2d').getImageData(0, 0, SIZE, SIZE);

  // Grayscale — R=G=B after enhance pass, so just use R channel
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = data[i];
  }

  // Build HOG descriptor
  const desc = new Float32Array(CELLS * CELLS * BINS);

  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      const hist = new Float32Array(BINS);

      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
          if (x <= 0 || x >= SIZE - 1 || y <= 0 || y >= SIZE - 1) continue;

          const gx    = gray[y * SIZE + x + 1] - gray[y * SIZE + x - 1];
          const gy    = gray[(y + 1) * SIZE + x] - gray[(y - 1) * SIZE + x];
          const mag   = Math.sqrt(gx * gx + gy * gy);
          const angle = ((Math.atan2(gy, gx) * 180 / Math.PI) + 180) % 180;
          const bin   = Math.min(BINS - 1, Math.floor(angle / (180 / BINS)));

          hist[bin] += mag;
        }
      }

      const offset = (cy * CELLS + cx) * BINS;
      for (let b = 0; b < BINS; b++) desc[offset + b] = hist[b];
    }
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < desc.length; i++) norm += desc[i] * desc[i];
  norm = Math.sqrt(norm) + 1e-6;
  for (let i = 0; i < desc.length; i++) desc[i] /= norm;

  return desc;
}

// ── Local Fingerprint Database ─────────────────────────────────────────────
const DB_KEY         = 'fp_db_v1';
const MATCH_THRESHOLD = 0.68; // cosine similarity threshold

function dbLoad() {
  try   { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); }
  catch { return {}; }
}

function dbSave(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function localEnroll(name, descriptor) {
  const db = dbLoad();
  db[name.toLowerCase()] = { desc: Array.from(descriptor), enrolledAt: Date.now() };
  dbSave(db);
  log(`Enrolled "${name}" in local store`);
}

function localVerify(name, descriptor) {
  const db     = dbLoad();
  const record = db[name.toLowerCase()];

  if (!record) {
    return {
      matched: false, score: 0,
      reason: `Subject "${name}" is not enrolled. Switch to Enroll mode first.`,
    };
  }

  // Cosine similarity — both descriptors are L2-normalized, so dot product = cosine similarity
  const stored = record.desc;
  let dot = 0;
  const len = Math.min(stored.length, descriptor.length);
  for (let i = 0; i < len; i++) dot += stored[i] * descriptor[i];

  const score   = Math.round(Math.max(0, Math.min(1, dot)) * 100);
  const matched = dot >= MATCH_THRESHOLD;

  return {
    matched,
    score,
    reason: matched
      ? `Fingerprint verified — similarity ${score}%`
      : `No match — similarity too low (${score}% < ${Math.round(MATCH_THRESHOLD * 100)}% threshold)`,
  };
}

// ── Capture ────────────────────────────────────────────────────────────────
function doCapture() {
  if (S.phase !== 'scanning') return;
  S.phase = 'captured';

  const w = video.videoWidth  || 640;
  const h = video.videoHeight || 640;
  canvas.width  = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  enhanceFrame(ctx, w, h);

  // Show enhanced preview
  preview.src           = canvas.toDataURL('image/png');
  preview.style.display = 'block';
  video.style.display   = 'none';
  scanBeam.classList.add('paused');

  setBadge('active', 'Processing…');
  captureBtn.disabled = true;
  log('Frame captured — running analysis');

  S.phase = 'processing';
  setTimeout(submit, 300); // brief pause so UI updates before CPU work
}

// ── Submit ─────────────────────────────────────────────────────────────────
async function submit() {
  const name = userInput.value.trim();

  if (!name) {
    setBadge('error', 'Enter a Subject ID first');
    log('ERROR: No Subject ID entered');
    resetScan();
    return;
  }

  const descriptor = extractHOG(canvas);
  const b64        = canvas.toDataURL('image/png').split(',')[1];

  log(`Mode: ${S.mode} | Subject: ${name}`);

  let result = null;

  // ── Try backend first ──────────────────────────────────────────
  try {
    const res = await fetch(`${S.backendUrl}/verify-fingerprint/`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fingerprint: b64, name, mode: S.mode }),
      signal:  AbortSignal.timeout(6000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (S.mode === 'enroll') {
      localEnroll(name, descriptor); // also store locally for future offline use
      result = { enrolled: true, matched: true, score: 100, reason: data.reason || 'Enrolled successfully' };
    } else {
      const matched = data?.matched === true || data?.Person?.Match === true;
      const score   =
        typeof data?.score          === 'number' ? Math.round(data.score) :
        typeof data?.Person?.Score  === 'number' ? Math.round(data.Person.Score) :
        matched ? 88 : 22;
      result = { matched, score, reason: data?.reason || (matched ? 'Identity verified' : 'No match found') };
    }

    log('Backend responded OK');

  } catch (_) {
    // ── Fall back to local matching ────────────────────────────────
    log('Backend unavailable — using local matching');

    if (S.mode === 'enroll') {
      localEnroll(name, descriptor);
      result = { enrolled: true, matched: true, score: 100, reason: 'Enrolled locally (offline mode)' };
    } else {
      result = localVerify(name, descriptor);
    }
  }

  S.phase = 'result';
  showResult(result);
}

// ── Show Result ────────────────────────────────────────────────────────────
function showResult({ matched, score, reason, enrolled }) {
  scannerFrame.classList.remove('state-success', 'state-fail');
  scannerFrame.classList.add(matched ? 'state-success' : 'state-fail');

  if (enrolled) {
    resultIconWrap.textContent = '✦';
    resultIconWrap.style.color = 'var(--cyan)';
    resultTitle.textContent    = 'Enrolled Successfully';
    resultTitle.style.color    = 'var(--cyan)';
    scoreRingWrap.style.display = 'none';
    setBadge('ready', 'Enrollment complete');
  } else if (matched) {
    resultIconWrap.textContent = '✓';
    resultIconWrap.style.color = 'var(--green)';
    resultTitle.textContent    = 'Identity Verified';
    resultTitle.style.color    = 'var(--green)';
    scoreRingWrap.style.display = 'block';
    animateScore(score, score >= 75 ? 'high' : 'mid');
    setBadge('ready', 'Match confirmed');
  } else {
    resultIconWrap.textContent = '✕';
    resultIconWrap.style.color = 'var(--red)';
    resultTitle.textContent    = 'Verification Failed';
    resultTitle.style.color    = 'var(--red)';
    scoreRingWrap.style.display = 'block';
    animateScore(score, 'low');
    setBadge('error', 'No match found');
  }

  resultDetail.textContent = reason;
  resultPanel.classList.add('visible');
  log(reason);
}

// ── Score Ring Animation ───────────────────────────────────────────────────
function animateScore(target, level) {
  // Circumference of r=56 circle: 2π×56 ≈ 352
  const CIRC = 352;

  scoreArc.classList.remove('low', 'mid');
  if      (level === 'low') scoreArc.classList.add('low');
  else if (level === 'mid') scoreArc.classList.add('mid');

  // Force a reflow to restart the CSS transition from 352
  scoreArc.style.transition     = 'none';
  scoreArc.style.strokeDashoffset = CIRC.toString();
  scoreNum.textContent           = '0';

  requestAnimationFrame(() => requestAnimationFrame(() => {
    scoreArc.style.transition     = '';
    scoreArc.style.strokeDashoffset = String(CIRC - (target / 100) * CIRC);
  }));

  // Numeric count-up over ~1.2 s
  let current = 0;
  const steps    = 42;
  const stepSize = target / steps;
  const interval = setInterval(() => {
    current = Math.min(current + stepSize, target);
    scoreNum.textContent = Math.round(current).toString();
    if (current >= target) clearInterval(interval);
  }, 1200 / steps);
}

// ── Reset ──────────────────────────────────────────────────────────────────
function resetScan() {
  S.phase = 'scanning';

  resultPanel.classList.remove('visible');
  scannerFrame.classList.remove('state-success', 'state-fail');

  // Reset score ring without triggering the transition
  scoreArc.style.transition     = 'none';
  scoreArc.style.strokeDashoffset = '352';
  scoreArc.classList.remove('low', 'mid');
  setTimeout(() => { scoreArc.style.transition = ''; }, 50);

  preview.style.display = 'none';
  video.style.display   = 'block';
  scanBeam.classList.remove('paused');
  captureBtn.disabled = false;

  setQuality(0);
  qualityPct.textContent = '—';
  setBadge('active', 'Place thumb on camera');
  log('Ready for new scan');
}

// ── Badge Helper ───────────────────────────────────────────────────────────
function setBadge(type, text) {
  badgeDot.className     = `badge-dot ${type}`;
  badgeLabel.textContent = text;
}

// ── Mode Buttons ───────────────────────────────────────────────────────────
$('btn-enroll').addEventListener('click', () => {
  if (S.mode === 'enroll') return;
  S.mode = 'enroll';
  $('btn-enroll').classList.add('active');
  $('btn-verify').classList.remove('active');
  log('Mode → Enroll');
  if (S.phase === 'result') resetScan();
});

$('btn-verify').addEventListener('click', () => {
  if (S.mode === 'verify') return;
  S.mode = 'verify';
  $('btn-verify').classList.add('active');
  $('btn-enroll').classList.remove('active');
  log('Mode → Verify');
  if (S.phase === 'result') resetScan();
});

// ── Controls ───────────────────────────────────────────────────────────────
captureBtn.addEventListener('click', doCapture);
retryBtn.addEventListener('click', resetScan);

// Keyboard shortcuts: Space = capture, R = reset
document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (S.phase === 'scanning') doCapture();
  }
  if (e.code === 'KeyR') {
    if (S.phase === 'result' || S.phase === 'processing') resetScan();
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
spawnParticles();
setupCamera();
log('BioVerify v2.0 initialized');
