const config = {
  maxDuration: 60,
};

async function ocrWithVision(imageBase64, apiKey) {
  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: {
            languageHints: ["es", "en"]
          }
        }]
      })
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vision API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  const annotation = data.responses?.[0]?.fullTextAnnotation;
  
  if (!annotation || !annotation.text) {
    throw new Error("No se pudo leer texto de la imagen. Intenta con mejor iluminacion.");
  }

  return annotation.text;
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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
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
  });

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
    var body = req.body;
    
    // If body has imageBase64, use Vision+Claude pipeline
    if (body.imageBase64) {
      if (!visionKey) {
        return res.status(500).json({ error: "GOOGLE_VISION_API_KEY no configurada en Vercel Environment Variables." });
      }
      if (!anthropicKey) {
        return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada en Vercel Environment Variables." });
      }

      // Step 1: OCR with Google Vision
      var ocrText = await ocrWithVision(body.imageBase64, visionKey);

      // Step 2: Structure with Claude (text only, no image)
      var claudeResponse = await structureWithClaude(ocrText, body.skuList || "", anthropicKey);

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
    
    var claudeBody = JSON.stringify(body);
    var response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: claudeBody
    });
    var responseText = await response.text();
    res.setHeader("Content-Type", "application/json");
    return res.status(response.status).send(responseText);

  } catch (error) {
    console.error("Process error:", error);
    return res.status(500).json({
      error: error.message || "Unknown error",
      type: error.name || "Error"
    });
  }
}

module.exports = handler;
module.exports.config = config;
