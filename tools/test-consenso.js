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
const { compararProductos } = require(path.join(__dirname, "..", "cuadre.js"));

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

console.log(fallas === 0 ? "\nRESULTADO: todos los tests pasan" : "\nRESULTADO: " + fallas + " falla(s)");
process.exit(fallas === 0 ? 0 : 1);
