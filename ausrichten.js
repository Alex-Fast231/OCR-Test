// Automatische Ausrichtung der Feldrahmen auf den Druck des Rezepts.
// Der Arzt bedruckt einen vorgedruckten Bogen; je nach Drucker sitzt der Druck
// ein paar Millimeter versetzt. Dazu kommen kleine Abweichungen beim Setzen der
// Ecken. Gesucht wird eine Verschiebung (± 5 mm) und eine leichte Streckung
// (± 3 %), bei der möglichst viel schwarze Schrift in den Rahmen liegt und
// möglichst wenig direkt daneben. Der rote Vordruck zählt nicht (Rotkanal).

const PX_JE_MM = 2; // Rechenraster: 2 Punkte je mm

export function ausrichten(blatt, felder, blattMm = [105, 148]) {
  const [bwMm, bhMm] = blattMm;
  const mw = Math.round(bwMm * PX_JE_MM), mh = Math.round(bhMm * PX_JE_MM);
  const fx = blatt.width / mw, fy = blatt.height / mh;
  const d = blatt.data, W = blatt.width;

  // 1) Mittlere Helligkeit (Rotkanal) je Rasterpunkt
  const mittel = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      let s = 0, n = 0;
      for (let yy = Math.floor(y * fy); yy < Math.floor((y + 1) * fy); yy++) {
        for (let xx = Math.floor(x * fx); xx < Math.floor((x + 1) * fx); xx++) { s += d[(yy * W + xx) * 4]; n++; }
      }
      mittel[y * mw + x] = n ? s / n : 255;
    }
  }
  // 2) Papierhelligkeit in der Umgebung (Maximum im Fenster), gegen Schatten
  const r = 8;
  const zeilenMax = new Float32Array(mw * mh), papier = new Float32Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(mw - 1, x + r); k++) m = Math.max(m, mittel[y * mw + k]);
    zeilenMax[y * mw + x] = m;
  }
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(mh - 1, y + r); k++) m = Math.max(m, zeilenMax[k * mw + x]);
    papier[y * mw + x] = Math.max(30, m);
  }
  // 3) Tinte: Anteil dunkler Pixel je Rasterpunkt, als Summenbild
  const S = new Float64Array((mw + 1) * (mh + 1));
  for (let y = 0; y < mh; y++) {
    let zeile = 0;
    for (let x = 0; x < mw; x++) {
      const grenze = papier[y * mw + x] * 0.4; // deutlich dunkler als Papier (Schattenkanten zählen nicht)
      let dunkel = 0, n = 0;
      for (let yy = Math.floor(y * fy); yy < Math.floor((y + 1) * fy); yy++) {
        for (let xx = Math.floor(x * fx); xx < Math.floor((x + 1) * fx); xx++) { if (d[(yy * W + xx) * 4] < grenze) dunkel++; n++; }
      }
      // Die äußeren 3 mm zählen nicht: dort ist im Foto oft noch Tisch zu sehen
      const amRand = x < 3 * PX_JE_MM || y < 3 * PX_JE_MM || x >= mw - 3 * PX_JE_MM || y >= mh - 3 * PX_JE_MM;
      zeile += n && !amRand ? dunkel / n : 0;
      S[(y + 1) * (mw + 1) + x + 1] = S[y * (mw + 1) + x + 1] + zeile;
    }
  }
  const summe = (x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.min(mw, Math.round(x0))); x1 = Math.max(0, Math.min(mw, Math.round(x1)));
    y0 = Math.max(0, Math.min(mh, Math.round(y0))); y1 = Math.max(0, Math.min(mh, Math.round(y1)));
    if (x1 <= x0 || y1 <= y0) return 0;
    return S[y1 * (mw + 1) + x1] - S[y0 * (mw + 1) + x1] - S[y1 * (mw + 1) + x0] + S[y0 * (mw + 1) + x0];
  };

  // Mittelpunkt aller Rahmen (Drehpunkt der Streckung)
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const f of felder) { minX = Math.min(minX, f.x); minY = Math.min(minY, f.y); maxX = Math.max(maxX, f.x + f.w); maxY = Math.max(maxY, f.y + f.h); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ring = 1 * PX_JE_MM; // 1 mm Rand um jeden Rahmen

  const guete = (dxMm, dyMm, s) => {
    let g = 0;
    for (const f of felder) {
      const x = (cx + (f.x - cx) * s) * mw + dxMm * PX_JE_MM;
      const y = (cy + (f.y - cy) * s) * mh + dyMm * PX_JE_MM;
      const w = f.w * s * mw, h = f.h * s * mh;
      const innen = summe(x, y, x + w, y + h);
      const aussen = summe(x - ring, y - ring, x + w + ring, y + h + ring) - innen;
      g += innen - 0.8 * aussen;
      if (f.typ === "text") {
        // Waagerecht festhalten: Schrift beginnt am linken Rahmenrand
        // (ersten 3 mm im Rahmen belohnen, 2 mm links davor bestrafen)
        const anfang = summe(x, y, x + 3 * PX_JE_MM, y + h);
        const davor = summe(x - 2 * PX_JE_MM, y, x, y + h);
        g += 0.8 * anfang - 1.5 * davor;
      }
    }
    return g;
  };

  const null0 = guete(0, 0, 1);
  const funde = [];
  for (let s = 0.97; s <= 1.0301; s += 0.01) {
    for (let dy = -5; dy <= 5.001; dy += 0.5) {
      for (let dx = -5; dx <= 5.001; dx += 0.5) funde.push({ dx, dy, s, g: guete(dx, dy, s) });
    }
  }
  let bester = funde.reduce((a, b) => (b.g > a.g ? b : a));
  // Nur verschieben, wenn es deutlich besser passt; unter fast gleich guten die kleinste Änderung
  if (bester.g < null0 + Math.abs(null0) * 0.03 + 0.5) bester = { dx: 0, dy: 0, s: 1, g: null0 };
  else {
    const fast = funde.filter((f) => f.g >= bester.g - Math.abs(bester.g) * 0.01);
    bester = fast.reduce((a, b) => (Math.abs(b.dx) + Math.abs(b.dy) + Math.abs(b.s - 1) * 100 < Math.abs(a.dx) + Math.abs(a.dy) + Math.abs(a.s - 1) * 100 ? b : a));
  }
  return { dx: bester.dx / bwMm, dy: bester.dy / bhMm, s: Math.round(bester.s * 1000) / 1000, cx, cy, dxMm: bester.dx, dyMm: bester.dy };
}

// Rahmen mit Ausrichtung (alle Werte relativ zur Blattgröße)
export function ausgerichtet(f, a) {
  if (!a) return f;
  return {
    ...f,
    x: a.cx + (f.x - a.cx) * a.s + a.dx,
    y: a.cy + (f.y - a.cy) * a.s + a.dy,
    w: f.w * a.s,
    h: f.h * a.s
  };
}

// Umkehrung: angezeigte Lage -> Grundwerte der Schablone
export function zurueck(x, y, w, h, a) {
  if (!a) return { x, y, w, h };
  return { x: (x - a.dx - a.cx) / a.s + a.cx, y: (y - a.dy - a.cy) / a.s + a.cy, w: w / a.s, h: h / a.s };
}
