#!/usr/bin/env node
// Test del cuadre puro (cuadre.js). Correr: node tools/test-cuadre.js
"use strict";

const path = require("path");
const { evaluarCuadre, repararCantidades } = require(path.join(__dirname, "..", "cuadre.js"));

let fallas = 0;
function check(nombre, cond, detalle) {
  if (cond) { console.log("  ✓ " + nombre); }
  else { fallas++; console.log("  ✗ " + nombre + (detalle ? " — " + detalle : "")); }
}

// Factura 548981 (04-sep-2026), extraccion CORRECTA: 19 lineas, 125 uds, neto 1.869.000.
const OK_548981 = {
  costo_neto: 1869000,
  productos: [
    ["AHSSCS160235B", 3, 22000], ["AHSSCS57X90LB", 10, 4500], ["AHSSCS57X90RD", 10, 4500],
    ["AHSSNB160235A", 5, 32000], ["AHSSNB160235M", 3, 32000], ["AHSSNB57X90AR", 10, 4500],
    ["AHSSNB57X90MC", 10, 4500], ["AHSSTR160235A", 3, 32000], ["AJTBRRED150NT", 5, 35000],
    ["AJTBRRED200AR", 5, 40000], ["AJTBRRED200NT", 5, 50000], ["ASCL50X100BEI", 10, 4300],
    ["ASCL50X100NER", 10, 4300], ["ASCL50X100TER", 10, 4300], ["ASHD7170230GR", 3, 28000],
    ["ASHGZ050100TE", 10, 4300], ["ASHGZ170230BG", 5, 30000], ["ASHGZ170230GR", 5, 30000],
    ["ASHGZ170230NG", 3, 30000],
  ].map(([sku, cantidad, costo_unitario]) => ({ sku, cantidad, costo_unitario })),
};

console.log("evaluarCuadre");
{
  const r = evaluarCuadre(OK_548981);
  check("548981 correcta cuadra al peso", r.evaluable && r.cuadra === true && r.suma === 1869000 && r.unidades === 125, JSON.stringify(r));
}
{
  // La corrida REAL fallida del operador (04-sep 15:09): Shaggy D7 con la fila
  // de abajo (10 x 4.300) → suma 2.023.000 y 127 uds segun la pantalla. Aca
  // reproducimos el efecto minimo: una linea corrida.
  const mal = JSON.parse(JSON.stringify(OK_548981));
  const d7 = mal.productos.find((p) => p.sku === "ASHD7170230GR");
  d7.cantidad = 10; d7.costo_unitario = 4300;
  const r = evaluarCuadre(mal);
  check("una linea corrida NO cuadra y reporta el delta", r.evaluable && r.cuadra === false && r.delta === 43000 - 84000, JSON.stringify(r));
}
{
  const r = evaluarCuadre({ costo_neto: 0, productos: OK_548981.productos });
  check("sin neto (0) no es evaluable: cuadra=null, no false", r.evaluable === false && r.cuadra === null);
}
{
  const r = evaluarCuadre({ costo_neto: 1869000, productos: [] });
  check("sin productos no es evaluable", r.evaluable === false && r.cuadra === null && r.suma === 0);
}
{
  const r = evaluarCuadre({ costo_neto: "1869000", productos: [{ cantidad: "3", costo_unitario: "623000" }] });
  check("tolera numeros como string (JSON del modelo)", r.evaluable && r.cuadra === true);
}
{
  const r = evaluarCuadre(null);
  check("input nulo no revienta", r.evaluable === false && r.suma === 0);
}

console.log("\nrepararCantidades");
{
  // La forma REAL del fallo: Vision pierde el "3" de la fila, Claude adivina la
  // cantidad (10) pero precio (28.000) y Valor Total (84.000) vienen bien.
  const p = { costo_neto: 1869000, productos: [
    { sku: "ASHD7170230GR", cantidad: 10, costo_unitario: 28000, valor_total: 84000 },
    { sku: "ASCL50X100BEI", cantidad: 10, costo_unitario: 4300, valor_total: 43000 },
  ] };
  const r = repararCantidades(p);
  check("cantidad adivinada se corrige con valor_total / costo", r.reparadas === 1 && r.parsed.productos[0].cantidad === 3 && r.parsed.productos[0].cantidad_reparada === true, JSON.stringify(r.detalle));
  check("la linea que ya cuadra no se toca", r.parsed.productos[1].cantidad === 10 && !r.parsed.productos[1].cantidad_reparada);
  check("no muta el input", p.productos[0].cantidad === 10);
}
{
  // Corrimiento completo (cantidad, costo y total de la fila vecina): la linea
  // es internamente consistente y NO se puede reparar por fila — lo atrapa el
  // cuadre global. La funcion no debe inventar nada.
  const r = repararCantidades({ productos: [{ sku: "X", cantidad: 10, costo_unitario: 4300, valor_total: 43000 }] });
  check("linea consistente pero corrida: sin cambios", r.reparadas === 0);
}
{
  const r = repararCantidades({ productos: [{ sku: "X", cantidad: 10, costo_unitario: 4300, valor_total: 84000 }] });
  check("total no divisible por el costo: no se adivina", r.reparadas === 0 && r.parsed.productos[0].cantidad === 10);
}
{
  const r = repararCantidades({ productos: [
    { sku: "A", cantidad: 3, costo_unitario: 22000, valor_total: 0 },
    { sku: "B", cantidad: 3, costo_unitario: 0, valor_total: 66000 },
    { sku: "C", cantidad: 3, costo_unitario: 22000 },
  ] });
  check("sin total, sin costo o sin campo: no se toca", r.reparadas === 0);
}
{
  // Los 19 casos reales: con valor_total correcto y TODAS las cantidades en 0
  // (el modelo no las leyo), la reparacion reconstruye las 125 uds exactas.
  const p = JSON.parse(JSON.stringify(OK_548981));
  p.productos.forEach((x) => { x.valor_total = x.cantidad * x.costo_unitario; x.cantidad = 0; });
  const r = repararCantidades(p);
  const c = evaluarCuadre(r.parsed);
  check("548981 con cantidades en 0 se reconstruye entera desde los totales", r.reparadas === 19 && c.cuadra === true && c.unidades === 125, JSON.stringify(c));
}

console.log(fallas === 0 ? "\nRESULTADO: todos los tests pasan" : "\nRESULTADO: " + fallas + " falla(s)");
process.exit(fallas === 0 ? 0 : 1);
