#!/usr/bin/env node
// ============================================================
// Test de los candados de integridad (locks.js) contra las variantes REALES
// observadas del incidente 546747 y contra extracciones sanas del corpus.
// Correr: node tools/test-candados.js  (sin dependencias)
// ============================================================
// Los fixtures no son inventados: son el estado exacto que dejo el incidente
// en la DB, las variantes medidas re-corriendo el pipeline de produccion
// (~10 corridas), y lineas reales de facturas sanas del barrido de 20.
"use strict";

const path = require("path");
const Locks = require(path.join(__dirname, "..", "locks.js"));

let fallas = 0;
function check(nombre, cond, detalle) {
  if (cond) { console.log("  ✓ " + nombre); }
  else { fallas++; console.log("  ✗ " + nombre + (detalle ? " — " + detalle : "")); }
}
function tipos(res) { return res.bloqueos.map(b => b.tipo).sort(); }

// Texto OCR real de la factura 546747 (Vision DOCUMENT_TEXT_DETECTION, misma
// config que produccion). Reducido a las partes que usan los candados: el
// bloque de codigos (con la fila 4 partida en dos renglones) y el pie.
const OCR_546747 = [
  "Cod.Alter.",
  "TXV24QLBRCN25 TXV24QLBRCN25",
  "TXV24QLBRMA15 TXV24QLBRMA15",
  "TXV25QLBRGR15 TXV25QLBRGR15",
  "TXV25QLBRD20",
  "TXV25QLBRVD20",
  "XW26PMVC5CR TXW26PMVC15CR",
  "XW26PMVC20AZ TXW26PMVC20AZ",
  "XW26PMVC25AZ TXW26PMVC25AZ",
  "XW26PMVC25TE TXW26PMVC25TE",
  "TXW26QLVD20AZ TXW26QLVD20AZ",
  "Total Unidades: 64",
  "NETO $ 780.800",
].join("\n");

// Nombres de catalogo reales (diccionario de produccion).
const DICT = {
  TXV24QLBRCN25: "Quilt Bruselas Canela 25P",
  TXV24QLBRMA15: "Quilt Bruselas Marron 15P",
  TXV25QLBRGR15: "Quilt Breda 15P Gris",
  TXV25QLBRVD20: "Quilt Breda 20P Verde",
  TXW26PMVC15CR: "Plumon VL Corduroy Sherpa 15P Crema",
  TXW26PMVC20AZ: "Plumon VL Corduroy Sherpa 20P Azul",
  TXW26PMVC25AZ: "Plumon VL Corduroy Sherpa 25P Azul",
  TXW26PMVC25TE: "Plumon VL Corduroy Sherpa 25P Terracota",
  TXW26QLVD20AZ: "Quilt Sherpa VL Dobby 20P Azul",
};
function linea(sku, nombreFactura, cantidad, costo, opts) {
  const o = opts || {};
  const enDict = Object.prototype.hasOwnProperty.call(DICT, sku);
  return {
    sku: sku, nombre: nombreFactura, cantidad: cantidad, costo: costo,
    nombreDict: o.nombreDict !== undefined ? o.nombreDict : (enDict ? DICT[sku] : ""),
    matched: o.matched !== undefined ? o.matched : enDict,
    matchType: o.matchType || (enDict ? "exacto" : ""),
    skuOriginal: o.skuOriginal || "",
    skuVenta: o.skuVenta || "",
    codigoML: o.codigoML || (enDict ? "ML" + sku.slice(-6) : ""),
  };
}

// ------------------------------------------------------------
// CASO 1 — Variante silenciosa del incidente TAL COMO LA EMITIO EL MODELO
// (V3): fila 4 partida en dos productos, valores corridos una fila desde ahi,
// Dobby omitido. El token danado TXV25QLBRD20 no matchea el diccionario.
// ------------------------------------------------------------
console.log("CASO 1 — incidente crudo (pre-arreglo del operador):");
{
  const productos = [
    linea("TXV24QLBRCN25", "Quilt Bruselas Canela 25P", 8, 9100),
    linea("TXV24QLBRMA15", "Quilt Bruselas Marron 15P", 8, 7000),
    linea("TXV25QLBRGR15", "Quilt Breda 15P Gris", 8, 7000),
    linea("TXV25QLBRD20", "Quilt Breda 20P Verde", 8, 8000, { nombreDict: "", matched: false }),
    linea("TXV25QLBRVD20", "Plumon VL Corduroy Sherpa 15P Crema", 4, 14000),
    linea("TXW26PMVC15CR", "Plumon VL Corduroy Sherpa 20P Azul", 8, 16000),
    linea("TXW26PMVC20AZ", "Plumon VL Corduroy Sherpa 25P Azul", 8, 18000),
    linea("TXW26PMVC25AZ", "Plumon VL Corduroy Sherpa 25P Terracota", 8, 18000),
    linea("TXW26PMVC25TE", "Quilt Sherpa VL Dobby 20P Azul", 4, 15000),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: OCR_546747 });
  check("bloquea (la variante que en produccion entro sin ruido)", res.bloqueos.length > 0, JSON.stringify(tipos(res)));
  check("descripcion_no_calza en la fantasma y las corridas (≥3 lineas)",
    res.bloqueos.filter(b => b.tipo === "descripcion_no_calza").length >= 3);
  check("corrimiento_vecino atrapa la linea 25AZ (misma talla, otro color)",
    res.bloqueos.some(b => b.tipo === "corrimiento_vecino" && b.sku === "TXW26PMVC25AZ"));
  check("codigo_sin_linea nombra al Dobby TXW26QLVD20AZ",
    res.bloqueos.some(b => b.tipo === "codigo_sin_linea" && b.codigo === "TXW26QLVD20AZ"));
}

// ------------------------------------------------------------
// CASO 2 — El MISMO estado despues de que el operador "arregla" la linea
// Sin ML asignandole Quilt Breda 20P Verde (lo que paso en produccion:
// nace el duplicado perfecto). Los candados deben seguir bloqueando.
// ------------------------------------------------------------
console.log("CASO 2 — incidente post-arreglo manual (estado que quedo en la DB):");
{
  const productos = [
    linea("TXV24QLBRCN25", "Quilt Bruselas Canela 25P", 8, 9100),
    linea("TXV24QLBRMA15", "Quilt Bruselas Marron 15P", 8, 7000),
    linea("TXV25QLBRGR15", "Quilt Breda 15P Gris", 8, 7000),
    linea("TXV25QLBRVD20", "Quilt Breda 20P Verde", 8, 8000, { matchType: "manual" }),
    linea("TXV25QLBRVD20", "Plumon VL Corduroy Sherpa 15P Crema", 4, 14000),
    linea("TXW26PMVC15CR", "Plumon VL Corduroy Sherpa 20P Azul", 8, 16000),
    linea("TXW26PMVC20AZ", "Plumon VL Corduroy Sherpa 25P Azul", 8, 18000),
    linea("TXW26PMVC25AZ", "Plumon VL Corduroy Sherpa 25P Terracota", 8, 18000),
    linea("TXW26PMVC25TE", "Quilt Sherpa VL Dobby 20P Azul", 4, 15000),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: OCR_546747 });
  check("duplicado_costo dispara (BRVD20 a $8.000 y $14.000)",
    res.bloqueos.some(b => b.tipo === "duplicado_costo" && b.sku === "TXV25QLBRVD20"));
  check("sigue nombrando al Dobby omitido",
    res.bloqueos.some(b => b.tipo === "codigo_sin_linea" && b.codigo === "TXW26QLVD20AZ"));
}

// ------------------------------------------------------------
// CASO 3 — Variante V2 (4/10 corridas): token danado a la vista pero DATOS
// CORRECTOS. Tras el arreglo manual legitimo (asignar Breda Verde) los datos
// quedan bien: los candados deben dejarla pasar (0 bloqueos).
// ------------------------------------------------------------
console.log("CASO 3 — variante con token danado y datos correctos (debe PASAR tras arreglo):");
{
  const productos = [
    linea("TXV24QLBRCN25", "Quilt Bruselas Canela 25P", 8, 9100),
    linea("TXV24QLBRMA15", "Quilt Bruselas Marron 15P", 8, 7000),
    linea("TXV25QLBRGR15", "Quilt Breda 15P Gris", 8, 7000),
    linea("TXV25QLBRVD20", "Quilt Breda 20P Verde", 8, 8000, { matchType: "manual", skuOriginal: "TXV25QLBRD20" }),
    linea("TXW26PMVC15CR", "Plumon VL Corduroy Sherpa 15P Crema", 4, 14000),
    linea("TXW26PMVC20AZ", "Plumon VL Corduroy Sherpa 20P Azul", 8, 16000),
    linea("TXW26PMVC25AZ", "Plumon VL Corduroy Sherpa 25P Azul", 8, 18000),
    linea("TXW26PMVC25TE", "Plumon VL Corduroy Sherpa 25P Terracota", 8, 18000),
    linea("TXW26QLVD20AZ", "Quilt Sherpa VL Dobby 20P Azul", 4, 15000),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: OCR_546747 });
  check("0 bloqueos (datos correctos pasan aunque el OCR venga feo)", res.bloqueos.length === 0,
    JSON.stringify(res.bloqueos.map(b => b.mensaje)));
}

// ------------------------------------------------------------
// CASO 4 — Variante derivada: el modelo emite el Dobby con cantidad 0
// (el prompt nuevo se lo pide para lineas ilegibles). Antes el filtro del
// insert lo botaba en silencio; ahora linea_descartable debe exigir accion.
// ------------------------------------------------------------
console.log("CASO 4 — linea ilegible con cantidad 0 (nada se bota en silencio):");
{
  const productos = [
    linea("TXV24QLBRCN25", "Quilt Bruselas Canela 25P", 8, 9100),
    linea("TXW26QLVD20AZ", "Quilt Sherpa VL Dobby 20P Azul", 0, 15000),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: "" });
  check("linea_descartable dispara para la cantidad 0",
    res.bloqueos.some(b => b.tipo === "linea_descartable"));
}

// ------------------------------------------------------------
// CASO 5 — Falsos positivos: duplicado LEGITIMO del folio 546297
// (mismo SKU dos veces al MISMO costo) debe pasar.
// ------------------------------------------------------------
console.log("CASO 5 — duplicado legitimo mismo costo (546297, debe PASAR):");
{
  const productos = [
    linea("ALPCMPRLV4060", "Limpiapies Coco Lavanda 40 x 60", 19, 3400, { nombreDict: "Limpiapies Coco 40 x 60 Lavanda", matched: true }),
    linea("ALPCMPRLV4060", "Limpiapies Coco Lavanda 40 x 60", 5, 3400, { nombreDict: "Limpiapies Coco 40 x 60 Lavanda", matched: true }),
    linea("ALPCMPRKZ4060", "Limpiapies Coco Kazan 40 x 60", 70, 3400, { nombreDict: "Limpiapies Coco 40 x 60 Kazan", matched: true }),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: "ALPCMPRLV4060 ALPCMPRLV4060\nALPCMPRKZ4060 ALPCMPRKZ4060" });
  check("0 bloqueos", res.bloqueos.length === 0, JSON.stringify(res.bloqueos.map(b => b.mensaje)));
}

// ------------------------------------------------------------
// CASO 6 — Falsos positivos del cruce de descripcion (casos reales sanos):
// nombre de catalogo distinto cosmeticamente, orden de palabras cambiado,
// catalogo sin token de talla, y proveedor sin catalogo (ISBN).
// ------------------------------------------------------------
console.log("CASO 6 — discrepancias cosmeticas reales (deben PASAR):");
{
  const productos = [
    linea("TXV23QLRM15OV", "Quilt MF Roma 15P Olivo", 8, 6500, { nombreDict: "Quilt Roma 15P Olive", matched: true }),
    linea("AJTND060090BG", "Jute Nordic 60 x 90 Beige", 5, 6000, { nombreDict: "Jute 60 x 90 Nordic Beige", matched: true }),
    linea("TXV24QLBRBS01", "Quilt Bruselas Bars Single 15P", 4, 7000, { nombreDict: "Quilt Bruselas Bars Single", matched: true }),
    linea("9788471511348", "EL LIBRO DE LA SELVA", 50, 11118, { nombreDict: "", matched: false }),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: "" });
  check("0 bloqueos", res.bloqueos.length === 0, JSON.stringify(res.bloqueos.map(b => b.mensaje)));
}

// ------------------------------------------------------------
// CASO 7 — El diff de codigos tolera los tokens danados por pliegue/borde
// (gemelos con ≤2 caracteres comidos, caso real 546746) y se calla en
// plantillas sin codigos alfanumericos (ISBN puro digitos, caso 10540).
// ------------------------------------------------------------
console.log("CASO 7 — tolerancia del diff de codigos (sanas, deben PASAR):");
{
  const productos546746 = [
    linea("JSAFAB436P20W", "Jgo Sabanas AF 144H 50%Alg Campine 2.0 W26", 8, 12000, { nombreDict: "Jgo Sabanas AF 144H 50%Alg Campine 2.0 W26", matched: true }),
    linea("LCSBAF144CH20", "Sabana AFamily 144H Chrome 20P", 4, 12000, { nombreDict: "Sabana AFamily 144H Chrome 20P", matched: true }),
  ];
  const resA = Locks.evaluarCandados({
    productos: productos546746,
    // gemelo con la J comida (USAFAB...) y fila partida en dos renglones — real de la 546746
    ocrText: "USAFAB436P20W\nJSAFAB436P20W\nLCSBAF144CH20 LCSBAF144CH20",
  });
  check("gemelo danado ≤2 ediciones no alarma", resA.bloqueos.length === 0, JSON.stringify(resA.bloqueos.map(b => b.mensaje)));

  const resB = Locks.evaluarCandados({
    productos: [linea("9788471511348", "LIBRO", 50, 11118, { nombreDict: "", matched: false })],
    ocrText: "9788471511348\n9788481693232\nEMPRESA PERIODISTICA MUNDO LTDA\nFACTURA ELECTRONICA",
  });
  check("plantilla ISBN (sin codigos alfanumericos) no alarma", resB.bloqueos.length === 0, JSON.stringify(resB.bloqueos.map(b => b.mensaje)));
}

// ------------------------------------------------------------
// CASO 8 — Falsos positivos DETERMINISTAS medidos en el corpus (544565 y
// 545703): el token entero "x2" vs "x 2" del catalogo, y la factura que
// imprime la medida ("50x70") cuando el catalogo la guarda en otra columna.
// Con la comparacion por corridas de digitos + subconjunto deben PASAR.
// ------------------------------------------------------------
console.log("CASO 8 — tokenizacion x2 / 50x70 (FPs reales, deben PASAR):");
{
  const productos = [
    linea("TX2PKALMPRIBV", "Pack almohadas BANVA x2", 150, 6900, { nombreDict: "Pack almohadas BANVA x 2", matched: true }),
    linea("TX2ALMPL15507", "Pack Almohada Illusions 15% plumas de ganso 50x70", 12, 10000, { nombreDict: "Pack Almohada Illusions 15% plumas de ganso", matched: true }),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: "" });
  check("0 bloqueos", res.bloqueos.length === 0, JSON.stringify(res.bloqueos.map(b => b.mensaje)));
  // Y el caso que SI es corrimiento (talla distinta) sigue disparando:
  const res2 = Locks.evaluarCandados({ productos: [
    linea("TXW26PMVC15CR", "Plumon VL Corduroy Sherpa 20P Azul", 8, 16000),
  ], ocrText: "" });
  check("talla distinta sigue disparando", res2.bloqueos.some(b => b.tipo === "descripcion_no_calza"));
}

// ------------------------------------------------------------
// CASO 9 — Arbitro de catalogo en el diff de codigos: el 80% de los SKUs del
// catalogo tiene un hermano a distancia ≤2. Si la factura trae el token del
// hermano (25TE) y la linea solo tiene 25AZ, ANTES se daba por cubierto y la
// linea omitida pasaba callada. Con el catalogo como arbitro debe disparar.
// El token danado por pliegue (dist 1 de SU linea) debe seguir cubierto.
// ------------------------------------------------------------
console.log("CASO 9 — hermano omitido vs token danado (con catalogo):");
{
  const catalogo = Object.keys(DICT);
  const soloAzul = [linea("TXW26PMVC25AZ", "Plumon VL Corduroy Sherpa 25P Azul", 8, 18000)];
  const resOmitido = Locks.evaluarCandados({
    productos: soloAzul,
    ocrText: "XW26PMVC25AZ TXW26PMVC25AZ\nXW26PMVC25TE TXW26PMVC25TE",
    skusCatalogo: catalogo,
  });
  check("hermano omitido (25TE en OCR, sin linea) dispara",
    resOmitido.bloqueos.some(b => b.tipo === "codigo_sin_linea" && b.codigo === "TXW26PMVC25TE"));
  const resDanado = Locks.evaluarCandados({
    productos: [linea("TXV25QLBRVD20", "Quilt Breda 20P Verde", 8, 8000)],
    ocrText: "TXV25QLBRD20\nTXV25QLBRVD20",
    skusCatalogo: catalogo.concat(["TXV25QLBRVD15"]),
  });
  check("token danado (dist 1 de su linea) sigue cubierto", resDanado.bloqueos.length === 0,
    JSON.stringify(resDanado.bloqueos.map(b => b.mensaje)));
}

// ------------------------------------------------------------
// CASO 10 — Una linea con cantidad 0 genera SOLO linea_descartable (clase
// accion), sin el duplicado_costo redundante que la contradecia (corrida #10
// del test de loteria: mismo SKU con 8@8000 y 0@0).
// ------------------------------------------------------------
console.log("CASO 10 — cantidad 0: una sola alarma, clase accion:");
{
  const productos = [
    linea("TXV25QLBRVD20", "Quilt Breda 20P Verde", 8, 8000),
    linea("TXV25QLBRVD20", "Quilt Breda 20P Verde (ilegible)", 0, 0),
  ];
  const res = Locks.evaluarCandados({ productos, ocrText: "" });
  check("solo linea_descartable", tipos(res).join(",") === "linea_descartable", JSON.stringify(tipos(res)));
  check("clase accion (no re-escanear)", res.accion.length === 1 && res.reescanear.length === 0);
}

// ------------------------------------------------------------
// CASO 11 — El OCR COMPLETO real de la 546747 (encabezado con RUTs, direccion,
// O.Compra OVT_/FVTA_, pie con timbre SII y www) no genera candidatos falsos
// en el diff de codigos cuando las lineas estan correctas.
// ------------------------------------------------------------
console.log("CASO 11 — OCR completo real: encabezado/pie sin falsos candidatos:");
{
  const OCR_COMPLETO = `idetex..
IDETEX S.A.
VENTA DE PRODUCTOS TEXTILES Y OTROS PARA
EL HOGAR
CASA MATRIZ: JUAN DE LA FUENTE 353, BODEGA F, LAMPA
SANTIAGO
Fecha de Emisión :11 de Agosto de 2026
Razón Social: BANVA SPA
Dirección: Los militares 5934 Las Condes Santiago CHILE
Giro: Venta al por menor por internet
Fono:
Vendedor: IDETEX
R.U.T.: 76.676.820-2
FACTURA ELECTRÓNICA
O.Compra: OVT_00482920/FVTA_00436068
Transporte:
N° 546747
S.I.I. SANTIAGO PONIENTE
R.U.T: 77.994.007-1
Ciudad: Santiago
Comuna: Las Condes
Docs. Previos:
Cond.Pago: 60
F.1er.Venc: 10/10/2026
POR LO SIGUIENTE:
Cod.Alter.
TXV24QLBRCN25 TXV24QLBRCN25
TXV24QLBRMA15 TXV24QLBRMA15
TXV25QLBRGR15 TXV25QLBRGR15
TXV25QLBRD20
TXV25QLBRVD20
XW26PMVC5CR TXW26PMVC15CR
XW26PMVC20AZ TXW26PMVC20AZ
XW26PMVC25AZ TXW26PMVC25AZ
XW26PMVC25TE TXW26PMVC25TE
TXW26QLVD20AZ TXW26QLVD20AZ
DEBE
A: Idetex
Código
Unid.
Descripción del Producto
Precio U.
Descto.
Valor Total
8
Quilt Bruselas Canela 25P
9.100
72.800
8
Quilt Bruselas Marron 15P
7.000
56.000
8
7.000
56.000
Quilt Breda 15P Gris
8
8.000
64.000
Quilt Breda 20P Verde
4
Plumon VL Corduroy Sherpa 15P Crema
14.000
56.000
8
Plumon VL Corduroy Sherpa 20P Azul
16.000
128.000
8
Plumon VL Corduroy Sherpa 25P Azul
18.000
144.000
8
4
Plumon VL Corduroy Sherpa 25P Terracota
Quilt Sherpa VL Dobby 20P Azul
18.000
144.000
15.000
60.000
Total Unidades: 64
SON: Novecientos Veintinueve Mil Ciento Cincuenta y Dos Pesos
NETO $
780.800
Exento $
0
19% I.V.A.
148.352
TOTAL $
929.152
DOCUMENTO(S) DE REFERENCIA
Orden de Compra N° 048/11-AGO-2026
Timbre Electrónico SII
Res. 80 del 2014
Verifique documento: www.sil.cl
Solución de Factura Electrónica de: www.acepta.com`;
  const productosOk = [
    linea("TXV24QLBRCN25", "Quilt Bruselas Canela 25P", 8, 9100),
    linea("TXV24QLBRMA15", "Quilt Bruselas Marron 15P", 8, 7000),
    linea("TXV25QLBRGR15", "Quilt Breda 15P Gris", 8, 7000),
    linea("TXV25QLBRVD20", "Quilt Breda 20P Verde", 8, 8000),
    linea("TXW26PMVC15CR", "Plumon VL Corduroy Sherpa 15P Crema", 4, 14000),
    linea("TXW26PMVC20AZ", "Plumon VL Corduroy Sherpa 20P Azul", 8, 16000),
    linea("TXW26PMVC25AZ", "Plumon VL Corduroy Sherpa 25P Azul", 8, 18000),
    linea("TXW26PMVC25TE", "Plumon VL Corduroy Sherpa 25P Terracota", 8, 18000),
    linea("TXW26QLVD20AZ", "Quilt Sherpa VL Dobby 20P Azul", 4, 15000),
  ];
  const res = Locks.evaluarCandados({ productos: productosOk, ocrText: OCR_COMPLETO, skusCatalogo: Object.keys(DICT) });
  check("extraccion correcta + OCR completo = 0 bloqueos", res.bloqueos.length === 0,
    JSON.stringify(res.bloqueos.map(b => b.mensaje)));
}

// ------------------------------------------------------------
console.log("");
if (fallas > 0) { console.log("RESULTADO: " + fallas + " test(s) FALLARON"); process.exit(1); }
console.log("RESULTADO: todos los tests pasan");
