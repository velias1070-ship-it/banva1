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

  // ---- Descuento al pie de la factura (Chantilly, folio 266248, 24-sep-2026) ----
  // Algunos proveedores imprimen las lineas a PRECIO DE LISTA y restan un
  // descuento global al pie ("Descuento 137,656" → "Monto Neto 1,238,904").
  // Sin esto la suma de lineas nunca da el neto y la factura quedaba bloqueada
  // aunque se hubiera leido perfecta.
  //
  // Tres reglas para que el descuento NO pueda tapar una lectura mala:
  // 1. descuentoAlPieRespaldado: el monto tiene que estar IMPRESO JUNTO a la
  //    palabra "Descuento" (no "Desc." de columna): en la misma linea o en las
  //    2 siguientes del texto OCR, sin contar porcentajes ("10%"). Si no, vale
  //    0. Nunca se deduce. (Revision del PR: aceptar CUALQUIER numero del texto
  //    dejaba que un precio unitario tapara una cantidad sobreleida.)
  // 2. descuentoAplicable: el descuento solo se usa si la factura NO cuadra
  //    directo y SI cuadra restandolo (dentro de la tolerancia). Una factura
  //    que hoy cuadra sigue cuadrando igual: el descuento no cambia nada ahi.
  // 3. descuentoCalzaConPct (sólo frontend, que conoce al proveedor): el
  //    proveedor tiene que tener descuento_comercial_pct en banvabodega y el
  //    monto tiene que ser ese % de la suma de lineas. Con eso una linea mal
  //    leida no puede cuadrar: cambia la suma, cambia el % esperado, y el
  //    descuento impreso deja de calzar. Tambien asegura que el trigger 0318
  //    de banvabodega lleve cada linea a su precio real (sin % no lo haria).
  // 4. El resto de los controles (unidades, consenso, candados) no se toca.
  // Medido en prod 25-sep-2026 sobre recepciones created_by='App Etiquetas'
  // con factura_original.ocr_text (69, desde 12-ago-2026): 0 traen la palabra
  // "descuento" (control positivo: 65 traen "descripci"). Ninguna factura
  // escaneada hasta hoy tenia descuento al pie.
  function descuentoAlPieRespaldado(ocrText, monto) {
    const m = num(monto);
    if (!(m > 0) || !ocrText) return false;
    const lineas = String(ocrText).split(/\n/);
    const palabra = /(^|[^a-z])descuento([^a-z]|$)/i;
    // Numero con separador de miles chileno o ingles; el lookahead descarta
    // porcentajes ("10%", "10 %"). Decimales ",00" no cuentan como miles.
    const reNum = /\d{1,3}(?:[.,]\d{3})+(?![\d%])(?!\s*%)|\d+(?![\d%.,])(?!\s*%)/g;
    for (let i = 0; i < lineas.length; i++) {
      const hit = palabra.exec(lineas[i]);
      if (!hit) continue;
      const resto = lineas[i].slice(hit.index + hit[0].length);
      // Modo columna: «Descuento» solo en su linea y seguido de otro rotulo.
      // Ahi la ventana de 2 lineas no sirve (tomaria el monto de otro rotulo)
      // y manda el emparejamiento por posicion de mas abajo.
      const modoColumna = sinNumero(resto) && i + 1 < lineas.length &&
        lineas[i + 1].trim() !== "" && sinNumero(lineas[i + 1]);
      const ventana = modoColumna ? "" : [resto]
        .concat(lineas.slice(i + 1, i + 3)).join("\n");
      const numeros = ventana.match(reNum) || [];
      if (numeros.some(function (t) { return Number(t.replace(/[.,]/g, "")) === m; })) return true;
      // Rotulos en columna: Vision a veces lista todos los rotulos del pie y
      // DESPUES todos los montos ("Descuento / Monto Neto / IVA (19%) / Total /
      // 21,552 / 193,968 / ..."; factura 266247, 25-sep-2026). Ahi el monto del
      // descuento es el que ocupa, en el bloque de montos, la MISMA posicion que
      // «Descuento» en el bloque de rotulos. Rotulo = linea sin ningun numero
      // (un porcentaje no cuenta); monto = linea que es solo un numero.
      if (!modoColumna) continue;
      let ini = i;
      while (ini > 0 && sinNumero(lineas[ini - 1]) && lineas[ini - 1].trim()) ini--;
      let fin = i + 1;
      while (fin < lineas.length && sinNumero(lineas[fin])) fin++;
      const k = i - ini;
      let n = 0;
      for (let j = fin; j < lineas.length; j++) {
        const v = soloMonto(lineas[j]);
        if (v === null) break;
        if (n === k) { if (v === m) return true; break; }
        n++;
      }
    }
    return false;

    function sinNumero(l) { reNum.lastIndex = 0; return !reNum.test(l); }
    function soloMonto(l) {
      const t = String(l).trim().replace(/^\$\s*/, "");
      return /^(\d{1,3}(?:[.,]\d{3})+|\d+)$/.test(t) ? Number(t.replace(/[.,]/g, "")) : null;
    }
  }

  // El descuento tiene que ser el % comercial del proveedor sobre la suma de
  // lineas a lista. Tolerancia: 1 peso por linea (el proveedor puede redondear
  // el descuento linea a linea). pct null/0 = proveedor sin descuento → false.
  function descuentoCalzaConPct(suma, descuento, pct, nLineas) {
    const d = num(descuento);
    const p = num(pct);
    if (!(d > 0) || !(p > 0) || !(num(suma) > 0)) return false;
    const esperado = num(suma) * p / 100;
    return Math.abs(d - esperado) <= Math.max(1, num(nLineas));
  }

  // Devuelve el descuento que corresponde restar (o 0). `tolerancia` en pesos:
  // 0 en el servidor (cuadre al peso), 100 en el frontend (su regla de siempre).
  function descuentoAplicable(suma, neto, descuento, tolerancia) {
    const d = num(descuento);
    const tol = num(tolerancia);
    if (!(d > 0) || !(num(neto) > 0)) return 0;
    if (Math.abs(num(suma) - num(neto)) <= tol) return 0; // cuadra directo
    return Math.abs(num(suma) - d - num(neto)) <= tol ? d : 0;
  }

  // Devuelve { evaluable, cuadra, suma, neto, descuento, unidades, delta,
  //            (delta = suma - descuento - neto; descuento = 0 si no aplica)
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
    // descuento_pie ya viene validado contra el OCR (descuentoAlPieRespaldado,
    // en api/process.js); aca solo se decide si corresponde restarlo.
    const descuento = descuentoAplicable(suma, neto, parsed && parsed.descuento_pie, 0);
    return {
      evaluable: evaluable,
      cuadra: evaluable ? suma - descuento === neto : null,
      suma: suma,
      neto: neto,
      descuento: descuento,
      unidades: unidades,
      delta: suma - descuento - neto,
      unidadesDeclaradas: unidadesDeclaradas,
      cuadraUnidades: unidadesDeclaradas !== null && productos.length > 0
        ? unidades === unidadesDeclaradas
        : null,
    };
  }

  // Reparacion DETERMINISTA por linea, con lo que el OCR si lee bien.
  // Medido (548981, 04-sep-2026): Vision pierde las cantidades de UN digito
  // (3, 5) pero lee bien precios y "Valor Total" de cada fila (los 19 totales
  // presentes en el texto). Si la cantidad NO se leyo (0) y valor_total es
  // multiplo exacto del costo, la cantidad correcta es valor_total / costo.
  // SOLO repara cantidades en 0 (no leidas): una cantidad POSITIVA impresa
  // manda sobre el total, porque en plantillas como la de Idetex el "Valor
  // Total" viene impreso UNA fila corrido y "repararla" escribia la cantidad
  // de la fila vecina — y como las dos extracciones del consenso reparaban
  // igual, el error salia CORRELACIONADO e invisible (549298, 07-sep-2026:
  // Bars con 16 impreso + total ajeno 268.000 → 40 falso en ambas corridas).
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
      if (cantidad > 0) return p; // impresa y legible: manda sobre el total
      if (costo <= 0 || total <= 0) return p;
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

  // Verificacion DETERMINISTA de cantidades por el ORDEN del texto OCR.
  // Bateria 07-sep-2026 (549298): los DOS modelos permutaron Bars↔Flowers
  // IGUAL en 1 de 9 corridas — el consenso no ve lo que ambos fallan igual.
  // Pero en el stream de Vision la cantidad de una fila viene pegada ANTES de
  // su descripcion ("16, 40, Bars, Flowers" · "32, Quilt Breda 15P Beige"):
  // un ancla que ningun modelo puede pisar. Regla conservadora: una corrida de
  // K enteros pelados (sin separador de miles, 1-4 digitos) seguida —salvo
  // lineas sin digitos, como el header "Descripcion del Producto"— de K lineas
  // que calzan 1:1 con nombres de productos extraidos, se zipea en orden.
  // Cualquier otra forma NO se evalua (cero adivinanza, Regla 1); un nombre
  // repetido en la extraccion tampoco. Devuelve alertas donde la cantidad
  // extraida difiere de la que dicta el orden — deciden el candado F y el
  // operador contra el papel, no esta funcion.
  function normTexto(s) {
    const base = (s == null ? "" : String(s)).toLowerCase();
    let t;
    try { t = base.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) { t = base; }
    return t.replace(/[^a-z0-9]+/g, " ").trim();
  }

  function verificarCantidadPorOrdenOcr(ocrText, parsed) {
    const productos = Array.isArray(parsed && parsed.productos) ? parsed.productos : [];
    const out = { evaluable: false, alertas: [], verificadas: 0 };
    if (!ocrText || productos.length === 0) return out;
    out.evaluable = true;

    // nombre normalizado → producto (solo nombres UNICOS: con duplicados no
    // hay forma de saber cual fila es cual).
    const porNombre = {};
    const repetidos = new Set();
    productos.forEach(function (p) {
      const n = normTexto(p && p.nombre);
      if (!n) return;
      if (porNombre[n]) { repetidos.add(n); return; }
      porNombre[n] = p;
    });
    repetidos.forEach(function (n) { delete porNombre[n]; });

    const lineas = String(ocrText).split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    const esQty = function (l) { return /^\d{1,4}$/.test(l); };
    const esDesc = function (l) { return !!porNombre[normTexto(l)]; };
    const esSaltable = function (l) { return !/\d/.test(l); }; // header sin digitos

    let runQ = [];
    let i = 0;
    while (i < lineas.length) {
      const l = lineas[i];
      if (esQty(l)) { runQ.push(Number(l)); i++; continue; }
      if (esDesc(l)) {
        const descs = [];
        while (i < lineas.length && esDesc(lineas[i])) { descs.push(lineas[i]); i++; }
        if (descs.length === runQ.length && descs.length > 0) {
          descs.forEach(function (d, j) {
            const p = porNombre[normTexto(d)];
            out.verificadas++;
            if (Number(p.cantidad) !== runQ[j]) {
              out.alertas.push({ sku: (p.sku || "").toUpperCase().trim(), cantidad_extraida: Number(p.cantidad), cantidad_ocr: runQ[j] });
            }
          });
        }
        runQ = [];
        continue;
      }
      if (esSaltable(l)) { i++; continue; } // no rompe la corrida de cantidades
      runQ = []; // linea con digitos que no es cantidad ni descripcion: corta
      i++;
    }
    return out;
  }

  return { descuentoAlPieRespaldado: descuentoAlPieRespaldado, descuentoAplicable: descuentoAplicable, descuentoCalzaConPct: descuentoCalzaConPct, evaluarCuadre: evaluarCuadre, repararCantidades: repararCantidades, compararProductos: compararProductos, verificarCantidadPorOrdenOcr: verificarCantidadPorOrdenOcr };
});
