// OCR-Prototyp Muster 13 – Oberfläche.
// Datenschutz: kein localStorage/sessionStorage/IndexedDB/Cookies/Cache Storage,
// kein Service Worker, keine Netzanfragen außer zu den eigenen Dateien.
// Erkannter Text wird nur über textContent angezeigt.
import { bewerte } from "./pruefung.js";
import { verzerrung } from "./bild.js";

const $ = (id) => document.getElementById(id);
const BEREICHE = ["start", "kamera", "ecken", "ergebnis", "kalibrierung"];

const zustand = {
  worker: null,
  bereit: false,
  schablone: null,
  schwelle: 0.1,
  bild: null,      // { ecken, breite, hoehe, vorschau (ImageBitmap), eckenZeit, sicher }
  ergebnis: null,  // { felder, entzerrt, zeiten, bewertung, rezept }
  startZeit: 0,
  sitzung: [],     // je Rezept: { zeiten, urteile: Map(feldId -> true/false), ampeln: Map }
  stream: null
};

// ------------------------------------------------------------ Hilfen
function el(tag, klasse, text) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (text !== undefined) e.textContent = text;
  return e;
}

function zeige(name) {
  for (const b of BEREICHE) $(b).classList.toggle("versteckt", b !== name);
  window.scrollTo(0, 0);
}

function sek(ms) { return (ms / 1000).toFixed(1).replace(".", ",") + " s"; }

function meldung(id, text) { $(id).textContent = text || ""; }

function geraet() {
  const m = navigator.userAgent.match(/\(([^)]+)\)/);
  return m ? m[1] : "unbekannt";
}

// ------------------------------------------------------------ Worker
function starteWorker() {
  const w = new Worker(new URL("./ocr-worker.js", import.meta.url), { type: "module" });
  w.onmessage = (e) => verarbeite(e.data);
  w.onerror = (e) => { $("ladeText").textContent = "Fehler im Worker: " + (e.message || "unbekannt"); };
  zustand.worker = w;
  w.postMessage({ typ: "laden" });
}

function verarbeite(n) {
  if (n.typ === "fortschritt" && !zustand.ladeFehler) {
    $("ladeBalken").max = n.groesse || 1;
    $("ladeBalken").value = n.geladen;
    $("ladeText").textContent = `Erkennung wird geladen … ${(n.geladen / 1048576).toFixed(1)} von ${(n.groesse / 1048576).toFixed(1)} MB`;
  } else if (n.typ === "bereit") {
    zustand.bereit = true;
    $("ladeBalken").value = $("ladeBalken").max;
    $("ladeText").textContent = `Erkennung bereit (${(n.bytes / 1048576).toFixed(1)} MB, ${sek(n.ladezeit)})`;
    document.body.dataset.bereit = "ja";
  } else if (n.typ === "ecken") {
    zeigeEcken(n);
  } else if (n.typ === "ergebnis") {
    zeigeErgebnis(n);
  } else if (n.typ === "fehler") {
    if (n.bei === "laden") zustand.ladeFehler = true;
    const ziel = n.bei === "laden" ? "ladeText" : n.bei === "auswerten" ? "eckenMeldung" : "startMeldung";
    $(ziel).textContent = "Fehler: " + n.meldung;
    $("auswertenBtn").disabled = false;
  }
}

// ------------------------------------------------------------ Bild holen
async function bildAnWorker(quelle) {
  meldung("startMeldung", "Bild wird vorbereitet …");
  try {
    const bitmap = await createImageBitmap(quelle, { imageOrientation: "from-image" });
    zustand.worker.postMessage({ typ: "bild", bitmap }, [bitmap]);
  } catch (e) {
    meldung("startMeldung", "Bild konnte nicht gelesen werden.");
  }
}

$("dateiWahl").addEventListener("change", async (e) => {
  const datei = e.target.files && e.target.files[0];
  e.target.value = "";
  if (datei) await bildAnWorker(datei);
});

$("kameraBtn").addEventListener("click", async () => {
  meldung("startMeldung", "");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    meldung("startMeldung", "Kamera wird in diesem Browser nicht unterstützt.");
    return;
  }
  try {
    zustand.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } }
    });
    $("video").srcObject = zustand.stream;
    zeige("kamera");
  } catch (e) {
    meldung("startMeldung", "Kamera nicht verfügbar: " + (e.name || e.message));
  }
});

function kameraStopp() {
  if (zustand.stream) for (const t of zustand.stream.getTracks()) t.stop();
  zustand.stream = null;
  $("video").srcObject = null;
}

$("ausloesenBtn").addEventListener("click", async () => {
  const video = $("video");
  const videoHochkant = video.videoHeight > video.videoWidth;
  let quelle = null;
  try {
    const spur = zustand.stream && zustand.stream.getVideoTracks()[0];
    if (spur && "ImageCapture" in window) {
      // volle Sensorauflösung, nur als Blob im Speicher
      const blob = await new window.ImageCapture(spur).takePhoto();
      const bm = await createImageBitmap(blob, { imageOrientation: "from-image" });
      // Manche Android-Kameras liefern das Foto in Sensorlage (quer), obwohl das
      // Handy hochkant gehalten wird. Dann um 90° nach rechts drehen.
      if (videoHochkant && bm.width > bm.height) {
        const c = document.createElement("canvas");
        c.width = bm.height; c.height = bm.width;
        const g = c.getContext("2d");
        g.translate(c.width, 0);
        g.rotate(Math.PI / 2);
        g.drawImage(bm, 0, 0);
        bm.close();
        quelle = c;
      } else {
        quelle = bm;
      }
    }
  } catch (e) { quelle = null; }
  if (!quelle) {
    const c = document.createElement("canvas");
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    quelle = c;
  }
  kameraStopp();
  zeige("start");
  await bildAnWorker(quelle);
});

$("kameraAbbrechenBtn").addEventListener("click", () => { kameraStopp(); zeige("start"); });

// ------------------------------------------------------------ Ecken
// 4 Ecken (1–4) und 4 Kantenmitten (für ein gewölbtes Blatt). Beim Ziehen
// erscheint eine Lupe über dem Finger.
const eckenGriffe = [];
let vorschauPixel = null; // ImageData der Vorschau für das entzerrte Probebild

function zeigeEcken(n) {
  if (zustand.bild && zustand.bild.vorschau) zustand.bild.vorschau.close();
  zustand.bild = { ecken: n.ecken, mitten: n.mitten, breite: n.breite, hoehe: n.hoehe, vorschau: n.vorschau, eckenZeit: n.zeit, sicher: n.sicher, lageSuchen: true };
  meldung("startMeldung", "");
  meldung("eckenMeldung", n.sicher ? "" : "Blatt nicht sicher erkannt" + (n.grund ? ` (${n.grund})` : "") + ". Bitte die Punkte von Hand setzen.");
  const c = $("eckenCanvas");
  c.width = n.vorschau.width; c.height = n.vorschau.height;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(n.vorschau, 0, 0);
  vorschauPixel = g.getImageData(0, 0, c.width, c.height);
  zeichneEcken();
  zeichneProbe();
  zeige("ecken");
  $("auswertenBtn").disabled = false;
}

function zeichneEcken() {
  const b = zustand.bild;
  const c = $("eckenCanvas");
  const g = c.getContext("2d");
  g.drawImage(b.vorschau, 0, 0);
  const s = c.width / b.breite;
  // Umriss mit gebogenen Kanten durch die Mitten
  g.strokeStyle = "rgba(31,95,191,0.95)";
  g.lineWidth = Math.max(2, c.width / 300);
  g.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = b.ecken[i], e = b.ecken[(i + 1) % 4], m = b.mitten[i];
    const kx = 2 * m[0] - (a[0] + e[0]) / 2, ky = 2 * m[1] - (a[1] + e[1]) / 2;
    if (i === 0) g.moveTo(a[0] * s, a[1] * s);
    g.quadraticCurveTo(kx * s, ky * s, e[0] * s, e[1] * s);
  }
  g.closePath();
  g.stroke();
  const flaeche = $("eckenFlaeche");
  if (!eckenGriffe.length) {
    for (let i = 0; i < 8; i++) {
      const istEcke = i < 4;
      const griff = el("div", istEcke ? "griff" : "griff mitte");
      if (istEcke) griff.append(el("span", "", String(i + 1)));
      griff.title = istEcke ? ["links oben", "rechts oben", "rechts unten", "links unten"][i] : "Kantenmitte (für gewölbtes Blatt)";
      bindeZiehen(griff, flaeche, (px, py) => {
        const p = [px * zustand.bild.breite, py * zustand.bild.hoehe];
        if (istEcke) {
          // Kantenmitten der beiden anliegenden Kanten mitführen
          const alt = zustand.bild.ecken[i];
          const dx = p[0] - alt[0], dy = p[1] - alt[1];
          for (const k of [i, (i + 3) % 4]) zustand.bild.mitten[k] = [zustand.bild.mitten[k][0] + dx / 2, zustand.bild.mitten[k][1] + dy / 2];
          zustand.bild.ecken[i] = p;
        } else {
          zustand.bild.mitten[i - 4] = p;
        }
        griff.classList.add("gezogen");
        zeichneEcken();
        zeigeLupe(px, py);
      }, () => {
        griff.classList.remove("gezogen");
        versteckeLupe();
        zeichneProbe();
      });
      flaeche.append(griff);
      eckenGriffe.push(griff);
    }
  }
  [...b.ecken, ...b.mitten].forEach(([x, y], i) => {
    eckenGriffe[i].style.left = (x / b.breite) * 100 + "%";
    eckenGriffe[i].style.top = (y / b.hoehe) * 100 + "%";
  });
}

// Lupe: vergrößerter Ausschnitt um den Finger, oberhalb davon angezeigt
function zeigeLupe(px, py) {
  const lupe = $("lupe");
  const b = zustand.bild;
  const c = lupe;
  const groesse = c.width;
  const g = c.getContext("2d");
  const quelleBreite = b.vorschau.width / 7; // Zoom etwa 7-fach gegenüber dem ganzen Bild
  const sx = px * b.vorschau.width - quelleBreite / 2, sy = py * b.vorschau.height - quelleBreite / 2;
  g.fillStyle = "#000";
  g.fillRect(0, 0, groesse, groesse);
  g.drawImage(b.vorschau, sx, sy, quelleBreite, quelleBreite, 0, 0, groesse, groesse);
  g.strokeStyle = "#e23";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(groesse / 2, 0); g.lineTo(groesse / 2, groesse);
  g.moveTo(0, groesse / 2); g.lineTo(groesse, groesse / 2);
  g.stroke();
  lupe.classList.remove("versteckt");
  const flaeche = $("eckenFlaeche").getBoundingClientRect();
  const lb = lupe.getBoundingClientRect().width || 140;
  let left = px * flaeche.width - lb / 2;
  let top = py * flaeche.height - lb - 50;
  if (top < 0) top = py * flaeche.height + 50;
  left = Math.max(0, Math.min(flaeche.width - lb, left));
  lupe.style.left = left + "px";
  lupe.style.top = top + "px";
}

function versteckeLupe() { $("lupe").classList.add("versteckt"); }

// Kleine Vorschau, wie das Blatt nach dem Entzerren aussieht
function zeichneProbe() {
  const b = zustand.bild;
  if (!vorschauPixel) return;
  const c = $("probeCanvas");
  const W = 444, H = 315;
  c.width = W; c.height = H;
  const s = vorschauPixel.width / b.breite;
  const ecken = b.ecken.map(([x, y]) => [x * s, y * s]);
  const mitten = b.mitten.map(([x, y]) => [x * s, y * s]);
  const f = verzerrung(ecken, mitten, W, H);
  const aus = new ImageData(W, H);
  const q = vorschauPixel.data, qw = vorschauPixel.width, qh = vorschauPixel.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [u, v] = f(x + 0.5, y + 0.5);
      const o = (y * W + x) * 4;
      const ui = Math.round(u), vi = Math.round(v);
      if (ui < 0 || vi < 0 || ui >= qw || vi >= qh) { aus.data[o] = aus.data[o + 1] = aus.data[o + 2] = 0; aus.data[o + 3] = 255; continue; }
      const p = (vi * qw + ui) * 4;
      aus.data[o] = q[p]; aus.data[o + 1] = q[p + 1]; aus.data[o + 2] = q[p + 2]; aus.data[o + 3] = 255;
    }
  }
  c.getContext("2d").putImageData(aus, 0, 0);
}

// Ziehen mit Finger oder Maus; Rückgabe in Anteilen (0..1) der Fläche
function bindeZiehen(element, flaeche, beiBewegung, beiEnde) {
  element.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    element.setPointerCapture(e.pointerId);
    const bewegen = (ev) => {
      const r = flaeche.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const py = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      beiBewegung(px, py, ev);
    };
    const ende = () => {
      element.removeEventListener("pointermove", bewegen);
      element.removeEventListener("pointerup", ende);
      element.removeEventListener("pointercancel", ende);
      if (beiEnde) beiEnde();
    };
    element.addEventListener("pointermove", bewegen);
    element.addEventListener("pointerup", ende);
    element.addEventListener("pointercancel", ende);
  });
}

function dreheListe(l) { return [l[3], l[0], l[1], l[2]]; }

$("drehenBtn").addEventListener("click", () => {
  zustand.bild.ecken = dreheListe(zustand.bild.ecken);
  zustand.bild.mitten = dreheListe(zustand.bild.mitten);
  zustand.bild.lageSuchen = false; // von Hand gedreht: so lassen
  zeichneEcken();
  zeichneProbe();
});

$("geradeBtn").addEventListener("click", () => {
  const e = zustand.bild.ecken;
  zustand.bild.mitten = [0, 1, 2, 3].map((i) => [(e[i][0] + e[(i + 1) % 4][0]) / 2, (e[i][1] + e[(i + 1) % 4][1]) / 2]);
  zeichneEcken();
  zeichneProbe();
});

$("eckenZurueckBtn").addEventListener("click", () => {
  verwerfeBild();
  zeige("start");
});

function sendeAuswertung() {
  zustand.startZeit = performance.now();
  zustand.worker.postMessage({
    typ: "auswerten", ecken: zustand.bild.ecken, mitten: zustand.bild.mitten,
    schablone: zustand.schablone, lageSuchen: zustand.bild.lageSuchen
  });
}

$("auswertenBtn").addEventListener("click", () => {
  if (!zustand.bereit) { meldung("eckenMeldung", "Die Erkennung lädt noch, bitte kurz warten."); return; }
  $("auswertenBtn").disabled = true;
  meldung("eckenMeldung", "Wird ausgewertet …");
  sendeAuswertung();
});

function verwerfeBild() {
  if (zustand.bild && zustand.bild.vorschau) zustand.bild.vorschau.close();
  zustand.bild = null;
  vorschauPixel = null;
  zustand.worker.postMessage({ typ: "loeschen" });
}

// ------------------------------------------------------------ Ergebnis
function zeigeErgebnis(n) {
  meldung("eckenMeldung", "");
  // Lage wurde automatisch gefunden: Ecken entsprechend weiterschalten und dabei bleiben
  for (let k = 0; k < (n.gedreht || 0); k++) {
    zustand.bild.ecken = dreheListe(zustand.bild.ecken);
    zustand.bild.mitten = dreheListe(zustand.bild.mitten);
  }
  zustand.bild.lageSuchen = false;
  const neu = !zustand.ergebnis || !zustand.ergebnis.wiederholung;
  if (zustand.ergebnis && zustand.ergebnis.entzerrt) zustand.ergebnis.entzerrt.close();
  const zeiten = {
    entzerren: zustand.bild.eckenZeit + n.zeiten.entzerren,
    erkennung: n.zeiten.erkennung,
    gesamt: zustand.bild.eckenZeit + (performance.now() - zustand.startZeit)
  };
  let rezept;
  if (neu) {
    rezept = { zeiten, urteile: new Map(), ampeln: new Map() };
    zustand.sitzung.push(rezept);
  } else {
    rezept = zustand.ergebnis.rezept;
    rezept.zeiten = zeiten;
  }
  zustand.ergebnis = { felder: n.felder, entzerrt: n.entzerrt, zeiten, rezept, wiederholung: false };
  $("ergebnisZeiten").textContent = `Entzerren ${sek(zeiten.entzerren)} · Erkennung ${sek(zeiten.erkennung)} · gesamt ${sek(zeiten.gesamt)}`;
  zeichneFelder();
  zeige("ergebnis");
  aktualisiereAuswertung();
}

function zeichneFelder() {
  const erg = zustand.ergebnis;
  const bewertung = bewerte(erg.felder, zustand.schablone, zustand.schwelle);
  erg.bewertung = bewertung;
  const liste = $("felderListe");
  liste.replaceChildren();
  const nachId = new Map(erg.felder.map((f) => [f.id, f]));
  for (const def of zustand.schablone.felder) {
    const f = nachId.get(def.id);
    const b = bewertung.get(def.id);
    if (!f || !b) continue;
    erg.rezept.ampeln.set(def.id, b.ampel);
    const karte = el("div", "feld " + b.ampel);
    karte.dataset.feld = def.id;
    const kopf = el("div", "feld-kopf");
    kopf.append(el("span", "", def.name), el("span", "ampel", { gruen: "plausibel", gelb: "prüfen", rot: "nicht lesbar", leer: "leer" }[b.ampel]));
    const c = document.createElement("canvas");
    c.width = f.ausschnitt.width; c.height = f.ausschnitt.height;
    c.getContext("2d").putImageData(f.ausschnitt, 0, 0);
    const wert = el("div", "feld-wert" + (b.wert ? "" : " ohne"), b.wert || "(leer)");
    wert.dataset.wert = b.wert || "";
    if (b.roh !== undefined) wert.dataset.roh = b.roh;
    const hinweis = el("div", "feld-hinweis", [b.roh && b.roh !== b.wert && def.art !== "heilmittel" ? `gelesen: ${b.roh}` : "", ...b.hinweise].filter(Boolean).join(" · "));
    const knoepfe = el("div", "feld-knoepfe");
    const ja = el("button", "zweit", "stimmt");
    const nein = el("button", "zweit", "falsch");
    ja.type = nein.type = "button";
    ja.dataset.urteil = "ja"; nein.dataset.urteil = "nein";
    const setze = () => {
      const u = erg.rezept.urteile.get(def.id);
      ja.className = u === true ? "gewaehlt-ja" : "zweit";
      nein.className = u === false ? "gewaehlt-nein" : "zweit";
    };
    ja.addEventListener("click", () => { erg.rezept.urteile.set(def.id, true); setze(); aktualisiereAuswertung(); });
    nein.addEventListener("click", () => { erg.rezept.urteile.set(def.id, false); setze(); aktualisiereAuswertung(); });
    setze();
    knoepfe.append(ja, nein);
    karte.append(kopf, c, wert, hinweis, knoepfe);
    liste.append(karte);
  }
}

$("schwelle").addEventListener("input", (e) => {
  zustand.schwelle = Number(e.target.value);
  $("schwelleWert").textContent = Math.round(zustand.schwelle * 100) + " %";
  if (zustand.ergebnis) { zeichneFelder(); aktualisiereAuswertung(); }
});

$("naechstesBtn").addEventListener("click", () => {
  if (zustand.ergebnis && zustand.ergebnis.entzerrt) zustand.ergebnis.entzerrt.close();
  zustand.ergebnis = null;
  $("felderListe").replaceChildren();
  verwerfeBild();
  zeige("start");
});

// ------------------------------------------------------------ Kalibrierung
let kalibrierRahmen = [];
let kalibrierSetzer = [];

function waehleRahmen(i, sichtbar = false) {
  kalibrierRahmen.forEach((r, k) => r.classList.toggle("aktiv", k === i));
  $("feldWahl").value = String(i);
  if (sichtbar && kalibrierRahmen[i]) kalibrierRahmen[i].scrollIntoView({ block: "nearest", inline: "center" });
}

$("feldWahl").addEventListener("change", (e) => waehleRahmen(Number(e.target.value), true));

$("zoom").addEventListener("change", (e) => {
  $("kalibrierFlaeche").style.width = Number(e.target.value) * 100 + "%";
  const i = Number($("feldWahl").value);
  if (kalibrierRahmen[i]) kalibrierRahmen[i].scrollIntoView({ block: "nearest", inline: "center" });
});

for (const knopf of document.querySelectorAll("[data-schritt]")) {
  knopf.addEventListener("click", () => {
    const i = Number($("feldWahl").value);
    const feld = zustand.schablone.felder[i];
    if (!feld) return;
    const [achse, richtung] = knopf.dataset.schritt.split(",");
    const [bw, bh] = zustand.schablone.blatt_mm || [148, 105];
    const schritt = (achse === "x" || achse === "w" ? 0.5 / bw : 0.5 / bh) * Number(richtung);
    feld[achse] = runde(Math.max(0.003, feld[achse] + schritt));
    feld.x = Math.min(feld.x, 1 - feld.w); feld.y = Math.min(feld.y, 1 - feld.h);
    kalibrierSetzer[i]();
  });
}

$("kalibrierBtn").addEventListener("click", () => {
  const c = $("kalibrierCanvas");
  const bm = zustand.ergebnis.entzerrt;
  c.width = bm.width; c.height = bm.height;
  c.getContext("2d").drawImage(bm, 0, 0);
  const flaeche = $("kalibrierFlaeche");
  for (const r of kalibrierRahmen) r.remove();
  kalibrierRahmen = [];
  kalibrierSetzer = [];
  const wahl = $("feldWahl");
  wahl.replaceChildren();
  zustand.schablone.felder.forEach((feld, i) => {
    const o = el("option", "", feld.name);
    o.value = String(i);
    wahl.append(o);
  });
  for (const feld of zustand.schablone.felder) {
    const index = kalibrierSetzer.length;
    const r = el("div", "rahmen" + (feld.typ === "kreuz" ? " kreuz" : ""));
    r.append(el("div", "name", feld.name));
    const griff = el("div", "groesse");
    r.append(griff);
    const setze = () => {
      r.style.left = feld.x * 100 + "%"; r.style.top = feld.y * 100 + "%";
      r.style.width = feld.w * 100 + "%"; r.style.height = feld.h * 100 + "%";
    };
    setze();
    let versatz = null;
    kalibrierSetzer.push(setze);
    r.addEventListener("pointerdown", (e) => {
      waehleRahmen(index);
      const fl = flaeche.getBoundingClientRect();
      versatz = [(e.clientX - fl.left) / fl.width - feld.x, (e.clientY - fl.top) / fl.height - feld.y];
    });
    bindeZiehen(r, flaeche, (px, py, ev) => {
      if (ev.target === griff || !versatz) return;
      feld.x = runde(Math.min(1 - feld.w, Math.max(0, px - versatz[0])));
      feld.y = runde(Math.min(1 - feld.h, Math.max(0, py - versatz[1])));
      setze();
    });
    bindeZiehen(griff, flaeche, (px, py) => {
      feld.w = runde(Math.max(0.005, px - feld.x));
      feld.h = runde(Math.max(0.005, py - feld.y));
      setze();
    });
    griff.addEventListener("pointerdown", (e) => e.stopPropagation());
    flaeche.append(r);
    kalibrierRahmen.push(r);
  }
  waehleRahmen(0);
  zeige("kalibrierung");
});

function runde(v) { return Math.round(v * 10000) / 10000; }

// Kalibrier-JSON: nur Feldkennung und vier Zahlen (x, y, Breite, Höhe als Anteil
// der Blattgröße). Keine Namen, keine erkannten Werte, kein Bild.
function kalibrierJson() {
  const felder = {};
  for (const f of zustand.schablone.felder) felder[f.id] = [f.x, f.y, f.w, f.h];
  return JSON.stringify({ muster13: 1, felder });
}

$("jsonBtn").addEventListener("click", () => {
  $("jsonAusgabe").value = kalibrierJson();
  for (const id of ["jsonAusgabe", "jsonKopierenBtn", "jsonUebernehmenBtn"]) $(id).classList.remove("versteckt");
  meldung("jsonMeldung", "");
});

// Früher kopiertes JSON wieder einspielen (z. B. nach dem Neuladen der Seite)
$("jsonUebernehmenBtn").addEventListener("click", () => {
  try {
    const daten = JSON.parse($("jsonAusgabe").value);
    const liste = daten.felder;
    let n = 0;
    for (const f of zustand.schablone.felder) {
      let w = Array.isArray(liste) ? liste.find((x) => x.id === f.id) : liste[f.id];
      if (w && !Array.isArray(w)) w = [w.x, w.y, w.w, w.h];
      if (!w || w.length !== 4 || !w.every((z) => typeof z === "number" && z >= 0 && z <= 1)) continue;
      [f.x, f.y, f.w, f.h] = w;
      n++;
    }
    kalibrierSetzer.forEach((setze) => setze());
    meldung("jsonMeldung", `${n} Rahmen übernommen.`);
  } catch (e) {
    meldung("jsonMeldung", "Das ist kein gültiges Kalibrier-JSON.");
  }
});

$("eckenNachziehenBtn").addEventListener("click", () => {
  zustand.ergebnis.wiederholung = true;
  zeichneEcken();
  zeichneProbe();
  $("auswertenBtn").disabled = false;
  zeige("ecken");
});
$("jsonKopierenBtn").addEventListener("click", () => kopiere($("jsonAusgabe")));

$("neuAuswertenBtn").addEventListener("click", () => {
  zustand.ergebnis.wiederholung = true;
  sendeAuswertung();
});
$("kalibrierZurueckBtn").addEventListener("click", () => zeige("ergebnis"));

// ------------------------------------------------------------ Auswertung
function aktualisiereAuswertung() {
  const s = zustand.sitzung;
  const zeilen = [];
  zeilen.push("OCR-Prototyp Muster 13 – Auswertung");
  zeilen.push(`Datum: ${new Date().toLocaleDateString("de-DE")}`);
  zeilen.push(`Gerät: ${geraet()}`);
  zeilen.push(`Rezepte ausgewertet: ${s.length}`);
  if (s.length) {
    const reihe = (k) => s.map((r) => r.zeiten[k]);
    const mittel = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    zeilen.push("Dauer je Rezept (Mittel / langsamstes):");
    zeilen.push(`  Entzerren  ${sek(mittel(reihe("entzerren")))} / ${sek(Math.max(...reihe("entzerren")))}`);
    zeilen.push(`  Erkennung  ${sek(mittel(reihe("erkennung")))} / ${sek(Math.max(...reihe("erkennung")))}`);
    zeilen.push(`  Gesamt     ${sek(mittel(reihe("gesamt")))} / ${sek(Math.max(...reihe("gesamt")))}`);
  }
  zeilen.push("Trefferquote je Feld (stimmt / bewertet):");
  let summeJa = 0, summeAlle = 0;
  const ampeln = { gruen: 0, gelb: 0, rot: 0, leer: 0 };
  for (const r of s) for (const a of r.ampeln.values()) ampeln[a]++;
  for (const def of (zustand.schablone ? zustand.schablone.felder : [])) {
    let ja = 0, alle = 0;
    for (const r of s) {
      if (!r.urteile.has(def.id)) continue;
      alle++;
      if (r.urteile.get(def.id)) ja++;
    }
    summeJa += ja; summeAlle += alle;
    const quote = alle ? Math.round((ja / alle) * 100) + " %" : "–";
    zeilen.push(`  ${def.name.padEnd(38).slice(0, 38)} ${String(ja).padStart(3)}/${String(alle).padEnd(3)} ${quote}`);
  }
  zeilen.push(`Gesamt: ${summeJa}/${summeAlle} ${summeAlle ? Math.round((summeJa / summeAlle) * 100) + " %" : "–"}`);
  zeilen.push(`Ampeln: grün ${ampeln.gruen}, gelb ${ampeln.gelb}, rot ${ampeln.rot}, leer ${ampeln.leer}`);
  $("auswertungText").value = zeilen.join("\n");
}

async function kopiere(textfeld) {
  try {
    await navigator.clipboard.writeText(textfeld.value);
  } catch (e) {
    textfeld.select();
    document.execCommand("copy");
  }
}
$("kopierenBtn").addEventListener("click", () => kopiere($("auswertungText")));

$("loeschenBtn").addEventListener("click", () => {
  kameraStopp();
  if (zustand.ergebnis && zustand.ergebnis.entzerrt) zustand.ergebnis.entzerrt.close();
  zustand.ergebnis = null;
  zustand.sitzung = [];
  $("felderListe").replaceChildren();
  for (const r of kalibrierRahmen) r.remove();
  kalibrierRahmen = [];
  kalibrierSetzer = [];
  $("feldWahl").replaceChildren();
  const c1 = $("eckenCanvas"), c2 = $("kalibrierCanvas");
  c1.width = c1.height = c2.width = c2.height = 0;
  $("jsonAusgabe").value = "";
  if (zustand.bild) verwerfeBild();
  zustand.worker.postMessage({ typ: "loeschen" });
  ladeSchablone();
  aktualisiereAuswertung();
  zeige("start");
});

// ------------------------------------------------------------ Start
async function ladeSchablone() {
  const a = await fetch(new URL("./schablone-muster13.json", import.meta.url), { credentials: "omit" });
  zustand.schablone = await a.json();
}

(async () => {
  $("schwelleWert").textContent = Math.round(zustand.schwelle * 100) + " %";
  $("schwelle").value = String(zustand.schwelle);
  await ladeSchablone();
  aktualisiereAuswertung();
  starteWorker();
})();
