const config = {
  maxDuration: 60,
};

const VISION_ERRORS = {
  400: "Imagen no válida o corrupta. Intenta tomar la foto de nuevo.",
  401: "Error de autenticación con Google Vision. Verifica GOOGLE_VISION_API_KEY.",
  403: "Google Vision API no habilitada o clave sin permisos. Verifica que Cloud Vision API esté habilitada en tu proyecto de Google Cloud.",
  429: "Demasiadas solicitudes a Google Vision. Espera un momento e intenta de nuevo.",
  413: "Imagen demasiado grande para Google Vision (máx ~10MB en base64).",
};

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("La solicitud tardó demasiado (timeout). Intenta con una imagen más pequeña.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Google Cloud Vision OCR ---

async function ocrWithVision(imageBase64, apiKey, retries = 1) {
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
        20000
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
      const isRetryable = err.message.includes("timeout") ||
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

async function structureWithClaude(ocrText, anthropicKey) {
  const truncatedOcr = ocrText.length > 6000 ? ocrText.slice(0, 6000) : ocrText;

  const systemPrompt = `Eres un sistema de extracción de datos de facturas chilenas. Recibes texto OCR de una factura y extraes los productos.

REGLAS:
- Extrae SOLO productos de la factura (líneas con SKU, nombre, cantidad, precio)
- SKU: código alfanumérico EXACTO como aparece en el texto (columna "Código" o "Cod.Alter."). NO lo inventes ni modifiques. Si hay dos códigos por línea (Código y Cod.Alter.), usa el segundo (Cod.Alter.)
- Nombre: descripción del producto
- Cantidad: "Cant", "Qty", "Unid." — número entero
- Costo unitario neto (sin IVA): "P. Unitario", "Precio Unit", "Valor Unit" — número entero sin separador de miles
- Los precios en formato chileno usan punto como separador de miles (3.400 = tres mil cuatrocientos). Devuelve como entero: 3400
- Montos totales al final: Neto, IVA (19%), Total
- NO inventes productos ni SKUs. Si algo es ilegible, omítelo
- Cada fila de la tabla es un producto SEPARADO

Responde SOLO JSON válido:
{"folio":"","proveedor":"","costo_neto":0,"iva":0,"costo_bruto":0,"productos":[{"sku":"","nombre":"","cantidad":0,"costo_unitario":0,"confianza":"alta"}]}`;

  const requestBody = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: "Extrae los productos de esta factura:\n\n" + truncatedOcr
    }]
  });

  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: requestBody
    },
    35000
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error("Claude API error: " + response.status + " - " + err.slice(0, 300));
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || "";

  // Extract JSON from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude no devolvió JSON válido");
  }

  return JSON.parse(jsonMatch[0]);
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

      // Step 1: OCR with Google Cloud Vision
      console.log("Step 1: Running Google Cloud Vision OCR...");
      const ocrText = await ocrWithVision(body.imageBase64, visionKey);
      console.log("OCR text length:", ocrText.length);
      console.log("OCR text preview:", ocrText.slice(0, 500));

      // Step 2: Structure with Claude Sonnet
      console.log("Step 2: Structuring with Claude Sonnet...");
      const parsed = await structureWithClaude(ocrText, anthropicKey);
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
