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

  // Devuelve { evaluable, cuadra, suma, neto, unidades, delta }.
  // - evaluable=false cuando no hay neto (>0) o no hay productos: no se puede
  //   afirmar nada, y NO se reintenta a ciegas (Regla 1: null no es "no cuadra").
  // - cuadra = suma de cantidad x costo_unitario igual al neto, al peso.
  function evaluarCuadre(parsed) {
    const productos = Array.isArray(parsed && parsed.productos) ? parsed.productos : [];
    const neto = num(parsed && parsed.costo_neto);
    let suma = 0;
    let unidades = 0;
    productos.forEach(function (p) {
      const c = num(p && p.cantidad);
      suma += c * num(p && p.costo_unitario);
      unidades += c;
    });
    const evaluable = neto > 0 && productos.length > 0;
    return {
      evaluable: evaluable,
      cuadra: evaluable ? suma === neto : null,
      suma: suma,
      neto: neto,
      unidades: unidades,
      delta: suma - neto,
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

  return { evaluarCuadre: evaluarCuadre, repararCantidades: repararCantidades };
});
