#!/usr/bin/env node
// ============================================================
// Test del consenso entre dos extracciones (cuadre.js → compararProductos)
// Correr: node tools/test-consenso.js  (sin dependencias)
// ============================================================
// Fixtures REALES de la factura Idetex 549298 (07-sep-2026):
// - CORRECTA: las 16 lineas tal como estan impresas en la factura (verificadas
//   a ojo contra la imagen y corregidas en el WMS el mismo dia).
// - PROD: lo que la corrida de produccion (12:38) mando al WMS — cantidades
//   PERMUTADAS dentro de los dos grupos de precio igual (Bruselas Single a
//   $6.700 y Breda 15P a $7.000). Cada linea cuadraba con su total y la suma
//   daba el neto exacto ($3.517.600): invisible para todo control de plata.
// - REPRO: re-corrida de la MISMA foto la tarde del 07-sep — cruce masivo con
//   RS15 duplicado y GR15 desaparecido, y AUN ASI cuadra=true (los trios
//   cantidad/costo/total viajan intactos en el SKU equivocado).
// El unico control posible para la clase "permutacion mismo precio" es
// comparar DOS extracciones independientes: no fallan igual dos veces.
"use strict";

const path = require("path");
const { compararProductos, verificarCantidadPorOrdenOcr } = require(path.join(__dirname, "..", "cuadre.js"));

let fallas = 0;
function check(nombre, cond, detalle) {
  if (cond) { console.log("  ✓ " + nombre); }
  else { fallas++; console.log("  ✗ " + nombre + (detalle ? " — " + detalle : "")); }
}

function armar(lineas) {
  return { productos: lineas.map(([sku, cantidad, costo_unitario]) => ({ sku, cantidad, costo_unitario })) };
}

const CORRECTA_549298 = armar([
  ["TXV24QLBRBA15", 16, 6700], ["TXV24QLBRFL15", 40, 6700],
  ["TXV25QLBRBG15", 32, 7000], ["TXV25QLBRGR15", 40, 7000],
  ["TXV25QLBRRS15", 24, 7000], ["TXV25QLBRVD15", 16, 7000],
  ["TXV24QLBRMA20", 8, 8200], ["TXV24QLBRCF25", 8, 9100],
  ["TXV25QLBRGR20", 80, 8000], ["TXV25QLBRVD20", 30, 8000],
  ["TXV25QLBRBG20", 40, 8000], ["TXV25QLBRGR25", 40, 9000],
  ["TXV25QLBRRS30", 5, 10000], ["TXV25QLBRCE30", 5, 10000],
  ["TXW26PMVC15GR", 28, 14000], ["TXW26PMVC15TE", 12, 14000],
]);

// La corrida real de produccion: 5 cantidades permutadas, 11 correctas.
const PROD_549298 = armar([
  ["TXV24QLBRBA15", 40, 6700], ["TXV24QLBRFL15", 16, 6700],
  ["TXV25QLBRBG15", 40, 7000], ["TXV25QLBRGR15", 24, 7000],
  ["TXV25QLBRRS15", 32, 7000], ["TXV25QLBRVD15", 16, 7000],
  ["TXV24QLBRMA20", 8, 8200], ["TXV24QLBRCF25", 8, 9100],
  ["TXV25QLBRGR20", 80, 8000], ["TXV25QLBRVD20", 30, 8000],
  ["TXV25QLBRBG20", 40, 8000], ["TXV25QLBRGR25", 40, 9000],
  ["TXV25QLBRRS30", 5, 10000], ["TXV25QLBRCE30", 5, 10000],
  ["TXW26PMVC15GR", 28, 14000], ["TXW26PMVC15TE", 12, 14000],
]);

// La re-corrida de la misma foto: cruce masivo, RS15 dos veces, sin GR15.
const REPRO_549298 = armar([
  ["TXV24QLBRFL15", 16, 6700], ["TXV24QLBRBA15", 40, 6700],
  ["TXV25QLBRRS15", 32, 7000], ["TXV24QLBRCF25", 40, 7000],
  ["TXV25QLBRVD20", 24, 7000], ["TXV25QLBRBG20", 16, 7000],
  ["TXV25QLBRGR25", 8, 8200], ["TXV25QLBRRS30", 8, 9100],
  ["TXV25QLBRCE30", 80, 8000], ["TXV25QLBRVD15", 30, 8000],
  ["TXV25QLBRRS15", 40, 8000], ["TXV24QLBRMA20", 40, 9000],
  ["TXV25QLBRGR20", 5, 10000], ["TXV25QLBRBG15", 5, 10000],
  ["TXW26PMVC15GR", 28, 14000], ["TXW26PMVC15TE", 12, 14000],
]);

console.log("compararProductos");
{
  const r = compararProductos(CORRECTA_549298, CORRECTA_549298);
  check("dos extracciones identicas: 16 coinciden, 0 discrepancias",
    r.evaluable && r.coinciden === 16 && r.discrepancias.length === 0 &&
    r.soloA.length === 0 && r.soloB.length === 0 &&
    r.duplicadosA.length === 0 && r.duplicadosB.length === 0,
    JSON.stringify(r));
}
{
  // EL caso 549298: la permutacion mismo-precio que ningun control de plata ve.
  const r = compararProductos(PROD_549298, CORRECTA_549298);
  const skus = r.discrepancias.map((d) => d.sku).sort();
  check("prod vs correcta: exactamente las 5 lineas permutadas",
    r.evaluable && r.coinciden === 11 && skus.join(",") ===
    "TXV24QLBRBA15,TXV24QLBRFL15,TXV25QLBRBG15,TXV25QLBRGR15,TXV25QLBRRS15",
    JSON.stringify(skus));
  const bars = r.discrepancias.find((d) => d.sku === "TXV24QLBRBA15");
  check("cada discrepancia trae las dos cantidades para que el operador elija",
    bars && bars.cantidadA === 40 && bars.cantidadB === 16, JSON.stringify(bars));
}
{
  const r = compararProductos(REPRO_549298, CORRECTA_549298);
  check("repro vs correcta: RS15 duplicado en A queda declarado (no se compara a ciegas)",
    r.duplicadosA.length === 1 && r.duplicadosA[0] === "TXV25QLBRRS15", JSON.stringify(r.duplicadosA));
  check("repro vs correcta: GR15 falta en A y queda declarado",
    r.soloB.length === 1 && r.soloB[0] === "TXV25QLBRGR15", JSON.stringify(r.soloB));
  check("repro vs correcta: el cruce masivo aparece como discrepancias, no en silencio",
    r.discrepancias.length >= 9, "discrepancias=" + r.discrepancias.length);
}
{
  // Costo distinto con la misma cantidad TAMBIEN es discrepancia: el trio
  // cantidad/costo/total del vecino puede viajar entero.
  const a = armar([["X", 10, 4300]]);
  const b = armar([["X", 10, 28000]]);
  const r = compararProductos(a, b);
  check("misma cantidad pero costo distinto: discrepancia igual",
    r.discrepancias.length === 1 && r.discrepancias[0].costoA === 4300 && r.discrepancias[0].costoB === 28000,
    JSON.stringify(r));
}
{
  const r = compararProductos({ productos: [] }, CORRECTA_549298);
  check("un lado vacio no es evaluable (no se afirma consenso sin datos)",
    r.evaluable === false && r.discrepancias.length === 0);
}
{
  const r = compararProductos(null, null);
  check("input nulo no revienta", r.evaluable === false);
}
{
  // SKUs con mayusculas/espacios distintos son el MISMO SKU (normalizacion).
  const a = armar([["txv24qlbrba15 ", 16, 6700]]);
  const r = compararProductos(a, armar([["TXV24QLBRBA15", 16, 6700]]));
  check("normaliza SKU antes de comparar", r.evaluable && r.coinciden === 1 && r.discrepancias.length === 0,
    JSON.stringify(r));
}

// ------------------------------------------------------------
// verificarCantidadPorOrdenOcr — ancla DETERMINISTA contra el error
// correlacionado (bateria 07-sep: Bars↔Flowers permutados IGUAL por los DOS
// modelos en 1 de 9 corridas; el consenso no ve lo que ambos fallan igual).
// En el stream de Vision la cantidad viene pegada ANTES de su descripcion
// ([16,40][Bars,Flowers] · [32][Beige]): eso ningun modelo lo puede pisar.
// Fixture = el texto OCR REAL de la 549298 (Vision, sin editar).
// ------------------------------------------------------------
const OCR_549298 = [
  "GR15", "Código", "TXV24QLBRBA15", "TXV24QLBRFL15", "Unid.", "16", "40",
  "Descripción del Producto", "Quilt Bruselas Bars Single", "Quilt Bruselas Flowers Single",
  "Precio U.", "Descto.", "Valor Total", "107.200", "6.700", "268.000", "6.700",
  "224.000", "32", "Quilt Breda 15P Beige", "7.000",
  "280.000", "40", "Quilt Breda 15P Gris", "7.000",
  "168.000", "24", "Quilt Breda 15P Rosa", "7.000",
  "112.000", "16", "Quilt Breda 15P Verde", "7.000",
  "65.600", "8", "Quilt Bruselas Marron 20P", "8.200",
  "72.800", "8", "Quilt Bruselas Café 25P", "9.100",
  "640.000", "80", "Quilt Breda 20P Gris", "8.000",
  "240.000", "30", "Quilt Breda 20P Verde", "8.000",
  "40", "Quilt Breda 20P Beige", "320.000", "8.000",
  "40", "Quilt Breda 25P Gris", "9.000",
  "360.000", "5", "Quilt Breda 30P Rosa", "10.000",
  "50.000", "5", "XW26PMVC15GR TXW26PMVC15GR", "XW26PMVC15TE TXW26PMVC15TE",
  "Quilt Breda 30P Celeste", "10.000", "50.000",
  "28", "12", "Plumon VL Corduroy Sherpa 15P Gris", "Plumon VL Corduroy Sherpa 15P Terracota",
  "14.000", "392.000", "14.000", "168.000", "Total Unidades: 424",
].join("\n");

const NOMBRES = {
  TXV24QLBRBA15: "Quilt Bruselas Bars Single", TXV24QLBRFL15: "Quilt Bruselas Flowers Single",
  TXV25QLBRBG15: "Quilt Breda 15P Beige", TXV25QLBRGR15: "Quilt Breda 15P Gris",
  TXV25QLBRRS15: "Quilt Breda 15P Rosa", TXV25QLBRVD15: "Quilt Breda 15P Verde",
  TXV24QLBRMA20: "Quilt Bruselas Marron 20P", TXV24QLBRCF25: "Quilt Bruselas Café 25P",
  TXV25QLBRGR20: "Quilt Breda 20P Gris", TXV25QLBRVD20: "Quilt Breda 20P Verde",
  TXV25QLBRBG20: "Quilt Breda 20P Beige", TXV25QLBRGR25: "Quilt Breda 25P Gris",
  TXV25QLBRRS30: "Quilt Breda 30P Rosa", TXV25QLBRCE30: "Quilt Breda 30P Celeste",
  TXW26PMVC15GR: "Plumon VL Corduroy Sherpa 15P Gris", TXW26PMVC15TE: "Plumon VL Corduroy Sherpa 15P Terracota",
};
function conNombres(parsed) {
  return { productos: parsed.productos.map((p) => Object.assign({}, p, { nombre: NOMBRES[p.sku] || "" })) };
}

console.log("\nverificarCantidadPorOrdenOcr");
{
  const r = verificarCantidadPorOrdenOcr(OCR_549298, conNombres(CORRECTA_549298));
  check("extraccion correcta: cero alertas y 15 filas verificadas (Celeste queda fuera: codigos en medio)",
    r.evaluable && r.alertas.length === 0 && r.verificadas === 15, JSON.stringify(r));
}
{
  // EL residuo: Bars↔Flowers permutados igual por los dos modelos. El orden
  // del OCR dice Bars=16 y Flowers=40 — determinista, atrapado siempre.
  const r = verificarCantidadPorOrdenOcr(OCR_549298, conNombres(PROD_549298));
  const skus = r.alertas.map((a) => a.sku).sort();
  check("las 5 permutadas de prod se detectan por orden del OCR (Bars/Flowers incluidas)",
    skus.join(",") === "TXV24QLBRBA15,TXV24QLBRFL15,TXV25QLBRBG15,TXV25QLBRGR15,TXV25QLBRRS15",
    JSON.stringify(r.alertas));
  const bars = r.alertas.find((a) => a.sku === "TXV24QLBRBA15");
  check("la alerta trae la cantidad que dicta el orden del OCR",
    bars && bars.cantidad_extraida === 40 && bars.cantidad_ocr === 16, JSON.stringify(bars));
}
{
  const r = verificarCantidadPorOrdenOcr("", conNombres(CORRECTA_549298));
  check("sin ocrText: no evaluable, cero alertas (Regla 1)", r.evaluable === false && r.alertas.length === 0);
}
{
  const r = verificarCantidadPorOrdenOcr("texto sin tabla\nnada que ver\n123.456", conNombres(CORRECTA_549298));
  check("OCR sin el patron cantidad→descripcion: cero alertas, cero ruido",
    r.alertas.length === 0 && r.verificadas === 0, JSON.stringify(r));
}
{
  // Dos productos con el MISMO nombre: no se puede saber cual es cual — se
  // saltan ambos en vez de adivinar.
  const dosIguales = { productos: [
    { sku: "A1", nombre: "Quilt Breda 15P Beige", cantidad: 32 },
    { sku: "A2", nombre: "Quilt Breda 15P Beige", cantidad: 9 },
  ] };
  const r = verificarCantidadPorOrdenOcr(OCR_549298, dosIguales);
  check("nombre duplicado en la extraccion: esas filas no se verifican (sin adivinar)",
    r.alertas.length === 0, JSON.stringify(r.alertas));
}

console.log(fallas === 0 ? "\nRESULTADO: todos los tests pasan" : "\nRESULTADO: " + fallas + " falla(s)");
process.exit(fallas === 0 ? 0 : 1);
