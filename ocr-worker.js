// Web Worker: Blatt finden, entzerren, Felder auslesen. Kein Speicher, kein Netz
// außer den eigenen Dateien aus ocr-test/. Das Bild liegt nur in dieser Variablen.
import * as ort from "./lib/ort.wasm.min.mjs";
import {
  findeBlatt, randEcken, entzerre, feldRechteck, ausschnittRGBA,
  tintenAnteil, textZeilen, zeilenTensor, NORM_BREITE, NORM_HOEHE
} from "./bild.js";
import { kantenBild, findeViereck, findeMitten } from "./kanten.js";
import { pruefeDatum, pruefeIcd } from "./pruefung.js";
import { ausrichten, ausgerichtet } from "./ausrichten.js";

const MAX_KANTE = 3200;      // größere Fotos werden verkleinert
const SUCH_KANTE = 800;      // Bildgröße für die Blattsuche
const VORSCHAU_KANTE = 1400; // Bild für die Eckenanzeige

const DATEIEN = {
  wasm: "./lib/ort-wasm-simd-threaded.wasm",
  modell: "./models/latin_PP-OCRv3_rec_infer.onnx",
  woerter: "./models/latin_dict.txt"
};

let sitzung = null;
let zeichen = null;
let bild = null; // ImageData des aktuellen Fotos (nur Arbeitsspeicher)

function melde(nachricht, transfer = []) { self.postMessage(nachricht, transfer); }

async function ladeMitFortschritt(url, teil, gesamt) {
  const antwort = await fetch(new URL(url, import.meta.url), { credentials: "omit" });
  if (!antwort.ok) throw new Error(`Laden fehlgeschlagen: ${url} (${antwort.status})`);
  const laenge = Number(antwort.headers.get("content-length")) || 0;
  const leser = antwort.body.getReader();
  const teile = [];
  let geladen = 0;
  for (;;) {
    const { done, value } = await leser.read();
    if (done) break;
    teile.push(value);
    geladen += value.length;
    gesamt.geladen[teil] = geladen;
    if (laenge) gesamt.groesse[teil] = Math.max(laenge, geladen);
    melde({ typ: "fortschritt", geladen: Object.values(gesamt.geladen).reduce((a, b) => a + b, 0), groesse: Object.values(gesamt.groesse).reduce((a, b) => a + b, 0) });
  }
  const puffer = new Uint8Array(geladen);
  let o = 0;
  for (const t of teile) { puffer.set(t, o); o += t.length; }
  return puffer;
}

async function laden() {
  const t0 = performance.now();
  // ungefähre Größen, bis der Server die echten meldet
  const gesamt = { geladen: {}, groesse: { wasm: 11210254, modell: 8980573, woerter: 700 } };
  const [wasm, modell, woerter] = await Promise.all([
    ladeMitFortschritt(DATEIEN.wasm, "wasm", gesamt),
    ladeMitFortschritt(DATEIEN.modell, "modell", gesamt),
    ladeMitFortschritt(DATEIEN.woerter, "woerter", gesamt)
  ]);
  ort.env.wasm.wasmPaths = new URL("./lib/", import.meta.url).href;
  ort.env.wasm.wasmBinary = wasm.buffer;
  ort.env.wasm.numThreads = 1; // GitHub Pages ist nicht cross-origin-isolated
  ort.env.wasm.proxy = false;
  sitzung = await ort.InferenceSession.create(modell, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const liste = new TextDecoder().decode(woerter).split(/\r?\n/);
  if (liste[liste.length - 1] === "") liste.pop();
  zeichen = ["", ...liste, " "];
  melde({
    typ: "bereit",
    ladezeit: performance.now() - t0,
    bytes: wasm.length + modell.length + woerter.length
  });
}

function zuImageData(bitmap, maxKante) {
  const f = Math.min(1, maxKante / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * f), h = Math.round(bitmap.height * f);
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  return { daten: g.getImageData(0, 0, w, h), faktor: f };
}

export function drehe(liste, schritte) {
  let l = liste;
  for (let i = 0; i < ((schritte % 4) + 4) % 4; i++) l = [l[3], l[0], l[1], l[2]];
  return l;
}

async function neuesBild(bitmap) {
  const t0 = performance.now();
  bild = zuImageData(bitmap, MAX_KANTE).daten;
  const klein = zuImageData(bitmap, SUCH_KANTE);
  const vorschau = zuImageData(bitmap, VORSCHAU_KANTE);
  bitmap.close();
  const kw = klein.daten.width, kh = klein.daten.height;
  // 1) Kanten (Blattränder), 2) helle/weiße Fläche als zusätzlicher Vorschlag
  const kb = kantenBild(klein.daten);
  const hellFund = findeBlatt(klein.daten);
  const vorschlaege = hellFund.ecken && hellFund.grund !== "Kein Blatt gefunden" ? [{ e: hellFund.ecken, art: "flaeche" }] : [];
  const fund = findeViereck(kb, vorschlaege);
  const skal = bild.width / kw;
  let ecken, mitten, sicher = false, grund = "";
  if (fund) {
    ecken = fund.e;
    mitten = fund.mitten || findeMitten(kb, ecken);
    const b = fund.bewertung;
    sicher = b.mittel > 0.55 && b.minimum > 0.3;
    if (!sicher) grund = "Ränder nur teilweise erkannt";
  } else {
    ecken = randEcken(kw, kh);
    grund = "Kein Blatt gefunden";
  }
  if (!mitten) mitten = [0, 1, 2, 3].map((i) => [(ecken[i][0] + ecken[(i + 1) % 4][0]) / 2, (ecken[i][1] + ecken[(i + 1) % 4][1]) / 2]);
  ecken = ecken.map(([x, y]) => [x * skal, y * skal]);
  mitten = mitten.map(([x, y]) => [x * skal, y * skal]);
  // Muster 13 ist hochkant: die längere Kante soll links und rechts liegen.
  // Liegt das Blatt im Foto quer, die Ecken um eine Stelle weiterschalten.
  const kante = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const quer = kante(ecken[0], ecken[1]) + kante(ecken[3], ecken[2]);
  const hoch = kante(ecken[0], ecken[3]) + kante(ecken[1], ecken[2]);
  if (quer > hoch * 1.1) { ecken = drehe(ecken, 1); mitten = drehe(mitten, 1); }
  const vb = await createImageBitmap(vorschau.daten);
  melde({
    typ: "ecken", ecken, mitten, sicher, grund,
    breite: bild.width, hoehe: bild.height, vorschau: vb, zeit: performance.now() - t0
  }, [vb]);
}

function ctcDekodieren(ausgabe, schritte, klassen) {
  let text = "", letzte = 0;
  const wk = [];
  for (let t = 0; t < schritte; t++) {
    let best = 0, bw = -1;
    const o = t * klassen;
    for (let k = 0; k < klassen; k++) if (ausgabe[o + k] > bw) { bw = ausgabe[o + k]; best = k; }
    if (best !== 0 && best !== letzte) { text += zeichen[best] ?? ""; wk.push(bw); }
    letzte = best;
  }
  const konf = wk.length ? wk.reduce((a, b) => a + b, 0) / wk.length : 0;
  const minKonf = wk.length ? Math.min(...wk) : 0;
  return { text, konf, minKonf };
}

async function erkenneZeile(zeile) {
  const { daten, breite } = zeilenTensor(zeile);
  const tensor = new ort.Tensor("float32", daten, [1, 3, 48, breite]);
  const aus = await sitzung.run({ [sitzung.inputNames[0]]: tensor });
  const t = aus[sitzung.outputNames[0]];
  const [, schritte, klassen] = t.dims;
  return ctcDekodieren(t.data, schritte, klassen);
}

async function leseFeld(blatt, feld, ausrichtung) {
  const r = feldRechteck(ausgerichtet(feld, ausrichtung));
  const ausschnitt = ausschnittRGBA(blatt, r, 6);
  const e = { id: feld.id, ausschnitt };
  if (feld.typ === "kreuz") {
    e.anteil = tintenAnteil(blatt, r, 0.22, 0.55);
  } else {
    // Textfelder mit etwas Rand lesen: 0,6 mm oben/unten, 2 mm seitlich
    // (der Aufdruck sitzt je nach Praxisdrucker ein paar Millimeter versetzt)
    const ry = Math.round(NORM_HOEHE / 148 * 0.6), rx = Math.round(NORM_BREITE / 105 * 2);
    const x0 = Math.max(0, r.x - rx), y0 = Math.max(0, r.y - ry);
    const rr = { x: x0, y: y0, w: Math.min(NORM_BREITE - x0, r.w + 2 * rx), h: Math.min(NORM_HOEHE - y0, r.h + 2 * ry) };
    const { zeilen } = textZeilen(blatt, rr, feld.zeilen || 1, r.y - y0 + r.h / 2);
    e.zeilen = [];
    for (const z of zeilen) e.zeilen.push(await erkenneZeile(z));
  }
  return e;
}

// Lage prüfen: Daten und ICD-Code müssen lesbar sein. Wenn nicht, die anderen
// halbe Drehung versuchen (Blatt auf dem Kopf fotografiert).
async function lageGuete(blatt, schablone, ausrichtung) {
  let punkte = 0;
  for (const feld of schablone.felder) {
    if (!["ausstellungsdatum", "geburtsdatum", "icd"].includes(feld.art) || feld.optional) continue;
    const e = await leseFeld(blatt, feld, ausrichtung);
    const text = e.zeilen.map((z) => z.text).join(" ").trim();
    if (!text) continue;
    const b = feld.art === "icd" ? pruefeIcd(text) : pruefeDatum(text, feld.art);
    if (b.ampel === "gruen" || (b.ampel === "gelb" && !b.hinweise.some((h) => /ungültig|kein/.test(h)))) punkte++;
  }
  return punkte;
}

async function auswerten(ecken, mitten, schablone, lageSuchen) {
  if (!bild) throw new Error("Kein Bild vorhanden");
  if (!sitzung) throw new Error("Erkennung ist noch nicht geladen");
  const t0 = performance.now();
  const mm = schablone.blatt_mm || [105, 148];
  let blatt = entzerre(bild, ecken, NORM_BREITE, NORM_HOEHE, mitten);
  let ausrichtung = ausrichten(blatt, schablone.felder, mm);
  let gedreht = 0;
  if (lageSuchen) {
    const ziel = schablone.felder.filter((f) => ["ausstellungsdatum", "geburtsdatum", "icd"].includes(f.art) && !f.optional).length;
    let beste = await lageGuete(blatt, schablone, ausrichtung);
    // Hochkant ist schon über das Seitenverhältnis eingestellt; hier nur prüfen,
    // ob das Blatt auf dem Kopf steht (halbe Drehung).
    if (beste < ziel) {
      const b2 = entzerre(bild, drehe(ecken, 2), NORM_BREITE, NORM_HOEHE, drehe(mitten, 2));
      const a2 = ausrichten(b2, schablone.felder, mm);
      const g = await lageGuete(b2, schablone, a2);
      if (g > beste) { blatt = b2; ausrichtung = a2; gedreht = 2; }
    }
  }
  const t1 = performance.now();
  const felder = [];
  for (const feld of schablone.felder) felder.push(await leseFeld(blatt, feld, ausrichtung));
  const t2 = performance.now();
  const entzerrt = await createImageBitmap(blatt);
  melde({
    typ: "ergebnis", felder, entzerrt, gedreht, ausrichtung,
    zeiten: { entzerren: t1 - t0, erkennung: t2 - t1 }
  }, [entzerrt, ...felder.map((f) => f.ausschnitt.data.buffer)]);
}

self.onmessage = async (ereignis) => {
  const n = ereignis.data;
  try {
    if (n.typ === "laden") await laden();
    else if (n.typ === "bild") await neuesBild(n.bitmap);
    else if (n.typ === "auswerten") await auswerten(n.ecken, n.mitten, n.schablone, n.lageSuchen);
    else if (n.typ === "loeschen") { bild = null; melde({ typ: "geloescht" }); }
  } catch (fehler) {
    melde({ typ: "fehler", bei: n.typ, meldung: String(fehler && fehler.message || fehler) });
  }
};
