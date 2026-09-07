// ============================================================
// BANVA — Cuadre de la extracción contra el neto de la factura (puro)
// ============================================================
// La estructuración con Claude sobre el texto OCR NO es determinista: con el
// MISMO texto (factura 548981, 04-sep-2026, 2.460 chars) una corrida devolvio
// las 19 lineas perfectas y otra corrio cantidades y costos una fila (Shaggy D7
// con 10 x 4.300 en vez de 3 x 28.000 → suma $2.023.000 vs neto $1.869.000).
// El frontend ya bloquea el envio cuando la suma no calza con el neto, pero
// recien al final: el operador veia lineas "mal leidas" sin saber cual.
// Esta funcion decide si una extraccion cuadra, para que el servidor pueda
// reintentar ANTES de mostrarla. Pura (sin red) para testear en node:
//   node tools/test-cuadre.js
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BanvaCuadre = api;
})(typeof window !== "undefined" ? window : null, function () {

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Devuelve { evaluable, cuadra, suma, neto, unidades, delta,
  //            unidadesDeclaradas, cuadraUnidades }.
  // - evaluable=false cuando no hay neto (>0) o no hay productos: no se puede
  //   afirmar nada, y NO se reintenta a ciegas (Regla 1: null no es "no cuadra").
  // - cuadra = suma de cantidad x costo_unitario igual al neto, al peso.
  // - cuadraUnidades = suma de cantidades igual al "Total Unidades" IMPRESO en
  //   la factura (parsed.total_unidades, transcrito por el modelo). Es el unico
  //   control que no es de plata; null cuando la factura no lo declara — un
  //   "no declarado" jamas se lee como "no cuadra" (Regla 1).
  function evaluarCuadre(parsed) {
    const productos = Array.isArray(parsed && parsed.productos) ? parsed.productos : [];
    const neto = num(parsed && parsed.costo_neto);
    const declaradas = num(parsed && parsed.total_unidades);
    let suma = 0;
    let unidades = 0;
    productos.forEach(function (p) {
      const c = num(p && p.cantidad);
      suma += c * num(p && p.costo_unitario);
      unidades += c;
    });
    const evaluable = neto > 0 && productos.length > 0;
    const unidadesDeclaradas = declaradas > 0 ? declaradas : null;
    return {
      evaluable: evaluable,
      cuadra: evaluable ? suma === neto : null,
      suma: suma,
      neto: neto,
      unidades: unidades,
      delta: suma - neto,
      unidadesDeclaradas: unidadesDeclaradas,
      cuadraUnidades: unidadesDeclaradas !== null && productos.length > 0
        ? unidades === unidadesDeclaradas
        : null,
    };
  }

  // Reparacion DETERMINISTA por linea, con lo que el OCR si lee bien.
  // Medido (548981, 04-sep-2026): Vision pierde las cantidades de UN digito
  // (3, 5) pero lee bien precios y "Valor Total" de cada fila (los 19 totales
  // presentes en el texto). Si cantidad x costo != valor_total y valor_total es
  // multiplo exacto del costo, la cantidad correcta es valor_total / costo.
  // No toca lineas sin total, sin costo, o cuya division no da entero (ahi no
  // hay certeza y se deja al cuadre global / al operador). Devuelve una copia.
  function repararCantidades(parsed) {
    const productos = Array.isArray(parsed && parsed.productos) ? parsed.productos : [];
    const detalle = [];
    const nuevos = productos.map(function (p) {
      if (!p) return p;
      const cantidad = num(p.cantidad);
      const costo = num(p.costo_unitario);
      const total = num(p.valor_total);
      if (costo <= 0 || total <= 0) return p;
      if (cantidad * costo === total) return p;
      if (total % costo !== 0) return p;
      const corregida = total / costo;
      detalle.push({ sku: p.sku, antes: cantidad, despues: corregida, costo: costo, valor_total: total });
      return Object.assign({}, p, { cantidad: corregida, cantidad_reparada: true });
    });
    return {
      parsed: Object.assign({}, parsed, { productos: nuevos }),
      reparadas: detalle.length,
      detalle: detalle,
    };
  }

  // Consenso entre DOS extracciones independientes de la MISMA factura.
  // Origen: factura 549298 (07-sep-2026) — cantidades PERMUTADAS entre lineas
  // del mismo precio unitario. Cada linea cuadraba con su Valor Total y la
  // suma daba el neto exacto: NINGUN control de plata puede ver esa clase de
  // error (una permutacion conserva todas las sumas). La estructuracion no es
  // determinista y no falla igual dos veces (medido: tres corridas de la misma
  // foto → tres asignaciones distintas), asi que dos corridas que COINCIDEN en
  // una linea son evidencia fuerte; una linea en la que difieren se marca para
  // que el operador la coteje contra el papel.
  // Pura: compara por SKU normalizado y devuelve
  //   { evaluable, coinciden, discrepancias:[{sku,cantidadA,cantidadB,costoA,costoB}],
  //     soloA:[], soloB:[], duplicadosA:[], duplicadosB:[] }
  // Un SKU duplicado en un lado NO se compara linea a linea (no hay forma de
  // saber cual contra cual): se declara en duplicados* y decide el candado A.
  function normSku(s) { return (s == null ? "" : String(s)).toUpperCase().trim(); }

  function indexarPorSku(parsed) {
    const productos = Array.isArray(parsed && parsed.productos) ? parsed.productos : [];
    const porSku = {};
    productos.forEach(function (p) {
      const sku = normSku(p && p.sku);
      if (!sku) return;
      (porSku[sku] = porSku[sku] || []).push({ cantidad: num(p.cantidad), costo: num(p.costo_unitario) });
    });
    return { porSku: porSku, total: productos.length };
  }

  function compararProductos(a, b) {
    const ia = indexarPorSku(a);
    const ib = indexarPorSku(b);
    const evaluable = ia.total > 0 && ib.total > 0;
    const out = {
      evaluable: evaluable,
      coinciden: 0,
      discrepancias: [],
      soloA: [],
      soloB: [],
      duplicadosA: Object.keys(ia.porSku).filter(function (s) { return ia.porSku[s].length > 1; }).sort(),
      duplicadosB: Object.keys(ib.porSku).filter(function (s) { return ib.porSku[s].length > 1; }).sort(),
    };
    if (!evaluable) return out;
    const dupA = new Set(out.duplicadosA);
    const dupB = new Set(out.duplicadosB);
    Object.keys(ia.porSku).sort().forEach(function (sku) {
      if (!ib.porSku[sku]) { out.soloA.push(sku); return; }
      if (dupA.has(sku) || dupB.has(sku)) return; // lo declara duplicados*, no se compara a ciegas
      const la = ia.porSku[sku][0];
      const lb = ib.porSku[sku][0];
      if (la.cantidad === lb.cantidad && la.costo === lb.costo) { out.coinciden++; return; }
      out.discrepancias.push({
        sku: sku,
        cantidadA: la.cantidad, cantidadB: lb.cantidad,
        costoA: la.costo, costoB: lb.costo,
      });
    });
    Object.keys(ib.porSku).sort().forEach(function (sku) {
      if (!ia.porSku[sku]) out.soloB.push(sku);
    });
    return out;
  }

  return { evaluarCuadre: evaluarCuadre, repararCantidades: repararCantidades, compararProductos: compararProductos };
});
