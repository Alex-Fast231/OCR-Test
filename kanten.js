// Blattränder über Kanten finden (ähnlich wie Scanner-Apps): Kantenstärke und
// -richtung, Hough-Geraden, dann das Viereck aus vier Geraden, das am besten von
// Kanten gestützt wird. Dazu Kantenmitten für gewölbte Blätter.
// Arbeitet auf einem verkleinerten Bild (ImageData, ca. 800 Pixel lang).

function kastenWeich(q, w, h, r) {
  const t = new Float32Array(w * h), a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const o = y * w;
    for (let x = -r; x <= r; x++) s += q[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[o + x] = s / (2 * r + 1);
      s += q[o + Math.min(w - 1, x + r + 1)] - q[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = s / (2 * r + 1);
      s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return a;
}

// Kantenbild: Stärke, Richtung (Gradient) und Helligkeit
export function kantenBild(bild) {
  const { width: w, height: h, data } = bild;
  const kanaele = [0, 1, 2].map((c) => {
    const q = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) q[i] = data[i * 4 + c];
    return kastenWeich(kastenWeich(q, w, h, 1), w, h, 1);
  });
  const hell = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hell[i] = 0.3 * kanaele[0][i] + 0.59 * kanaele[1][i] + 0.11 * kanaele[2][i];
  const staerke = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = -1, bx = 0, by = 0;
      for (const k of kanaele) {
        const dx = (k[i - w + 1] + 2 * k[i + 1] + k[i + w + 1]) - (k[i - w - 1] + 2 * k[i - 1] + k[i + w - 1]);
        const dy = (k[i + w - 1] + 2 * k[i + w] + k[i + w + 1]) - (k[i - w - 1] + 2 * k[i - w] + k[i - w + 1]);
        const m = dx * dx + dy * dy;
        if (m > best) { best = m; bx = dx; by = dy; }
      }
      staerke[i] = Math.sqrt(best) / 4;
      gx[i] = bx; gy[i] = by;
    }
  }
  const probe = [];
  for (let i = 0; i < w * h; i += 7) probe.push(staerke[i]);
  probe.sort((a, b) => a - b);
  const schwelle = Math.max(10, probe[Math.floor(probe.length * 0.9)]);
  // typische Papierhelligkeit (für Blätter, die bis an den Bildrand reichen)
  const hp = [];
  for (let i = 0; i < w * h; i += 7) hp.push(hell[i]);
  hp.sort((a, b) => a - b);
  const papier = hp[Math.floor(hp.length * 0.9)];
  // Ist der Tisch dunkel? (Median am Bildrand deutlich dunkler als Papier)
  const rand = [];
  for (let x = 0; x < w; x += 3) { rand.push(hell[2 * w + x], hell[(h - 3) * w + x]); }
  for (let y = 0; y < h; y += 3) { rand.push(hell[y * w + 2], hell[y * w + w - 3]); }
  rand.sort((a, b) => a - b);
  const tischDunkel = rand[Math.floor(rand.length / 2)] < papier * 0.65;
  return { w, h, staerke, gx, gy, hell, schwelle, papier, tischDunkel };
}

// Hough-Geraden: x·cosθ + y·sinθ = ρ
function geraden(k, maxAnzahl = 26) {
  const { w, h, staerke, gx, gy, schwelle } = k;
  const nT = 180, rhoMax = Math.ceil(Math.hypot(w, h)), schritt = 2;
  const nR = Math.ceil((2 * rhoMax) / schritt) + 1;
  const akku = new Float32Array(nT * nR);
  const cos = new Float32Array(nT), sin = new Float32Array(nT);
  for (let t = 0; t < nT; t++) { cos[t] = Math.cos((t * Math.PI) / 180); sin[t] = Math.sin((t * Math.PI) / 180); }
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (staerke[i] < schwelle * 0.6) continue; // auch schwache Blattränder (heller Tisch)
      let phi = (Math.atan2(gy[i], gx[i]) * 180) / Math.PI;
      if (phi < 0) phi += 180;
      const p = Math.round(phi);
      for (let d = -5; d <= 5; d++) {
        const t = (p + d + 180) % 180;
        const r = Math.round((x * cos[t] + y * sin[t] + rhoMax) / schritt);
        akku[t * nR + r] += 1;
      }
    }
  }
  const minStimmen = Math.min(w, h) * 0.12;
  const plaetze = [];
  for (let i = 0; i < akku.length; i++) if (akku[i] >= minStimmen) plaetze.push(i);
  plaetze.sort((a, b) => akku[b] - akku[a]);
  const aus = [];
  for (const i of plaetze) {
    const t = Math.floor(i / nR), rho = (i % nR) * schritt - rhoMax;
    const nah = aus.some((g) => {
      let dt = Math.abs(g.t - t), dr = Math.abs(g.rho - rho);
      if (dt > 90) { dt = 180 - dt; dr = Math.abs(g.rho + rho); }
      return dt < 6 && dr < 14;
    });
    if (nah) continue;
    aus.push({ t, rho, theta: (t * Math.PI) / 180, stimmen: akku[i] });
    if (aus.length >= maxAnzahl) break;
  }
  return aus;
}

function schnitt(a, b) {
  const c1 = Math.cos(a.theta), s1 = Math.sin(a.theta), c2 = Math.cos(b.theta), s2 = Math.sin(b.theta);
  const det = c1 * s2 - s1 * c2;
  if (Math.abs(det) < 1e-6) return null;
  return [(a.rho * s2 - b.rho * s1) / det, (c1 * b.rho - c2 * a.rho) / det];
}

export function ordneEcken(p) {
  const s = p.map(([x, y]) => x + y), d = p.map(([x, y]) => x - y);
  const lo = p[s.indexOf(Math.min(...s))], ru = p[s.indexOf(Math.max(...s))];
  const ro = p[d.indexOf(Math.max(...d))], lu = p[d.indexOf(Math.min(...d))];
  return [lo, ro, ru, lu];
}

function flaeche(e) {
  let a = 0;
  for (let i = 0; i < 4; i++) a += e[i][0] * e[(i + 1) % 4][1] - e[(i + 1) % 4][0] * e[i][1];
  return a / 2; // positiv bei Uhrzeigersinn im Bild (y nach unten)
}

function konvex(e) {
  let vz = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = e[i], [bx, by] = e[(i + 1) % 4], [cx, cy] = e[(i + 2) % 4];
    const k = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (k === 0) return false;
    if (vz === 0) vz = Math.sign(k); else if (Math.sign(k) !== vz) return false;
  }
  return true;
}

function wert(arr, w, h, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
  return arr[yi * w + xi];
}

// Wie gut ist die Kante a-b (gebogen durch die Mitte m) von Kanten gestützt?
// Anteil der Stützpunkte mit passender Kante, dazu wie oft innen deutlich heller
// ist als außen (Blattrand statt aufgedruckter Linie).
// Liegt die Kante auf dem Bildrand? (Blatt reicht bis an den Rand des Fotos)
function aufBildrand(k, a, b) {
  const r = 3;
  return (a[0] <= r && b[0] <= r) || (a[1] <= r && b[1] <= r) ||
    (a[0] >= k.w - 1 - r && b[0] >= k.w - 1 - r) || (a[1] >= k.h - 1 - r && b[1] >= k.h - 1 - r);
}

function kantenStuetze(k, a, b, m, mitte) {
  const { w, h, staerke, gx, gy, hell, schwelle } = k;
  if (aufBildrand(k, a, b)) {
    // Keine Kante messbar: zählt, wenn innen am Rand Papier ist (hell)
    let papierAnteil = 0;
    const n = 48;
    for (let j = 0; j < n; j++) {
      const t = 0.06 + (0.88 * j) / (n - 1);
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const ix = px + Math.sign(mitte[0] - px) * (Math.abs(mitte[0] - px) > 6 ? 4 : 0);
      const iy = py + Math.sign(mitte[1] - py) * (Math.abs(mitte[1] - py) > 6 ? 4 : 0);
      if (wert(hell, w, h, ix, iy) > k.papier * 0.6) papierAnteil++;
    }
    const anteil = (papierAnteil / n) * 0.9; // etwas schwächer als eine echte Kante
    return { anteil, stufe: anteil, aussenDunkel: anteil, rand: true };
  }
  const kx = 2 * m[0] - (a[0] + b[0]) / 2, ky = 2 * m[1] - (a[1] + b[1]) / 2;
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 10) return { anteil: 0, stufe: 0 };
  const n = 48;
  let treffer = 0, stufe = 0, aussenDunkel = 0;
  for (let j = 0; j < n; j++) {
    const t = 0.06 + (0.88 * j) / (n - 1), u = 1 - t;
    const px = u * u * a[0] + 2 * u * t * kx + t * t * b[0];
    const py = u * u * a[1] + 2 * u * t * ky + t * t * b[1];
    const tx = 2 * u * (kx - a[0]) + 2 * t * (b[0] - kx), ty = 2 * u * (ky - a[1]) + 2 * t * (b[1] - ky);
    const tl = Math.hypot(tx, ty) || 1;
    let nx = -ty / tl, ny = tx / tl;
    if ((mitte[0] - px) * nx + (mitte[1] - py) * ny < 0) { nx = -nx; ny = -ny; }
    let ok = false;
    for (let s = -3; s <= 3 && !ok; s++) {
      const xi = Math.round(px + nx * s), yi = Math.round(py + ny * s);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
      const i = yi * w + xi;
      if (staerke[i] < schwelle * 0.6) continue;
      const g = Math.hypot(gx[i], gy[i]) || 1;
      if (Math.abs((gx[i] * nx + gy[i] * ny) / g) > 0.85) ok = true;
    }
    if (ok) treffer++;
    const innen = wert(hell, w, h, px + nx * 5, py + ny * 5), aussen = wert(hell, w, h, px - nx * 5, py - ny * 5);
    if (innen - aussen > 8) stufe++;
    // Hinter einem echten Blattrand liegt der Tisch: 4–10 Pixel außen deutlich dunkler als Papier
    const weit = Math.max(wert(hell, w, h, px - nx * 6, py - ny * 6), wert(hell, w, h, px - nx * 10, py - ny * 10));
    if (weit < k.papier * 0.65) aussenDunkel++;
  }
  return { anteil: treffer / n, stufe: stufe / n, aussenDunkel: aussenDunkel / n };
}

export function bewerteViereck(k, e, mitten) {
  const mitte = [(e[0][0] + e[1][0] + e[2][0] + e[3][0]) / 4, (e[0][1] + e[1][1] + e[2][1] + e[3][1]) / 4];
  const m = mitten || [0, 1, 2, 3].map((i) => [(e[i][0] + e[(i + 1) % 4][0]) / 2, (e[i][1] + e[(i + 1) % 4][1]) / 2]);
  const seiten = [0, 1, 2, 3].map((i) => kantenStuetze(k, e[i], e[(i + 1) % 4], m[i], mitte));
  const anteile = seiten.map((s) => s.anteil);
  return {
    amRand: seiten.filter((x) => x.rand).length,
    mittel: anteile.reduce((a, b) => a + b, 0) / 4,
    minimum: Math.min(...anteile),
    stufe: seiten.reduce((a, s) => a + s.stufe, 0) / 4,
    aussen: seiten.reduce((a, s) => a + s.aussenDunkel, 0) / 4,
    flaeche: Math.abs(flaeche(e)) / (k.w * k.h)
  };
}

function winkelOk(e) {
  for (let i = 0; i < 4; i++) {
    const a = e[(i + 3) % 4], b = e[i], c = e[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cosw = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    if (Math.abs(cosw) > 0.6) return false; // Innenwinkel zwischen etwa 53° und 127°
  }
  return true;
}

// Bestes Viereck aus Hough-Geraden (und weiteren Vorschlägen, z. B. Helligkeit)
export function findeViereck(k, vorschlaege = []) {
  const { w, h } = k;
  const g = geraden(k);
  const waag = g.filter((l) => Math.abs(l.t - 90) < 45);
  const senk = g.filter((l) => Math.abs(l.t - 90) >= 45);
  // Bildränder als mögliche Blattkanten (Blatt ragt aus dem Foto)
  waag.push({ t: 90, theta: Math.PI / 2, rho: 1, rand: true }, { t: 90, theta: Math.PI / 2, rho: h - 2, rand: true });
  senk.push({ t: 0, theta: 0, rho: 1, rand: true }, { t: 0, theta: 0, rho: w - 2, rand: true });
  const paare = (liste, mindestAbstand) => {
    const p = [];
    for (let i = 0; i < liste.length; i++) {
      for (let j = i + 1; j < liste.length; j++) {
        let dt = Math.abs(liste[i].t - liste[j].t);
        if (dt > 90) dt = 180 - dt;
        if (dt > 18) continue;
        p.push([liste[i], liste[j]]);
      }
    }
    return p.filter(([a, b]) => {
      const m = [w / 2, h / 2];
      const da = Math.abs(m[0] * Math.cos(a.theta) + m[1] * Math.sin(a.theta) - a.rho);
      const db = Math.abs(m[0] * Math.cos(b.theta) + m[1] * Math.sin(b.theta) - b.rho);
      const s1 = Math.sign(m[0] * Math.cos(a.theta) + m[1] * Math.sin(a.theta) - a.rho);
      const s2 = Math.sign(m[0] * Math.cos(b.theta) + m[1] * Math.sin(b.theta) - b.rho);
      // beide Geraden auf verschiedenen Seiten der Bildmitte oder weit genug auseinander
      return s1 !== s2 || Math.abs(da - db) > mindestAbstand;
    });
  };
  const kandidaten = [];
  for (const [a, b] of paare(waag, h * 0.25)) {
    for (const [c, d] of paare(senk, w * 0.25)) {
      const p = [schnitt(a, c), schnitt(a, d), schnitt(b, c), schnitt(b, d)];
      if (p.some((q) => !q)) continue;
      if (p.some(([x, y]) => x < -0.03 * w || y < -0.03 * h || x > 1.03 * w || y > 1.03 * h)) continue;
      const e = ordneEcken(p);
      if (new Set(e.map((q) => q.join())).size < 4 || !konvex(e) || !winkelOk(e)) continue;
      kandidaten.push({ e, art: "kanten" });
    }
  }
  for (const v of vorschlaege) if (v && konvex(v.e)) kandidaten.push(v);
  // Vorauswahl mit geraden Kanten, dann die besten mit gebogenen Kanten genauer
  for (const kd of kandidaten) {
    const b = bewerteViereck(k, kd.e);
    kd.vor = b.flaeche < 0.1 ? -1 : b.mittel + Math.sqrt(b.flaeche) * 0.35;
  }
  const auswahl = kandidaten.filter((kd) => kd.vor >= 0 || kd.art === "flaeche")
    .sort((p, q) => (q.art === "flaeche") - (p.art === "flaeche") || q.vor - p.vor).slice(0, 60);
  let bester = null;
  for (const kd of auswahl) {
    kd.mitten = findeMitten(k, kd.e);
    const b = bewerteViereck(k, kd.e, kd.mitten);
    if (b.flaeche < 0.1) continue;
    kd.bewertung = b;
    // Güte: gut gestützte Kanten, Blattrand (innen heller), große Fläche
    kd.guete = b.mittel * 0.6 + b.minimum * 0.4 + b.stufe * 0.6 + (k.tischDunkel ? b.aussen * 0.8 : 0) + Math.sqrt(b.flaeche) * 0.35;
    if (!bester || kd.guete > bester.guete) bester = kd;
  }
  return bester;
}

// Kantenmitten suchen (gewölbtes Blatt). Gibt [oben, rechts, unten, links].
export function findeMitten(k, e) {
  const mitte = [(e[0][0] + e[1][0] + e[2][0] + e[3][0]) / 4, (e[0][1] + e[1][1] + e[2][1] + e[3][1]) / 4];
  const { w, h, staerke, gx, gy, hell, schwelle } = k;
  return [0, 1, 2, 3].map((i) => {
    const a = e[i], b = e[(i + 1) % 4];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (aufBildrand(k, a, b)) return [mx, my];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    let nx = -dy / l, ny = dx / l;
    if ((mitte[0] - mx) * nx + (mitte[1] - my) * ny < 0) { nx = -nx; ny = -ny; }
    const r = Math.round(l * 0.08);
    const funde = [];
    for (let s = -r; s <= r; s += 0.5) {
      const x = mx + nx * s, y = my + ny * s;
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
      const j = yi * w + xi;
      if (staerke[j] < schwelle * 0.5) continue;
      const g = Math.hypot(gx[j], gy[j]) || 1;
      if (Math.abs((gx[j] * nx + gy[j] * ny) / g) < 0.85) continue;
      const stufe = wert(hell, w, h, x + nx * 5, y + ny * 5) - wert(hell, w, h, x - nx * 5, y - ny * 5);
      funde.push({ p: [x, y], stufe, wt: staerke[j] * (1 - Math.abs(s) / (r * 2 + 1)) });
    }
    // Blattrand: innen heller als außen. Aufgedruckte Linien (beidseitig Papier) fallen raus.
    const rand = funde.filter((f) => f.stufe > 8);
    // ohne Blattrand-Stufe nur kräftige Kanten zulassen
    if (!rand.length) for (let i = funde.length - 1; i >= 0; i--) if (funde[i].wt < schwelle * 0.5) funde.splice(i, 1);
    const liste = rand.length ? rand : funde;
    let best = null;
    for (const f of liste) if (!best || f.wt > best.wt) best = f;
    return best ? best.p : [mx, my];
  });
}
