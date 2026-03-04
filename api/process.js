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

async function ocrWithVision(imageBase64, apiKey, retries = 2) {
  const payload = JSON.stringify({
    requests: [{
      image: { content: imageBase64 },
      features: [
        { type: "DOCUMENT_TEXT_DETECTION" },
        { type: "TEXT_DETECTION" }
      ],
      imageContext: {
        languageHints: ["es", "en"]
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
        35000
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

      // Check for per-image errors
      const imgResponse = data.responses?.[0];
      if (imgResponse?.error) {
        throw new Error(`Vision API: ${imgResponse.error.message || "Error procesando imagen"}`);
      }

      // Try fullTextAnnotation first (better for documents), fallback to textAnnotations
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
      // Only retry on network/timeout errors, not on API validation errors
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

async function structureWithClaude(ocrText, skuList, anthropicKey) {
  const systemPrompt = `Eres un sistema de extraccion de datos de facturas. Recibes el texto OCR de una factura y debes extraer los productos listados.

REGLAS IMPORTANTES:
- Extrae SOLO los productos que aparecen como items de la factura (lineas con SKU, nombre, cantidad)
- El SKU es un codigo alfanumerico como "TXV23QLAT30BE" o "JSAFAB421P20S"
- La cantidad puede aparecer como "Cant", "Qty", numero entero
- El nombre del producto suele estar junto al SKU
- NO inventes productos. Si no puedes leer algo con certeza, omitelo
- Si un campo es ilegible, dejalo vacio

SKUs validos del diccionario (REFERENCIA, usa SOLO si coinciden exactamente con lo que lees):
${skuList}

Responde SOLO con JSON valido, sin markdown ni explicaciones:
{
  "folio": "numero de folio/factura si es visible",
  "productos": [
    {
      "sku": "codigo SKU exacto como se lee",
      "nombre": "nombre del producto",
      "cantidad": numero,
      "confianza": "alta" o "baja"
    }
  ]
}`;

  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: "Aqui esta el texto OCR extraido de una factura. Extrae todos los productos:\n\n---\n" + ocrText + "\n---"
        }]
      })
    },
    30000
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error("Claude API error: " + response.status + " - " + err);
  }

  return response.json();
}

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const visionKey = process.env.GOOGLE_VISION_API_KEY;

  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Request body inválido." });
    }

    // If body has imageBase64, use Vision+Claude pipeline
    if (body.imageBase64) {
      if (!visionKey) {
        return res.status(500).json({
          error: "GOOGLE_VISION_API_KEY no configurada en Vercel Environment Variables.",
          hint: "Ve a Vercel → tu proyecto → Settings → Environment Variables y agrega GOOGLE_VISION_API_KEY"
        });
      }
      if (!anthropicKey) {
        return res.status(500).json({
          error: "ANTHROPIC_API_KEY no configurada en Vercel Environment Variables.",
          hint: "Ve a Vercel → tu proyecto → Settings → Environment Variables y agrega ANTHROPIC_API_KEY"
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
          error: "Imagen demasiado grande para Vision API. Máximo ~10MB.",
          hint: "La app debería comprimir la imagen automáticamente. Intenta recargar la página."
        });
      }

      // Step 1: OCR with Google Vision (with retries)
      const ocrText = await ocrWithVision(body.imageBase64, visionKey);

      // Step 2: Structure with Claude
      const claudeResponse = await structureWithClaude(ocrText, body.skuList || "", anthropicKey);

      return res.status(200).json({
        mode: "vision+claude",
        ocrText: ocrText,
        claudeResponse: claudeResponse
      });
    }

    // Fallback: pass through to Claude API directly (legacy/direct calls)
    if (!anthropicKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada." });
    }

    const claudeBody = JSON.stringify(body);
    const response = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01"
        },
        body: claudeBody
      },
      30000
    );
    const responseText = await response.text();
    res.setHeader("Content-Type", "application/json");
    return res.status(response.status).send(responseText);

  } catch (error) {
    console.error("Process error:", error);

    // Provide user-friendly error messages
    let userMessage = error.message || "Error desconocido";
    if (error.message?.includes("fetch failed") || error.message?.includes("ENOTFOUND")) {
      userMessage = "No se pudo conectar con el servicio. Verifica tu conexión a internet.";
    }

    return res.status(500).json({
      error: userMessage,
      type: error.name || "Error"
    });
  }
}

module.exports = handler;
module.exports.config = config;
