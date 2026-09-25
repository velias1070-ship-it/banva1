#!/usr/bin/env node
// Test del cuadre puro (cuadre.js). Correr: node tools/test-cuadre.js
"use strict";

const path = require("path");
const { evaluarCuadre, repararCantidades, descuentoAlPieRespaldado, descuentoAplicable, descuentoCalzaConPct } = require(path.join(__dirname, "..", "cuadre.js"));

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
{
  // Factura 549298: imprime "Total Unidades: 424" y Vision lo lee. Es el unico
  // control que NO es de plata: atrapa reparaciones que inventan unidades.
  const p = Object.assign({ total_unidades: 125 }, OK_548981);
  const r = evaluarCuadre(p);
  check("total_unidades declarado y correcto: cuadraUnidades=true",
    r.unidadesDeclaradas === 125 && r.cuadraUnidades === true, JSON.stringify(r));
}
{
  const p = Object.assign({ total_unidades: 127 }, OK_548981);
  const r = evaluarCuadre(p);
  check("total_unidades declarado y distinto: cuadraUnidades=false aunque la plata cuadre",
    r.cuadra === true && r.cuadraUnidades === false, JSON.stringify(r));
}
{
  const r = evaluarCuadre(OK_548981);
  check("sin total_unidades: cuadraUnidades=null, no false (Regla 1)",
    r.unidadesDeclaradas === null && r.cuadraUnidades === null, JSON.stringify(r));
}
{
  const p = Object.assign({ total_unidades: "125" }, OK_548981);
  const r = evaluarCuadre(p);
  check("total_unidades como string (JSON del modelo) se tolera",
    r.unidadesDeclaradas === 125 && r.cuadraUnidades === true);
}

console.log("\nrepararCantidades");
{
  // La forma REAL del fallo 548981: Vision pierde el "3" de la fila y el modelo
  // entrega cantidad 0 (regla del prompt: cantidad no legible = 0, jamas
  // adivinada) con precio (28.000) y Valor Total (84.000) bien transcritos.
  const p = { costo_neto: 1869000, productos: [
    { sku: "ASHD7170230GR", cantidad: 0, costo_unitario: 28000, valor_total: 84000 },
    { sku: "ASCL50X100BEI", cantidad: 10, costo_unitario: 4300, valor_total: 43000 },
  ] };
  const r = repararCantidades(p);
  check("cantidad no leida (0) se deriva de valor_total / costo", r.reparadas === 1 && r.parsed.productos[0].cantidad === 3 && r.parsed.productos[0].cantidad_reparada === true, JSON.stringify(r.detalle));
  check("la linea que ya cuadra no se toca", r.parsed.productos[1].cantidad === 10 && !r.parsed.productos[1].cantidad_reparada);
  check("no muta el input", p.productos[0].cantidad === 0);
}
{
  // Regresion 549298 (07-sep-2026, medida en E2E): en la plantilla Idetex el
  // Valor Total viene impreso UNA fila corrido, asi que "reparar" una cantidad
  // POSITIVA con el total escribe la cantidad DE LA FILA VECINA — y como las
  // dos extracciones reparaban igual, el error salia correlacionado y el
  // consenso no lo veia (Bars 16 impreso + total 268.000 ajeno → 40 falso).
  // Una cantidad impresa y legible MANDA sobre el total: no se pisa.
  const p = { productos: [
    { sku: "TXV24QLBRBA15", cantidad: 16, costo_unitario: 6700, valor_total: 268000 },
  ] };
  const r = repararCantidades(p);
  check("cantidad positiva con total inconsistente: NO se pisa (total corrido)",
    r.reparadas === 0 && r.parsed.productos[0].cantidad === 16 && !r.parsed.productos[0].cantidad_reparada,
    JSON.stringify(r.detalle));
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

// ---- Descuento al pie ----
// Forma de la factura Chantilly 266248 (24-sep-2026): lineas a precio de lista,
// "Descuento" global al pie y "Monto Neto" ya descontado. Los montos de aca son
// SINTETICOS (el repo es publico): misma estructura, 10 % al pie.
// Lineas: 10 x 10.000 + 20 x 5.000 + 48 x 2.000 = 296.000; descuento 29.600; neto 266.400.
const CHANTILLY_FORMA = {
  costo_neto: 266400,
  descuento_pie: 29600,
  productos: [
    { sku: "111111111111", cantidad: 10, costo_unitario: 10000 },
    { sku: "222222222222", cantidad: 20, costo_unitario: 5000 },
    { sku: "333333333333", cantidad: 48, costo_unitario: 2000 },
  ],
};
// Fragmento del texto OCR con la MISMA disposicion que devolvio Vision para la
// 266248 (columna "Total Desc." en el encabezado, "Descuento" y su monto en
// lineas separadas, totales despues).
const OCR_FORMA = [
  "Cantidad", "Unidad", "Descripción", "P.Unit", "Total Desc.", "Valor Total",
  "10.00", "UNI", "111111111111 PRODUCTO A", "10,000", "100,000",
  "Descuento", "29,600",
  "Monto Neto", "IVA (19%)", "Total", "266,400", "50,616", "317,016",
].join("\n");

console.log("descuento al pie");
{
  const r = evaluarCuadre(CHANTILLY_FORMA);
  check("lineas a lista + descuento al pie: cuadra restando el descuento", r.cuadra === true && r.descuento === 29600 && r.delta === 0, JSON.stringify(r));
}
{
  const p = Object.assign({}, CHANTILLY_FORMA, { descuento_pie: 0 });
  const r = evaluarCuadre(p);
  check("la misma factura sin descuento leido: NO cuadra (comportamiento de antes)", r.cuadra === false && r.descuento === 0 && r.delta === 29600, JSON.stringify(r));
}
{
  // Factura que HOY cuadra directo + un descuento_pie espurio: no cambia nada.
  const p = Object.assign({}, OK_548981, { descuento_pie: 5000 });
  const r = evaluarCuadre(p);
  check("factura que cuadra directo: el descuento se ignora (descuento 0)", r.cuadra === true && r.descuento === 0 && r.delta === 0, JSON.stringify(r));
}
{
  // Linea mal leida + descuento que NO explica la diferencia: sigue sin cuadrar.
  const p = JSON.parse(JSON.stringify(CHANTILLY_FORMA));
  p.productos[1].cantidad = 21;
  const r = evaluarCuadre(p);
  check("linea mal leida con descuento: el descuento NO la tapa", r.cuadra === false && r.descuento === 0, JSON.stringify(r));
}
{
  const p = Object.assign({}, CHANTILLY_FORMA, { descuento_pie: "29600" });
  check("descuento como string numerico se acepta", evaluarCuadre(p).cuadra === true);
  const q = Object.assign({}, CHANTILLY_FORMA, { descuento_pie: -29600 });
  check("descuento negativo no aplica", evaluarCuadre(q).cuadra === false);
}
{
  check("respaldado: monto impreso junto a 'Descuento'", descuentoAlPieRespaldado(OCR_FORMA, 29600) === true);
  check("no respaldado: monto que no esta impreso", descuentoAlPieRespaldado(OCR_FORMA, 29601) === false);
  check("no respaldado: sin la palabra 'Descuento' (solo la columna 'Total Desc.')",
    descuentoAlPieRespaldado(OCR_FORMA.replace("Descuento\n", ""), 29600) === false);
  check("no respaldado: monto 0 o texto vacio", descuentoAlPieRespaldado(OCR_FORMA, 0) === false && descuentoAlPieRespaldado("", 29600) === false);
  check("respaldado con punto de miles (29.600)", descuentoAlPieRespaldado(OCR_FORMA.replace("29,600", "29.600"), 29600) === true);
  check("no confunde 'Descuentos varios' pegado a otra palabra", descuentoAlPieRespaldado("Sindescuento\n29,600", 29600) === false);
}
{
  // Tolerancia del frontend (100): misma regla que su cuadre de siempre.
  check("frontend: aplica dentro de ±100", descuentoAplicable(296050, 266400, 29600, 100) === 29600);
  check("frontend: no aplica si cuadra directo", descuentoAplicable(266450, 266400, 29600, 100) === 0);
  // Descuento chico (<= tolerancia): una factura que YA cuadra directo no cambia
  // su neto mostrado (sin la regla "cuadra directo → 0" esto devolvia 50).
  check("frontend: cuadra directo con descuento chico → 0", descuentoAplicable(266450, 266400, 50, 100) === 0);
  check("frontend: no aplica fuera de tolerancia", descuentoAplicable(296500, 266400, 29600, 100) === 0);
  check("frontend: sin neto no aplica", descuentoAplicable(296000, 0, 29600, 100) === 0);
}

console.log("descuento al pie — hallazgos de la revision");
{
  // Hallazgo 1 (escenario exacto de la revision): la palabra aparece en las
  // condiciones de pago y el "monto" es un precio unitario impreso lejos.
  const ocr = [
    "Condiciones: descuento 2% pago contado",
    "Glosa sin montos",
    "Otra linea",
    "10", "PRODUCTO A", "5,000", "50,000",
    "20", "PRODUCTO B", "3,400", "68,000",
    "Monto Neto", "118,000",
  ].join("\n");
  check("precio unitario lejos de 'Descuento' NO respalda", descuentoAlPieRespaldado(ocr, 5000) === false);
  check("el 2% de 'descuento 2%' no es un monto", descuentoAlPieRespaldado(ocr, 2) === false);
}
{
  check("'Descuento 10%' en una linea y el monto en la siguiente: respalda el monto",
    descuentoAlPieRespaldado("Descuento 10%\n29,600\nMonto Neto", 29600) === true);
  check("'Descuento 10%': el 10 NO respalda", descuentoAlPieRespaldado("Descuento 10%\n29,600", 10) === false);
  check("porcentaje con miles y espacio ('1.000 %') no es un monto", descuentoAlPieRespaldado("Descuento 1.000 %", 1000) === false);
  check("'Descuento $29.600' misma linea", descuentoAlPieRespaldado("Descuento $29.600", 29600) === true);
  check("'Descuento 29.600,00' con decimales", descuentoAlPieRespaldado("Descuento 29.600,00", 29600) === true);
  check("monto a 3 lineas del 'Descuento' ya no respalda",
    descuentoAlPieRespaldado("Descuento\na\nb\n29,600", 29600) === false);
}
{
  // Hallazgo 2/3: el % del proveedor. Suma a lista 296.000, 10 %.
  check("pct: descuento = 10 % exacto de la suma → calza", descuentoCalzaConPct(296000, 29600, 10, 3) === true);
  check("pct: proveedor sin % (null) → no calza", descuentoCalzaConPct(296000, 29600, null, 3) === false);
  check("pct: proveedor con 0 % → no calza", descuentoCalzaConPct(296000, 29600, 0, 3) === false);
  check("pct: redondeo por linea dentro de 1 peso por linea → calza", descuentoCalzaConPct(296000, 29602, 10, 3) === true);
  check("pct: descuento chico ('10') no calza con 10 % de la suma", descuentoCalzaConPct(296000, 10, 10, 3) === false);
}
{
  // La propiedad que importa: con el % del proveedor, NINGUNA cantidad
  // sobreleida o subleida puede cuadrar usando el descuento impreso.
  // Barrido: cada linea de CHANTILLY_FORMA con k = -5..5 (k != 0).
  let tapadas = 0, probadas = 0;
  CHANTILLY_FORMA.productos.forEach((_, i) => {
    for (let k = -5; k <= 5; k++) {
      if (k === 0) continue;
      const p = JSON.parse(JSON.stringify(CHANTILLY_FORMA));
      p.productos[i].cantidad += k;
      if (p.productos[i].cantidad <= 0) continue;
      probadas++;
      const suma = p.productos.reduce((s, x) => s + x.cantidad * x.costo_unitario, 0);
      const d = descuentoAplicable(suma, p.costo_neto, p.descuento_pie, 100);
      if (d > 0 && descuentoCalzaConPct(suma, d, 10, 3)) tapadas++;
    }
  });
  check("barrido de " + probadas + " lecturas malas: el descuento no tapa ninguna", tapadas === 0 && probadas > 20, "tapadas=" + tapadas);
}

// Caso donde SOLO el % del proveedor salva (revisión ronda 2): el barrido de
// arriba nunca llega al chequeo del %, porque con el descuento verdadero
// descuentoAplicable ya devuelve 0. Acá «Descuento» es encabezado de columna,
// una cantidad está sobreleída (20→21) y el modelo transcribe como descuento
// un número de la fila (5,000) que justo tapa el error.
{
  const ocr = ["Cantidad UNI Descripcion P.Unit Descuento Valor Total",
    "10 UNI PRODUCTO A 10,000 100,000", "20 UNI PRODUCTO B 5,000 100,000",
    "48 UNI PRODUCTO C 2,000 96,000", "Monto Neto 296,000"].join("\n");
  const suma = 10 * 10000 + 21 * 5000 + 48 * 2000; // 301.000, B sobreleída
  const respaldado = descuentoAlPieRespaldado(ocr, 5000);
  const d = descuentoAplicable(suma, 296000, 5000, 100);
  check("encabezado de columna: la ventana lo respalda (límite conocido)", respaldado === true);
  check("encabezado de columna: el cuadre solo lo taparía", d === 5000, "d=" + d);
  check("encabezado de columna: el % del proveedor lo frena", !(respaldado && d > 0 && descuentoCalzaConPct(suma, d, 10, 3)));
}

console.log(fallas === 0 ? "\nRESULTADO: todos los tests pasan" : "\nRESULTADO: " + fallas + " falla(s)");
process.exit(fallas === 0 ? 0 : 1);
