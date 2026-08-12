// ============================================================
// BANVA — Candados de integridad del escaneo (PR candados-envio)
// ============================================================
// Origen: incidente factura 546747 (11-ago-2026). Un pliegue en el papel hizo
// que Vision partiera una fila de codigos en dos renglones; el modelo empareja
// por posicion y TODO lo posterior quedo corrido una fila: nacio una linea
// fantasma (SKU duplicado con costo ajeno), 4 lineas quedaron con cantidades/
// costos de la fila siguiente y el ultimo SKU de la factura desaparecio.
// El cuadre global no lo vio: un corrimiento es una permutacion y conserva la
// suma exacta ($780.800 = neto). La linea danada aparecio "Sin ML" y el
// operador la "arreglo" a mano asignandole un producto — fabricando el
// duplicado perfecto. Auditado por 3 verificadores independientes; estas
// funciones implementan las defensas que SI disparan, en la forma exacta en
// que disparan (ver condiciones en cada una).
//
// Este archivo es puro (sin React, sin DOM) para poder testearlo en node:
//   node tools/test-candados.js
// En el browser queda como window.BanvaLocks.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BanvaLocks = api;
})(typeof window !== "undefined" ? window : null, function () {

  function normSku(s) { return (s == null ? "" : String(s)).toUpperCase().trim(); }

  function normTexto(s) {
    const base = (s == null ? "" : String(s)).toLowerCase();
    let t;
    try { t = base.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) { t = base; }
    return t.replace(/[^a-z0-9]+/g, " ").trim();
  }

  function tokens(s) { return normTexto(s).split(/\s+/).filter(Boolean); }

  // Tokens que llevan digitos, con ceros a la izquierda normalizados ("050"→"50").
  // Son los discriminantes de talla/medida ("15p", "20p", "45", "75", "144h").
  // La comparacion difusa NO sirve aca: "Sherpa 20P Azul" vs "Sherpa 25P Azul"
  // da 0.97 de similitud y es justo el corrimiento que hay que atrapar.
  function numTokens(s) {
    return tokens(s)
      .filter(function (t) { return /\d/.test(t); })
      .map(function (t) { return t.replace(/^0+(?=\d)/, ""); })
      .sort();
  }

  function mismosNumTokens(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function jaccard(aArr, bArr) {
    const a = new Set(aArr), b = new Set(bArr);
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function levenshtein(a, b, cap) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    let prev = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > cap) return cap + 1; // poda: ya no puede bajar del cap
      prev = cur;
    }
    return prev[b.length];
  }

  const fmtCLP = function (n) { return "$" + Math.round(Number(n) || 0).toLocaleString("es-CL"); };

  // ------------------------------------------------------------
  // Candado A — SKU repetido con costos unitarios distintos.
  // El duplicado del incidente NO viene en el JSON del modelo (trae dos strings
  // distintos); nace cuando el operador repara la linea "Sin ML" a mano. Por eso
  // este chequeo SOLO sirve evaluado sobre el estado vivo al momento de enviar/
  // imprimir — nunca como snapshot del enriquecimiento.
  // El duplicado legitimo (misma factura trae el SKU dos veces al MISMO costo,
  // ej. folio 546297) pasa sin ruido. Unico costo historico distinto en 204
  // recepciones: el incidente.
  // ------------------------------------------------------------
  function checkDuplicados(productos) {
    const porSku = {};
    (productos || []).forEach(function (p, idx) {
      const sku = normSku(p.sku);
      if (!sku) return;
      (porSku[sku] = porSku[sku] || []).push({ idx: idx, costo: Number(p.costo) || 0, cantidad: Number(p.cantidad) || 0 });
    });
    const out = [];
    Object.keys(porSku).forEach(function (sku) {
      const filas = porSku[sku];
      if (filas.length < 2) return;
      const costos = Array.from(new Set(filas.map(function (f) { return f.costo; })));
      if (costos.length > 1) {
        out.push({
          tipo: "duplicado_costo",
          sku: sku,
          idxs: filas.map(function (f) { return f.idx; }),
          mensaje: sku + " aparece " + filas.length + " veces con costos distintos (" +
            filas.map(function (f) { return f.cantidad + " un. a " + fmtCLP(f.costo); }).join(" y ") +
            "). La factura real trae una sola linea por SKU-costo: es sintoma de lectura corrida.",
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------
  // Candado E1 — la descripcion que acompanaba al SKU en la factura no calza
  // con el nombre de catalogo del SKU asignado. Compara SOLO los tokens con
  // digitos (talla/medida): es lo que distingue "Sherpa 20P Azul" de "25P Azul"
  // sin marcar diferencias cosmeticas ("Quilt MF Roma 15P Olivo" vs
  // "Quilt Roma 15P Olive" comparte {15p} y pasa). Si alguno de los dos lados
  // no tiene tokens numericos, se calla (catalogo sin talla, descripcion
  // truncada): mejor un falso negativo puntual que ruido que ensene a ignorar.
  // ------------------------------------------------------------
  function checkDescripcionVsSku(productos) {
    const out = [];
    (productos || []).forEach(function (p, idx) {
      if (!p || !p.nombre || !p.nombreDict) return;
      const nf = numTokens(p.nombre);
      const nd = numTokens(p.nombreDict);
      if (nf.length === 0 || nd.length === 0) return;
      if (!mismosNumTokens(nf, nd)) {
        out.push({
          tipo: "descripcion_no_calza",
          idx: idx,
          sku: normSku(p.sku),
          mensaje: "La linea " + (idx + 1) + " (" + normSku(p.sku) + " · " + p.nombreDict + ") viene de la factura como \"" +
            p.nombre + "\" — la talla/medida no calza. Sintoma de filas corridas.",
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------
  // Candado E2 — detector de corrimiento por vecindad: la descripcion de
  // factura de la linea i se parece MAS al nombre de catalogo de la linea
  // vecina (i±1) que al propio. Atrapa el caso que E1 no ve: misma talla,
  // distinto color ("...25P Terracota" pegado al SKU "...25P Azul").
  // Medido sobre el corpus real: 5 hits en la factura corrida, 0 en 18 sanas.
  // ------------------------------------------------------------
  function checkCorrimientoVecino(productos) {
    const out = [];
    const arr = productos || [];
    arr.forEach(function (p, i) {
      if (!p || !p.nombre) return;
      const propio = jaccard(tokens(p.nombre), tokens(p.nombreDict || ""));
      [i - 1, i + 1].forEach(function (j) {
        if (j < 0 || j >= arr.length) return;
        const vecino = arr[j];
        if (!vecino || !vecino.nombreDict) return;
        if (normTexto(vecino.nombreDict) === normTexto(p.nombreDict || "")) return; // mismo producto, nada que decir
        const simVecino = jaccard(tokens(p.nombre), tokens(vecino.nombreDict));
        if (simVecino >= 0.8 && simVecino > propio) {
          out.push({
            tipo: "corrimiento_vecino",
            idx: i,
            sku: normSku(p.sku),
            mensaje: "La descripcion de la linea " + (i + 1) + " (\"" + p.nombre + "\") corresponde al producto de la linea " +
              (j + 1) + " (" + vecino.nombreDict + "). Las filas estan corridas.",
          });
        }
      });
    });
    return out;
  }

  // ------------------------------------------------------------
  // Candado B' — todo codigo impreso en la factura debe tener linea.
  // Reemplaza al conteo de renglones (74-83% de falsas alarmas medidas): en vez
  // de contar, exige que cada token con forma de codigo del texto OCR este
  // representado en las lineas a enviar (distancia de edicion ≤2 absorbe los
  // caracteres que el pliegue/borde se come: "XW26PMVC5CR"→TXW26PMVC15CR).
  // En el incidente: TXW26QLVD20AZ estaba DOS veces en el OCR y en ninguna
  // linea → dispara con nombre y apellido. En plantillas sin codigos
  // alfanumericos (proveedor de libros, ISBN puro-digitos) no hay candidatos y
  // el candado se calla solo.
  // ------------------------------------------------------------
  function checkCodigosFactura(ocrText, productos) {
    if (!ocrText) return [];
    const candidatos = new Set();
    String(ocrText).toUpperCase().split(/[^A-Z0-9]+/).forEach(function (t) {
      if (t.length < 8 || t.length > 20) return;
      if (!/^[A-Z]/.test(t)) return;
      const letras = (t.match(/[A-Z]/g) || []).length;
      const digitos = (t.match(/[0-9]/g) || []).length;
      if (letras < 3 || digitos < 2) return;
      candidatos.add(t);
    });
    const skusLinea = [];
    (productos || []).forEach(function (p) {
      if (!p) return;
      const s = normSku(p.sku); if (s) skusLinea.push(s);
      const sv = normSku(p.skuVenta); if (sv) skusLinea.push(sv);
      const so = normSku(p.skuOriginal); if (so) skusLinea.push(so);
    });
    const out = [];
    candidatos.forEach(function (cod) {
      let cubierto = false;
      for (const s of skusLinea) {
        if (levenshtein(cod, s, 2) <= 2) { cubierto = true; break; }
      }
      if (!cubierto) {
        out.push({
          tipo: "codigo_sin_linea",
          codigo: cod,
          mensaje: "El codigo " + cod + " aparece impreso en la factura pero ninguna linea lo tiene. Falta un producto (o quedo pegado a otra linea).",
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------
  // Candado D — nada se descarta en silencio. El filtro del insert bota las
  // lineas sin SKU o con cantidad 0; aca se exige que el operador las complete
  // o las elimine EL, con el dedo, antes de enviar. (El prompt ahora pide al
  // modelo entregar las lineas ilegibles con cantidad 0 en vez de omitirlas:
  // este candado es quien las hace visibles.)
  // ------------------------------------------------------------
  function checkDescartes(productos) {
    const out = [];
    (productos || []).forEach(function (p, idx) {
      if (!p) return;
      const sinSku = !normSku(p.sku);
      const sinCantidad = !(Number(p.cantidad) > 0);
      if (sinSku || sinCantidad) {
        out.push({
          tipo: "linea_descartable",
          idx: idx,
          mensaje: "La linea " + (idx + 1) + (p.nombre ? " (\"" + p.nombre + "\")" : "") +
            (sinSku ? " no tiene SKU" : " tiene cantidad 0") +
            " y NO se enviaria al WMS. Completala o eliminala con ✕ — nada se bota en silencio.",
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------
  // Evaluacion completa. Devuelve bloqueos (impiden imprimir y enviar) con
  // mensajes listos para mostrar. Debe llamarse sobre el estado VIVO
  // (extractedProducts post-edicion) — nunca sobre un snapshot del escaneo.
  // ------------------------------------------------------------
  function evaluarCandados(input) {
    const productos = (input && input.productos) || [];
    const ocrText = (input && input.ocrText) || "";
    const bloqueos = [];

    checkDuplicados(productos).forEach(function (v) { bloqueos.push(v); });

    const e1 = checkDescripcionVsSku(productos);
    e1.forEach(function (v) { bloqueos.push(v); });
    const idxE1 = new Set(e1.map(function (v) { return v.idx; }));
    checkCorrimientoVecino(productos).forEach(function (v) {
      if (!idxE1.has(v.idx)) bloqueos.push(v); // una alarma por linea basta
    });

    checkCodigosFactura(ocrText, productos).forEach(function (v) { bloqueos.push(v); });
    checkDescartes(productos).forEach(function (v) { bloqueos.push(v); });

    return { bloqueos: bloqueos };
  }

  return {
    evaluarCandados: evaluarCandados,
    checkDuplicados: checkDuplicados,
    checkDescripcionVsSku: checkDescripcionVsSku,
    checkCorrimientoVecino: checkCorrimientoVecino,
    checkCodigosFactura: checkCodigosFactura,
    checkDescartes: checkDescartes,
    _internos: { numTokens: numTokens, tokens: tokens, jaccard: jaccard, levenshtein: levenshtein },
  };
});
