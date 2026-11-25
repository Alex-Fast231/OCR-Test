{
const $ = s => document.querySelector(s);
const FIELDS = ['Formularcode','Formularcodeergänzung','Versionsnummer','Nachname','Vorname','Geburtsdatum','Versicherungsschutz Ende','Kostenträgerkennung','Versicherten-ID','Versichertenart','Besondere Personengruppe','DMP-Kennzeichnung','Betriebsstättennummer','LANR','Ausstellungsdatum','Heilmittelart','ICD-10 (1)','ICD-10 (2)','Diagnosegruppe','Leitsymptomatik','Patientenind. Leitsymptomatik','Heilmittel 1','Einheiten 1','Heilmittel 2','Einheiten 2','Heilmittel 3','Einheiten 3','Ergänzendes Heilmittel','Einheiten ergänzend','Therapiefrequenz','Therapiebericht','Hausbesuch','Dringlich (14 Tage)'];
const ART = {'1':'Physiotherapie','2':'Podologie','3':'Stimm-, Sprech-, Sprach- und Schlucktherapie','4':'Ergotherapie','5':'Ernährungstherapie'};

const PRESETS = [
  {label:'Müller · Physio', d:{nn:'Müller',vn:'Jürgen',geb:'1940-03-12',aus:'2026-11-20',art:'1',icd1:'I63.5 G',icd2:'',dg:'ZN',ls:'a',hm1:'KG-ZNS',e1:'10',hm2:'',e2:'',hm3:'',e3:'',erg:'',ee:'',freq:'1-2x wöchentlich',hb:true,dr:false}},
  {label:'Schäfer · Physio, dringlich', d:{nn:'Schäfer',vn:'Anneliese',geb:'1938-07-04',aus:'2026-11-18',art:'1',icd1:'M17.1 G',icd2:'R26.8 G',dg:'EX',ls:'b',hm1:'KG',e1:'6',hm2:'',e2:'',hm3:'',e3:'',erg:'Wärmetherapie',ee:'6',freq:'2x wöchentlich',hb:true,dr:true}},
  {label:'Weiß · Ergo', d:{nn:'Weiß',vn:'Gertrud',geb:'1932-01-00',aus:'2026-11-21',art:'4',icd1:'F03 G',icd2:'',dg:'PS4',ls:'a',hm1:'Hirnleistungstraining',e1:'10',hm2:'',e2:'',hm3:'',e3:'',erg:'',ee:'',freq:'1x wöchentlich',hb:true,dr:false}}
];

/* ---------- Lesen ---------- */
// Hauptleser: zxing-wasm (lokal in lib/, keine fremden Server).
// Rückfall: BarcodeDetector des Geräts, nur wenn er PDF417 kann.
const ZX_OPT = {formats: ['PDF417'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 1};
let zx = null, zxInfo = 'lädt …', detector = null, detInfo = 'nicht vorhanden';
const iso = (() => { try { return new TextDecoder('iso-8859-15'); } catch(e) { return new TextDecoder('latin1'); } })();

function status() {
  $('#dec').textContent = 'zxing-wasm: ' + zxInfo + ' · Geräte-Leser: ' + detInfo;
}

async function ladeLeser() {
  status();
  if ('BarcodeDetector' in window) {
    try {
      const f = await BarcodeDetector.getSupportedFormats();
      if (f.includes('pdf_417')) { detector = new BarcodeDetector({formats: ['pdf_417']}); detInfo = 'Rückfall (' + f.join(', ') + ')'; }
      else detInfo = 'ohne PDF417 (' + (f.join(', ') || 'keine Formate') + '), nicht genutzt';
    } catch(e) { detInfo = 'Fehler, nicht genutzt'; }
  }
  status();
  if (!window.ZXingWASM) { zxInfo = 'nicht geladen (Skript fehlt)'; status(); return; }
  try {
    await ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path, prefix) => path.endsWith('.wasm') ? new URL('lib/' + path, document.baseURI).href : prefix + path },
      fireImmediately: true
    });
    zx = ZXingWASM;
    zxInfo = 'geladen (Hauptleser)';
  } catch(e) { zxInfo = 'nicht geladen (' + (e && e.message || e) + ')'; }
  status();
}
const leserBereit = ladeLeser();

function toCanvas(src, w, h, max, rot) {
  const s = Math.min(1, max / Math.max(w, h));
  const W = Math.round(w*s), H = Math.round(h*s), c = document.createElement('canvas');
  const sw = rot % 180 ? H : W, sh = rot % 180 ? W : H;
  c.width = sw; c.height = sh;
  const g = c.getContext('2d', {willReadFrequently:true});
  g.fillStyle = '#fff'; g.fillRect(0, 0, sw, sh);
  g.translate(sw/2, sh/2); g.rotate(rot*Math.PI/180); g.drawImage(src, -W/2, -H/2, W, H);
  return c;
}

// Ausschnitt (Anteile 0..1) auf Zielgröße (längere Seite) bringen, auch vergrößern
function ausschnitt(src, w, h, x0, y0, x1, y1, ziel) {
  const sx = Math.round(w * x0), sy = Math.round(h * y0), sw = Math.round(w * (x1 - x0)), sh = Math.round(h * (y1 - y0));
  const f = ziel / Math.max(sw, sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * f); c.height = Math.round(sh * f);
  const g = c.getContext('2d', {willReadFrequently: true});
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

async function zxLesen(c) {
  if (!zx) return null;
  try {
    const bild = c.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, c.width, c.height);
    const r = (await zx.readBarcodes(bild, ZX_OPT)).find(x => x.isValid);
    if (!r) return null;
    // Rohbytes selbst als ISO-8859-15 lesen (Umlaute laut KBV-Handbuch)
    return r.bytes && r.bytes.length ? iso.decode(r.bytes) : r.text;
  } catch(e) { return null; }
}

async function geraetLesen(c) {
  if (!detector) return null;
  try { const r = await detector.detect(c); return r.length ? r[0].rawValue : null; } catch(e) { return null; }
}

function fixText(t) {
  if (/Ã[\u0080-ÿ]/.test(t)) {
    try { return new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(t, ch => ch.charCodeAt(0) & 255)); } catch(e) {}
  }
  return t;
}

// Foto: ganzes Bild in voller Auflösung, dann untere Hälfte, dann unteres
// rechtes Viertel (dort sitzt der Barcode), jeweils vergrößert
async function decodeImage(src, w, h) {
  await leserBereit;
  const t0 = performance.now();
  const versuche = [
    ['ganzes Bild', () => toCanvas(src, w, h, 4096, 0)],
    ['untere Hälfte', () => ausschnitt(src, w, h, 0, 0.5, 1, 1, Math.min(4096, Math.max(w, h) * 1.5))],
    ['unteres rechtes Viertel', () => ausschnitt(src, w, h, 0.5, 0.5, 1, 1, Math.min(4096, Math.max(w, h) * 1.5))]
  ];
  for (const [teil, mach] of versuche) {
    const c = mach();
    let text = await zxLesen(c), how = 'zxing-wasm';
    if (!text) { text = await geraetLesen(c); how = 'Geräte-Leser'; }
    if (text) return {text: fixText(text), how: how + ', ' + teil, ms: Math.round(performance.now() - t0)};
  }
  return {text: null, how: '', ms: Math.round(performance.now() - t0)};
}

/* ---------- Auswerten ---------- */
function date(v) {
  if (!/^\d{8}$/.test(v || '')) return {s: v || '', ok: false};
  const y = v.slice(0,4), m = v.slice(4,6), d = v.slice(6,8);
  const s = (d === '00' ? '??' : d) + '.' + (m === '00' ? '??' : m) + '.' + (y === '0000' ? '????' : y);
  const ok = y !== '0000' && +m <= 12 && +d <= 31;
  return {s, ok};
}
const ICD = /^[A-Z]\d{2}(\.[0-9A-Z-]{1,2})?$/;
function icdOk(v) { return !v || v.split(/,\s*/).every(x => ICD.test(x.trim().split(/\s+/)[0])); }

function parse(text) {
  const p = text.split('\t'), f = i => (p[i] || '').trim(), warn = [];
  if (f(0) !== '13') warn.push('Formularcode ist „' + f(0) + '“, nicht 13. Ist das ein Muster-13-Rezept?');
  if (p.length !== 33) warn.push(p.length + ' Felder statt 33. Andere Barcode-Version?');
  const geb = date(f(5)), aus = date(f(14));
  if (!geb.ok) warn.push('Geburtsdatum unvollständig oder unklar.');
  if (!aus.ok) warn.push('Ausstellungsdatum fehlt oder unklar.');
  if (!icdOk(f(16)) || !icdOk(f(17))) warn.push('ICD-Code hat ungewöhnliches Format.');
  if (/\uFFFD/.test(text)) warn.push('Umlaute kaputt gelesen (Ersatzzeichen statt ä, ö, ü). Bitte Namen prüfen.');
  const hm = [[21,22,'1'],[23,24,'2'],[25,26,'3'],[27,28,'ergänzend']].filter(r => f(r[0]) || f(r[1])).map(r => ({n: f(r[0]), e: f(r[1]), k: r[2]}));
  if (!hm.length) warn.push('Kein Heilmittel im Barcode.');
  return {p, f, warn, geb, aus, hm};
}

function row(k, v, bad) {
  const tr = document.createElement('tr');
  const a = document.createElement('th'); a.textContent = k;
  const b = document.createElement('td'); b.textContent = v || '–'; if (bad) b.className = 'bad';
  tr.append(a, b); return tr;
}

function show(res, srcLabel) {
  const out = $('#out'); out.hidden = false;
  const head = $('#outHead'), body = $('#main'), raw = $('#raw'), w = $('#warn');
  body.replaceChildren(); raw.replaceChildren(); w.replaceChildren();
  if (!res.text) {
    head.textContent = 'Kein Barcode gefunden';
    $('#outMeta').textContent = srcLabel + ' · ' + res.ms + ' ms · zxing-wasm: ' + zxInfo + ' · Geräte-Leser: ' + detInfo;
    const li = document.createElement('li');
    li.textContent = 'Barcode formatfüllend und scharf fotografieren, ohne Spiegelung. Er sitzt unten rechts auf dem Rezept.';
    w.append(li); $('#outCard').className = 'card fail'; return;
  }
  const r = parse(res.text), f = r.f;
  head.textContent = (f(3) || '?') + ', ' + (f(4) || '?');
  $('#outMeta').textContent = srcLabel + ' · gelesen mit ' + res.how + ' · ' + res.ms + ' ms';
  $('#outCard').className = 'card ' + (r.warn.length ? 'warn' : 'ok');
  for (const x of r.warn) { const li = document.createElement('li'); li.textContent = x; w.append(li); }
  body.append(
    row('Nachname', f(3)), row('Vorname', f(4)),
    row('Geburtsdatum', r.geb.s, !r.geb.ok), row('Ausgestellt', r.aus.s, !r.aus.ok),
    row('Heilmittelbereich', ART[f(15)] || f(15)),
    row('ICD-10 (1)', f(16), !icdOk(f(16))), row('ICD-10 (2)', f(17), !icdOk(f(17))),
    row('Diagnosegruppe', f(18)), row('Leitsymptomatik', f(19) + (f(20) === '1' ? ' (patientenindividuell)' : ''))
  );
  for (const h of r.hm) body.append(row('Heilmittel ' + h.k, (h.n || '?') + ' · ' + (h.e || '?') + ' Einheiten', !h.e));
  body.append(
    row('Frequenz', f(29)),
    row('Hausbesuch', f(31) === '1' ? 'ja' : f(31) === '0' ? 'nein' : 'nicht angegeben'),
    row('Dringlich (14 Tage)', f(32) === '1' ? 'ja' : 'nein'),
    row('Therapiebericht', f(30) === '1' ? 'ja' : 'nein')
  );
  r.p.forEach((v, i) => raw.append(row(String(i+1).padStart(2, '0') + ' ' + (FIELDS[i] || 'unbekannt'), v)));
  out.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
}

async function fromFile(file) {
  if (!file) return;
  const btns = document.querySelectorAll('.pick'); btns.forEach(b => b.classList.add('busy'));
  $('#busy').hidden = false;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode();
    show(await decodeImage(img, img.naturalWidth, img.naturalHeight), 'Foto');
  } catch(e) {
    show({text: null, ms: 0}, 'Bild nicht lesbar');
  } finally {
    URL.revokeObjectURL(url); $('#busy').hidden = true; btns.forEach(b => b.classList.remove('busy'));
  }
}
$('#cam').addEventListener('change', e => { fromFile(e.target.files[0]); e.target.value = ''; });
$('#gal').addEventListener('change', e => { fromFile(e.target.files[0]); e.target.value = ''; });
$('#clear').addEventListener('click', () => { $('#out').hidden = true; $('#main').replaceChildren(); $('#raw').replaceChildren(); window.scrollTo(0, 0); });

/* ---------- Live-Kamera ---------- */
// Etwa alle 250 ms ein Bild an zxing-wasm (Rückfall: Geräte-Leser).
let stream = null, timer = null;
function stopLive() {
  if (timer) clearTimeout(timer); timer = null;
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  $('#liveBox').hidden = true; $('#liveBtn').hidden = false;
}
function spur() { return stream && stream.getVideoTracks()[0]; }
async function fokus() {
  const tr = spur(); if (!tr || !tr.getCapabilities) return;
  const cap = tr.getCapabilities();
  try { if (cap.focusMode && cap.focusMode.includes('continuous')) await tr.applyConstraints({advanced: [{focusMode: 'continuous'}]}); } catch(e) {}
}
async function zoom(z) {
  const tr = spur(); if (!tr || !tr.getCapabilities) return false;
  const cap = tr.getCapabilities(); if (!cap.zoom) return false;
  const w = Math.max(cap.zoom.min, Math.min(cap.zoom.max, z));
  try { await tr.applyConstraints({advanced: [{zoom: w}]}); } catch(e) { return false; }
  document.querySelectorAll('#zoomRow button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.z === z)));
  return true;
}
async function tick() {
  const v = $('#vid'); if (!stream) return;
  const t0 = performance.now();
  if (v.readyState >= 2 && v.videoWidth) {
    const c = toCanvas(v, v.videoWidth, v.videoHeight, 4096, 0);
    let text = await zxLesen(c), how = 'zxing-wasm (live)';
    if (!text) { text = await geraetLesen(c); how = 'Geräte-Leser (live)'; }
    if (text && stream) {
      if (navigator.vibrate) try { navigator.vibrate(80); } catch(e) {}
      const info = v.videoWidth + '×' + v.videoHeight;
      stopLive(); show({text: fixText(text), how: how + ', ' + info, ms: Math.round(performance.now() - t0)}, 'Live-Kamera'); return;
    }
  }
  if (stream) timer = setTimeout(tick, Math.max(0, 250 - (performance.now() - t0)));
}
$('#liveBtn').addEventListener('click', async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {
      facingMode: {ideal: 'environment'}, width: {min: 1280, ideal: 1920}, height: {min: 720, ideal: 1080}}});
  } catch(e) {
    try { stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: 'environment'}}}); } catch(e2) { stream = null; }
  }
  if (!stream) { stopLive(); $('#dec').textContent = 'Live-Kamera nicht erlaubt oder nicht verfügbar. Nimm „Foto aufnehmen“.'; return; }
  try {
    const v = $('#vid'); v.srcObject = stream; await v.play();
    $('#liveBox').hidden = false; $('#liveBtn').hidden = true;
    await fokus();
    const tr = spur(), cap = tr && tr.getCapabilities ? tr.getCapabilities() : {};
    $('#zoomRow').hidden = !cap.zoom;
    await leserBereit; tick();
  } catch(e) { stopLive(); }
});
$('#vid').addEventListener('click', () => fokus());
document.querySelectorAll('#zoomRow button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); zoom(+b.dataset.z).then(fokus); }));
$('#liveStop').addEventListener('click', stopLive);
if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) $('#liveBtn').hidden = true;

/* ---------- Testcodes ---------- */
const form = $('#gen');
const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.replace(/-/g, '') : '';
function fill(d) { for (const k in d) { const el = form.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = d[k]; else el.value = d[k]; } }
function record() {
  const e = form.elements, v = k => e[k].value.trim();
  return ['13','','10', v('nn'), v('vn'), ymd(v('geb')), '', '123456789', 'X123456789', '5', '00', '00', '999999900', '999999901', ymd(v('aus')),
    v('art'), v('icd1'), v('icd2'), v('dg'), v('ls'), '', v('hm1'), v('e1'), v('hm2'), v('e2'), v('hm3'), v('e3'), v('erg'), v('ee'), v('freq'), '',
    e.hb.checked ? '1' : '0', e.dr.checked ? '1' : ''].join('\t');
}
function draw() {
  const txt = record(), bytes = [];
  for (const ch of txt) { const c = ch.charCodeAt(0); bytes.push(c < 256 ? c : 63); }
  let M; try { M = PDF417.encode(bytes, {level: 5, cols: 8}); } catch(e) { $('#genInfo').textContent = e.message; return; }
  const mw = 3, rh = 9, q = 8, c = $('#code');
  c.width = (M[0].length + 2*q) * mw; c.height = M.length * rh + 2*q*mw;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
  M.forEach((r, y) => r.forEach((v, x) => { if (v) g.fillRect((q + x) * mw, q*mw + y*rh, mw, rh); }));
  $('#genInfo').textContent = bytes.length + ' Byte · ' + M.length + ' Zeilen · erfundene Testdaten';
}
const tabs = $('#presets');
PRESETS.forEach((p, i) => {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = p.label; b.id = 'pre' + i;
  b.addEventListener('click', () => { fill(p.d); draw(); tabs.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  tabs.append(b);
});
form.addEventListener('input', () => { tabs.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', 'false')); draw(); });
form.addEventListener('submit', e => e.preventDefault());
$('#self').addEventListener('click', async () => {
  const c = $('#code'); $('#busy').hidden = false;
  const res = await decodeImage(c, c.width, c.height);
  $('#busy').hidden = true; show(res, 'Selbsttest am Bildschirm-Code');
});
$('#big').addEventListener('click', () => $('#codeBox').classList.add('full'));
$('#codeBox').addEventListener('click', () => $('#codeBox').classList.remove('full'));
fill(PRESETS[0].d); draw(); $('#pre0').setAttribute('aria-pressed', 'true');
}
