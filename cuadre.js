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

  return { evaluarCuadre: evaluarCuadre };
});
