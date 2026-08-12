const config = {
  maxDuration: 300,
};

const VISION_ERRORS = {
  400: "Imagen no válida o corrupta. Intenta tomar la foto de nuevo.",
  401: "Error de autenticación con Google Vision. Verifica GOOGLE_VISION_API_KEY.",
  403: "Google Vision API no habilitada o clave sin permisos. Verifica que Cloud Vision API esté habilitada en tu proyecto de Google Cloud.",
  429: "Demasiadas solicitudes a Google Vision. Espera un momento e intenta de nuevo.",
  413: "Imagen demasiado grande para Google Vision (máx ~10MB en base64).",
};

// `etapa` identifica cual de las dos llamadas externas se colgo (OCR o extraccion).
// Antes el mensaje era generico y mandaba al operador a achicar la foto, aunque
// el que se hubiera cortado fuera Claude — donde el tamano de la imagen no influye
// en nada. Perdiamos el diagnostico y el operador reintentaba mal.
// `consejo` es la accion util para ESA etapa. En el OCR sigue valiendo "saca la
// foto de nuevo"; en la extraccion no, porque ahi la imagen ya ni existe.
async function fetchWithTimeout(url, options, timeoutMs = 30000, etapa = "la solicitud", consejo = "") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      const seg = Math.round(timeoutMs / 1000);
      const timeoutErr = new Error(
        `Se cortó ${etapa} por tiempo (${seg}s). ${consejo} `.trim() +
        ` Si se repite, avisa indicando el folio de la factura.`
      );
      // Marca explicita: el retry de Vision decide con esto, NO con includes("timeout").
      // Si alguien vuelve a editar el texto del mensaje, el reintento sigue funcionando.
      timeoutErr.esTimeout = true;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Vercel corta la funcion a los 300s (vercel.json). Si la SUMA de los timeouts
// individuales se pasa de ahi, Vercel mata el proceso y el operador ve el mensaje
// generico del frontend ("intenta con una imagen mas pequena") en vez del nuestro
// — justo lo que este cambio quiere eliminar. Peor caso teorico sin este tope:
// OCR 60s x2 + backoff (121s) + Claude 120s + reintento sin tuning 120s = 361s.
// Por eso cada llamada se recorta a lo que quede del presupuesto global.
const PRESUPUESTO_MS = 240000; // 240s: deja 60s de colchon bajo el maxDuration de 300s

function segunPresupuesto(ms, finPresupuesto) {
  const restante = finPresupuesto - Date.now();
  // Si ya no queda presupuesto, cortamos aca en vez de lanzar otra llamada
  // condenada: asi el operador ve NUESTRO mensaje y no el 504 pelado de Vercel
  // (que el frontend traduce al viejo "intenta con una imagen mas pequena").
  if (restante <= 5000) {
    const err = new Error(
      "Se acabó el tiempo disponible para procesar la factura. " +
      "Vuelve a intentar; si se repite, avisa indicando el folio."
    );
    err.esTimeout = true;
    throw err;
  }
  return Math.min(ms, restante);
}

// --- Google Cloud Vision OCR ---

async function ocrWithVision(imageBase64, apiKey, finPresupuesto, retries = 1) {
  const payload = JSON.stringify({
    requests: [{
      image: { content: imageBase64 },
      features: [
        { type: "DOCUMENT_TEXT_DETECTION" }
      ],
      imageContext: {
        languageHints: ["es"]
      }
    }]
  });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload
        },
        // 60s (antes 20s). La funcion tiene maxDuration 300s, asi que el techo
        // corto era nuestro, no de Vercel: facturas densas o fotos de varias
        // paginas apiladas hacen que Vision demore mas de 20s y se cortaba sola.
        segunPresupuesto(60000, finPresupuesto),
        "el OCR de la factura",
        "Saca la foto de nuevo, mejor iluminada y sin sombras."
      );

      if (!response.ok) {
        const errBody = await response.text();
        const friendlyMsg = VISION_ERRORS[response.status];
        if (friendlyMsg) throw new Error(friendlyMsg);

        let detail = "";
        try {
          const errJson = JSON.parse(errBody);
          detail = errJson.error?.message || errBody.slice(0, 200);
        } catch { detail = errBody.slice(0, 200); }
        throw new Error(`Vision API error (${response.status}): ${detail}`);
      }

      const data = await response.json();
      const imgResponse = data.responses?.[0];
      if (imgResponse?.error) {
        throw new Error(`Vision API: ${imgResponse.error.message || "Error procesando imagen"}`);
      }

      const fullText = imgResponse?.fullTextAnnotation?.text;
      const simpleText = imgResponse?.textAnnotations?.[0]?.description;
      const ocrText = fullText || simpleText;

      if (!ocrText || ocrText.trim().length < 5) {
        throw new Error(
          "No se detectó texto en la imagen. Asegúrate de que:\n" +
          "- La factura esté bien iluminada\n" +
          "- El texto sea legible y no esté borroso\n" +
          "- La imagen no esté al revés o rotada"
        );
      }

      return ocrText;

    } catch (err) {
      lastError = err;
      const isRetryable = err.esTimeout ||
                          err.message.includes("fetch failed") ||
                          err.message.includes("ECONNRESET") ||
                          err.message.includes("429");
      if (attempt < retries && isRetryable) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// --- Claude Sonnet: structure OCR text into invoice data ---

async function structureWithClaude(ocrText, anthropicKey, finPresupuesto) {
  // ELIMINADO a proposito: aca habia un corte del OCR a 6.000 caracteres,
  // resto de cuando esto corria en un modelo chico con max_tokens 4000.
  // Cortaba LA COLA de la factura — los ultimos productos Y los totales — sin
  // avisar, desde ~67 lineas (Idetex) o ~47 (proveedores con descripciones
  // largas). Y al botar los totales dejaba costo_neto=0, lo que ademas apagaba
  // el cuadre del frontend: recepcion incompleta que parecia completa.
  // El modelo actual acepta 1M de tokens de contexto: una factura de 1.000
  // lineas usa ~2% de eso. No hay nada que racionar. NO reintroducir el corte.

  const systemPrompt = `Eres un sistema de extracción de datos de facturas chilenas. Recibes texto OCR de una factura y extraes los productos.

REGLAS:
- Extrae SOLO productos de la factura (líneas con SKU, nombre, cantidad, precio)
- SKU: código alfanumérico EXACTO como aparece en el texto (columna "Código" o "Cod.Alter."). NO lo inventes ni modifiques. Si hay dos códigos por línea (Código y Cod.Alter.), usa el segundo (Cod.Alter.)
- Nombre: descripción del producto
- Cantidad: "Cant", "Qty", "Unid." — número entero
- Costo unitario neto (sin IVA): "P. Unitario", "Precio Unit", "Valor Unit" — número entero sin separador de miles
- Los precios en formato chileno usan punto como separador de miles (3.400 = tres mil cuatrocientos). Devuelve como entero: 3400
- Montos totales al final: Neto, IVA (19%), Total
- NO inventes productos ni SKUs. Si una línea es ilegible o dudosa NO la omitas en silencio: inclúyela con confianza "baja", con lo que hayas podido leer, y cantidad 0 si la cantidad no se lee. El sistema le mostrará esa línea al operador; una línea omitida desaparece sin que nadie lo note
- Cada fila de la tabla es un producto SEPARADO

REFERENCIAS DE ORDEN DE COMPRA (opcionales, NO afectan la lista de productos):
- referencia_oc: en el recuadro "DOCUMENTO(S) DE REFERENCIA" (normalmente al pie de la factura), el número que sigue a "Orden de Compra N°". Devuelve SOLO los dígitos, conservando ceros a la izquierda (ej: "Orden de Compra N° 036 / 12-ago-2026" → "036"). Si ese recuadro NO aparece, usa null.
- ovt y fvta: en el header, el campo "O.Compra" con formato OVT_########/FVTA_######## (ej: "O.Compra: OVT_00123456/FVTA_00987654"). Devuelve ovt con SOLO los dígitos que siguen a "OVT_" ("00123456") y fvta con SOLO los dígitos que siguen a "FVTA_" ("00987654"). Si el campo no está o falta una parte, usa null en la parte faltante.
- Estos tres campos son datos crudos de referencia: NUNCA los inventes ni los deduzcas de los productos. Si no los ves textualmente en el OCR, van null.

Responde SOLO JSON válido, COMPACTO: todo en una sola línea, sin saltos de línea,
sin indentación y sin espacios entre campos. Nada de texto antes ni después del JSON.
{"folio":"","proveedor":"","referencia_oc":null,"ovt":null,"fvta":null,"costo_neto":0,"iva":0,"costo_bruto":0,"productos":[{"sku":"","nombre":"","cantidad":0,"costo_unitario":0,"confianza":"alta"}]}`;

  // Modelos en orden de preferencia. Si Anthropic retira el primero
  // (404 not_found_error), cae automaticamente al siguiente y la app NO se cae.
  // Esto evita que un modelo retirado vuelva a romper el procesamiento de facturas.
  const MODELOS = ["claude-sonnet-4-6", "claude-opus-4-8"];

  // DESCARTADO a proposito: output_config {effort:"low"}. Recortaba algo de
  // latencia, pero dos revisiones independientes marcaron el mismo riesgo: menos
  // deliberacion en una extraccion sobre OCR puede hacer que el modelo OMITA una
  // linea legible y devuelva un JSON valido y completo. Eso no entra como error,
  // entra como recepcion incompleta — el peor modo de fallo posible para el WMS.
  // La ganancia era marginal; el riesgo, silencioso. No vale el cambio.
  // (Tampoco thinking:{type:"disabled"}: en sonnet-4-6 y opus-4-8 omitir el campo
  // ya significa sin thinking, seria un no-op puro.)
  const armarBody = (modelo) => JSON.stringify({
    model: modelo,
    // 8000 (antes 3000). Medido contra prod: el modelo emite el JSON indentado
    // (~179 chars por producto), asi que una factura de 40 lineas necesitaba
    // ~3.140 tokens y se cortaba en el producto 38 de 40. El array quedaba sin
    // cerrar y reventaba en JSON.parse. 3000 era el techo real de la app: ~38
    // productos. Con el JSON compacto que ahora pedimos en el prompt sobra, pero
    // dejamos aire para facturas grandes aunque el modelo ignore el "compacto".
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: "Extrae los productos de esta factura:\n\n" + ocrText
    }]
  });

  const pedirAClaude = (modelo) => fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: armarBody(modelo)
    },
    // 120s (antes 35s). Este paso NO tiene reintento por timeout: si se corta,
    // se cae la factura entera. Con maxDuration 300s sobra techo, damos aire real.
    segunPresupuesto(120000, finPresupuesto),
    "la extracción de los productos",
    "Vuelve a intentar: acá el tamaño de la foto no influye."
  );

  let response = null;
  let ultimoError = "";
  for (const modelo of MODELOS) {
    const r = await pedirAClaude(modelo);

    if (r.ok) { response = r; break; }

    const err = await r.text();
    ultimoError = "Claude API error: " + r.status + " - " + err.slice(0, 300);
    // Solo probamos el siguiente modelo si ESTE fue "modelo no encontrado"
    // (retirado o typo). Cualquier otro error (rate limit, key, etc.) corta aqui.
    const modeloRetirado = r.status === 404 && err.includes("not_found_error");
    if (!modeloRetirado) throw new Error(ultimoError);
  }

  if (!response) {
    throw new Error(ultimoError || "Claude API: ningun modelo disponible");
  }

  const data = await response.json();

  // Los modelos Claude 4+ pueden declinar una peticion. Sin esto, `content`
  // vendria vacio y el operador veria "Claude no devolvió JSON válido", que no
  // le dice nada. Falla cerrada igual, pero con un mensaje que se entiende.
  if (data.stop_reason === "refusal") {
    throw new Error(
      "La IA rechazó procesar esta imagen. Verifica que sea una factura y vuelve a intentar; " +
      "si se repite, avisa indicando el folio."
    );
  }

  // Si el modelo se quedo sin cupo, el JSON viene cortado a la mitad. Como
  // "productos" es la ULTIMA clave del schema, el corte siempre cae dentro del
  // array: al JSON le falta el cierre y el JSON.parse de abajo reventaria solo
  // (no existe el caso "lista incompleta que parsea bien"). Este guard no evita
  // eso — lo que hace es reemplazar el SyntaxError criptico por un mensaje que
  // el operador entiende y que le prohibe explicitamente usar el parcial.
  if (data.stop_reason === "max_tokens") {
    throw new Error(
      "La factura tiene demasiados productos para procesarla de una vez: la respuesta " +
      "se cortó por la mitad. NO uses el resultado parcial. Avisa con el folio de la factura."
    );
  }

  const text = data.content?.[0]?.text || "";

  // Extract JSON from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude no devolvió JSON válido");
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (parseErr) {
    // Antes esto salia como un SyntaxError crudo ("Expected ',' or ']' after
    // array element in JSON at position 6834"), que al operador no le dice nada.
    console.error("JSON malformado de Claude:", parseErr.message, "| largo:", text.length);
    throw new Error(
      "La respuesta de la IA llegó incompleta o malformada. Reintenta; " +
      "si vuelve a pasar, avisa con el folio de la factura."
    );
  }
}

// --- Handler ---

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.EtiquetasBanva;
  const visionKey = process.env.GOOGLE_VISION_API_KEY;

  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Request body inválido." });
    }

    if (body.imageBase64) {
      if (!visionKey) {
        return res.status(500).json({
          error: "GOOGLE_VISION_API_KEY no configurada en Vercel Environment Variables.",
          hint: "Ve a Vercel → tu proyecto → Settings → Environment Variables y agrega GOOGLE_VISION_API_KEY"
        });
      }
      if (!anthropicKey) {
        return res.status(500).json({
          error: "EtiquetasBanva (Anthropic API Key) no configurada en Vercel Environment Variables.",
        });
      }

      // Validate base64 image data
      if (typeof body.imageBase64 !== "string" || body.imageBase64.length < 100) {
        return res.status(400).json({ error: "Datos de imagen inválidos o vacíos." });
      }

      // Check base64 size (~10MB limit for Vision API)
      const estimatedBytes = body.imageBase64.length * 0.75;
      if (estimatedBytes > 10 * 1024 * 1024) {
        return res.status(413).json({
          error: "Imagen demasiado grande. Máximo ~10MB.",
          hint: "La app debería comprimir la imagen automáticamente. Intenta recargar la página.",
        });
      }

      // Presupuesto unico para toda la invocacion: ninguna llamada externa puede
      // hacer que la suma se pase del maxDuration y Vercel nos mate el proceso.
      const finPresupuesto = Date.now() + PRESUPUESTO_MS;

      // Step 1: OCR with Google Cloud Vision
      console.log("Step 1: Running Google Cloud Vision OCR...");
      const ocrText = await ocrWithVision(body.imageBase64, visionKey, finPresupuesto);
      console.log("OCR text length:", ocrText.length);
      console.log("OCR text preview:", ocrText.slice(0, 500));

      // Step 2: Structure with Claude Sonnet
      console.log("Step 2: Structuring with Claude Sonnet...");
      const parsed = await structureWithClaude(ocrText, anthropicKey, finPresupuesto);
      console.log("Claude extracted", parsed.productos?.length || 0, "products");

      return res.status(200).json({
        mode: "vision+claude",
        parsed: parsed,
        ocrText: ocrText,
      });
    }

    return res.status(400).json({ error: "Se requiere imageBase64 en el body." });

  } catch (error) {
    console.error("Process error:", error);

    let userMessage = error.message || "Error desconocido";
    if (error.message?.includes("fetch failed") || error.message?.includes("ENOTFOUND")) {
      userMessage = "No se pudo conectar con el servicio. Verifica tu conexión a internet.";
    }

    return res.status(500).json({
      error: userMessage,
      type: error.name || "Error",
    });
  }
}

module.exports = handler;
module.exports.config = config;
