const crypto = require("crypto");

const config = {
  maxDuration: 60,
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

// --- Google Auth: generate access token from service account JSON ---

function createJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const unsigned = encode(header) + "." + encode(payload);
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(serviceAccount.private_key, "base64url");

  return unsigned + "." + signature;
}

async function getAccessToken(serviceAccount) {
  const jwt = createJwt(serviceAccount);

  const response = await fetchWithTimeout(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    },
    10000
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Error de autenticación Google: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.access_token;
}

// --- Document AI Invoice Parser ---

async function parseInvoiceWithDocumentAI(imageBase64, serviceAccount, processorId, location) {
  const accessToken = await getAccessToken(serviceAccount);
  const projectId = serviceAccount.project_id;
  const loc = location || "us";

  const endpoint = `https://${loc}-documentai.googleapis.com/v1/projects/${projectId}/locations/${loc}/processors/${processorId}:process`;

  const requestBody = JSON.stringify({
    rawDocument: {
      content: imageBase64,
      mimeType: "image/jpeg",
    },
  });

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    }

    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
      },
      45000
    );

    if (response.ok) {
      return response.json();
    }

    const errText = await response.text();
    lastError = `Document AI error (${response.status}): ${errText.slice(0, 300)}`;

    // Only retry on 429/500/503
    if (response.status !== 429 && response.status !== 500 && response.status !== 503) {
      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
}

// --- Map Document AI response to our invoice format ---

function mapDocumentAIResponse(docAIResponse) {
  const document = docAIResponse.document || docAIResponse;
  const entities = document.entities || [];

  const result = {
    folio: "",
    proveedor: "",
    costo_neto: 0,
    iva: 0,
    costo_bruto: 0,
    productos: [],
  };

  // Top-level fields
  for (const entity of entities) {
    const type = entity.type;
    const text = (entity.mentionText || "").trim();
    const value = entity.normalizedValue?.text || text;

    switch (type) {
      case "invoice_id":
        result.folio = value;
        break;
      case "supplier_name":
        result.proveedor = value;
        break;
      case "net_amount":
        result.costo_neto = parseAmount(value);
        break;
      case "total_tax_amount":
        result.iva = parseAmount(value);
        break;
      case "total_amount":
        result.costo_bruto = parseAmount(value);
        break;
      case "line_item":
        result.productos.push(...parseLineItems(entity));
        break;
    }
  }

  // If no net amount but we have total and tax, calculate it
  if (!result.costo_neto && result.costo_bruto && result.iva) {
    result.costo_neto = Math.round((result.costo_bruto - result.iva) * 100) / 100;
  }

  return result;
}

// Returns an array of items (handles merged entities that contain multiple products)
function parseLineItems(entity) {
  const properties = entity.properties || [];
  const fullText = (entity.mentionText || "").trim();

  // Extract all properties from Document AI
  let description = "";
  let detectedCode = "";
  let detectedQty = 0;
  let detectedPrice = 0;
  let detectedAmount = 0;

  for (const prop of properties) {
    const text = (prop.mentionText || "").trim();
    const value = prop.normalizedValue?.text || text;
    switch (prop.type) {
      case "line_item/description":
        description = value;
        break;
      case "line_item/product_code":
        detectedCode = value;
        break;
      case "line_item/quantity": {
        const q = parseFloat(value.replace(",", "."));
        detectedQty = !isNaN(q) ? Math.round(q) : 0;
        break;
      }
      case "line_item/unit_price":
        detectedPrice = parseAmount(value);
        break;
      case "line_item/amount":
        detectedAmount = parseAmount(value);
        break;
    }
  }

  // Filter ghost entities (no description, no code — just a stray amount)
  if (!description && !detectedCode && !detectedQty) {
    return [];
  }

  // Check if this is a merged entity (multiple descriptions separated by newlines)
  const descriptions = description
    .split("\n")
    .map((d) => d.trim())
    .filter(Boolean);

  if (descriptions.length <= 1) {
    // Single item — use detailed parsing
    return [
      parseSingleItem(
        fullText,
        description,
        detectedCode,
        detectedQty,
        detectedPrice,
        detectedAmount,
        entity.confidence
      ),
    ];
  }

  // --- Merged entity: split into individual items ---
  return splitMergedItems(descriptions, fullText);
}

function parseSingleItem(
  fullText,
  description,
  detectedCode,
  detectedQty,
  detectedPrice,
  detectedAmount,
  confidence
) {
  const item = {
    sku: "",
    nombre: description,
    cantidad: detectedQty,
    costo_unitario: detectedPrice,
    confianza: confidence >= 0.8 ? "alta" : "baja",
  };

  // --- SKU extraction ---
  // Try codes at the START of mentionText: "CODE1 CODE2 qty Description..."
  const codesAtStart = fullText.match(
    /^([A-Z][A-Z0-9]{4,})\s+([A-Z][A-Z0-9]{4,})/
  );
  if (codesAtStart) {
    item.sku = codesAtStart[2];
  } else {
    const singleStart = fullText.match(/^([A-Z][A-Z0-9]{4,})/);
    if (singleStart) {
      item.sku = singleStart[1];
    }
  }

  // Try codes at the END of mentionText: "Description price amount CODE1 CODE2"
  if (!item.sku) {
    const codesAtEnd = fullText.match(
      /([A-Z]{2}[A-Z0-9]{8,})\s+([A-Z]{2}[A-Z0-9]{8,})\s*$/
    );
    if (codesAtEnd) {
      item.sku = codesAtEnd[2];
    } else {
      // Single code at end
      const singleEnd = fullText.match(/([A-Z]{2}[A-Z0-9]{8,})\s*$/);
      if (singleEnd) {
        item.sku = singleEnd[1];
      }
    }
  }

  // Final fallback: use Document AI detected code
  if (!item.sku) {
    item.sku = detectedCode;
  }

  // --- Quantity fallback ---
  // Calculate from amount / unit_price when Document AI missed the quantity
  if (!item.cantidad && detectedAmount > 0 && item.costo_unitario > 0) {
    const calculated = Math.round(detectedAmount / item.costo_unitario);
    if (Math.abs(calculated * item.costo_unitario - detectedAmount) < 1) {
      item.cantidad = calculated;
    }
  }

  // Try extracting from mentionText: "CODE CODE <qty> Description"
  if (!item.cantidad) {
    const qtyFromText = fullText.match(
      /[A-Z0-9]{5,}\s+[A-Z0-9]{5,}\s+(\d{1,3})\s+[A-Z]/
    );
    if (qtyFromText) {
      item.cantidad = parseInt(qtyFromText[1], 10);
    }
  }

  // --- Unit price fallback ---
  if (!item.costo_unitario && detectedAmount > 0 && item.cantidad > 0) {
    item.costo_unitario = Math.round(detectedAmount / item.cantidad);
  }

  return item;
}

function splitMergedItems(descriptions, fullText) {
  // Extract all potential SKU codes from mentionText
  // Idetex SKUs: 10+ chars, uppercase, mix of letters and digits
  const allCodes = [];
  const codeRegex = /\b([A-Z]{2,}[A-Z0-9]*\d[A-Z0-9]*)\b/g;
  let match;
  while ((match = codeRegex.exec(fullText)) !== null) {
    const code = match[1];
    if (code.length >= 10 && /[A-Z]/.test(code) && /\d/.test(code)) {
      allCodes.push(code);
    }
  }

  // Deduplicate codes — Cod.Alter and Código are the same value,
  // but OCR may confuse O/0, so normalize before comparing
  const uniqueCodes = [];
  for (const code of allCodes) {
    const normalized = code.replace(/O/g, "0");
    const isDuplicate = uniqueCodes.some(
      (existing) => existing.replace(/O/g, "0") === normalized
    );
    if (!isDuplicate) {
      uniqueCodes.push(code);
    }
  }

  // Match codes to descriptions by CONTENT similarity (not position)
  // because Document AI may scramble the order when merging
  const usedCodes = new Set();
  const items = [];

  for (const desc of descriptions) {
    const item = {
      sku: "",
      nombre: desc,
      cantidad: 0,
      costo_unitario: 0,
      confianza: "baja", // Merged items always need manual review
    };

    // Find the best matching code for this description
    let bestCode = "";
    let bestScore = 0;

    for (const code of uniqueCodes) {
      if (usedCodes.has(code)) continue;
      const score = codeDescriptionMatchScore(code, desc);
      if (score > bestScore) {
        bestScore = score;
        bestCode = code;
      }
    }

    if (bestCode && bestScore >= 2) {
      item.sku = bestCode;
      usedCodes.add(bestCode);
    }

    // Try to find this description in fullText and extract surrounding numbers
    const descIdx = fullText.indexOf(desc);
    if (descIdx >= 0) {
      // Look for price right after the description (format: X.XXX or X,XXX)
      const afterDesc = fullText.substring(descIdx + desc.length);
      const priceMatch = afterDesc.match(/^\s+(\d{1,3}[.,]\d{3})/);
      if (priceMatch) {
        item.costo_unitario = parseAmount(priceMatch[1]);
      }

      // Look for total amount after price to calculate quantity
      if (item.costo_unitario) {
        const amountMatch = afterDesc.match(
          /^\s+\d{1,3}[.,]\d{3}\s+(\d{1,3}[.,]\d{3})/
        );
        if (amountMatch) {
          const amount = parseAmount(amountMatch[1]);
          if (amount > 0) {
            const qty = Math.round(amount / item.costo_unitario);
            if (Math.abs(qty * item.costo_unitario - amount) < 1) {
              item.cantidad = qty;
            }
          }
        }
      }
    }

    items.push(item);
  }

  return items;
}

// Score how well a SKU code matches a product description
// Higher score = better match. Used to pair codes with descriptions
// when Document AI merges multiple line items.
function codeDescriptionMatchScore(code, description) {
  let score = 0;

  // Match product family prefixes (most reliable signal)
  if (description.match(/Limpia/) && code.includes("CMPR")) score += 2;
  if (description.includes("Sabanas AF") && code.includes("SAFAB")) score += 4;
  if (description.includes("Sabanas EC") && code.includes("SECBQ")) score += 4;
  if (description.includes("Sabanas RS") && code.includes("SRSBH")) score += 4;
  if (description.includes("Quilt") && code.includes("QL")) score += 4;

  // Match size dimensions: "40 x 60" → code should contain "4060"
  const sizeMatch = description.match(/(\d{2,3})\s*x\s*(\d{2,3})/);
  if (sizeMatch) {
    // Use first 2 digits of each dimension (60 x 120 → "6012")
    const d1 = sizeMatch[1].substring(0, 2);
    const d2 = sizeMatch[2].substring(0, 2);
    const sizeStr = d1 + d2;
    if (code.includes(sizeStr)) score += 3;
  }

  // Match variant name initials (last alpha word → first 2 chars in code)
  // "Limpiapies Coco 40 x 60 Border" → "BO" should be in code
  const words = description
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]{3,}$/.test(w));
  if (words.length > 0) {
    const lastWord = words[words.length - 1];
    const initials = lastWord.substring(0, 2).toUpperCase();
    if (code.includes(initials)) score += 1;
  }

  return score;
}

function parseAmount(str) {
  if (!str) return 0;
  // Remove currency symbols, spaces, and handle Chilean/Spanish number format
  const cleaned = str
    .replace(/[^0-9.,-]/g, "")
    .replace(/\.(?=\d{3})/g, "") // Remove thousand separators (dots before 3 digits)
    .replace(",", "."); // Convert comma decimal to dot
  return parseFloat(cleaned) || 0;
}

// --- Claude Vision fallback for merged line items ---

async function reparseMergedWithClaude(imageBase64, apiKey) {
  const response = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: imageBase64,
                },
              },
              {
                type: "text",
                text: `Extrae TODOS los productos de esta factura chilena. Para cada fila de la tabla de productos, devuelve:
- sku: el código del producto (columna "Código" o "Cod.Alter.")
- nombre: descripción del producto
- cantidad: unidades (columna "Unid.")
- costo_unitario: precio unitario sin separador de miles (ej: 3400, no 3.400)

IMPORTANTE:
- Los precios en formato chileno usan punto como separador de miles (3.400 = tres mil cuatrocientos)
- Devuelve costo_unitario como número entero sin puntos (ej: 3400, 8500, 11000)
- Devuelve cantidad como número entero
- NO omitas ningún producto, extrae TODAS las filas de la tabla
- Si hay checkmarks (✓) en la columna de unidades, ignóralos y lee solo el número

Responde SOLO con un JSON array, sin texto adicional ni markdown:
[{"sku":"...","nombre":"...","cantidad":0,"costo_unitario":0}]`,
              },
            ],
          },
        ],
      }),
    },
    55000
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || "";

  // Extract JSON from response (handle potential markdown wrapping)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error("Claude no devolvió JSON válido");
  }

  const items = JSON.parse(jsonMatch[0]);
  return items.map((item) => ({
    sku: String(item.sku || "").trim(),
    nombre: String(item.nombre || "").trim(),
    cantidad: parseInt(item.cantidad, 10) || 0,
    costo_unitario: parseInt(item.costo_unitario, 10) || 0,
    confianza: "alta",
  }));
}

// --- Handler ---

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT;
  const processorId = process.env.DOCUMENT_AI_PROCESSOR_ID;
  const docAILocation = process.env.DOCUMENT_AI_LOCATION || "us";

  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Request body inválido." });
    }

    if (body.imageBase64) {
      if (!serviceAccountJson) {
        return res.status(500).json({
          error: "GOOGLE_SERVICE_ACCOUNT no configurada en Vercel Environment Variables.",
          hint: "Ve a Vercel → tu proyecto → Settings → Environment Variables y agrega GOOGLE_SERVICE_ACCOUNT con el JSON de tu service account.",
        });
      }
      if (!processorId) {
        return res.status(500).json({
          error: "DOCUMENT_AI_PROCESSOR_ID no configurada en Vercel Environment Variables.",
          hint: "Crea un Invoice Parser en Google Cloud Console → Document AI → Create Processor, y agrega el ID del processor.",
        });
      }

      let serviceAccount;
      try {
        serviceAccount = JSON.parse(serviceAccountJson);
      } catch {
        return res.status(500).json({
          error: "GOOGLE_SERVICE_ACCOUNT tiene un JSON inválido.",
          hint: "Asegúrate de pegar el contenido completo del archivo JSON de la service account.",
        });
      }

      // Validate base64 image data
      if (typeof body.imageBase64 !== "string" || body.imageBase64.length < 100) {
        return res.status(400).json({ error: "Datos de imagen inválidos o vacíos." });
      }

      // Check base64 size (~20MB limit for Document AI)
      const estimatedBytes = body.imageBase64.length * 0.75;
      if (estimatedBytes > 20 * 1024 * 1024) {
        return res.status(413).json({
          error: "Imagen demasiado grande. Máximo ~20MB.",
          hint: "La app debería comprimir la imagen automáticamente. Intenta recargar la página.",
        });
      }

      // Parse invoice with Document AI
      const docAIResponse = await parseInvoiceWithDocumentAI(
        body.imageBase64,
        serviceAccount,
        processorId,
        docAILocation
      );

      // Log raw entities for debugging
      const document = docAIResponse.document || docAIResponse;
      const rawEntities = (document.entities || []).map((e) => ({
        type: e.type,
        mentionText: (e.mentionText || "").slice(0, 200),
        confidence: e.confidence,
        properties: (e.properties || []).map((p) => ({
          type: p.type,
          mentionText: (p.mentionText || "").slice(0, 200),
          confidence: p.confidence,
        })),
      }));
      console.log("Document AI entities:", JSON.stringify(rawEntities, null, 2));

      // Map to our structured format
      const parsed = mapDocumentAIResponse(docAIResponse);

      // Check if Document AI produced merged/incomplete items
      const hasMergedItems = parsed.productos.some(
        (p) => p.confianza === "baja"
      );

      // Fallback: re-parse products with Claude Vision if merged items detected
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (hasMergedItems && anthropicKey) {
        try {
          console.log("Merged items detected, falling back to Claude Vision...");
          const claudeProducts = await reparseMergedWithClaude(
            body.imageBase64,
            anthropicKey
          );
          if (claudeProducts.length > 0) {
            parsed.productos = claudeProducts;
            console.log(
              `Claude Vision extracted ${claudeProducts.length} products`
            );
            return res.status(200).json({
              mode: "document-ai+claude",
              parsed: parsed,
              ocrText: document.text || "",
              debugEntities: rawEntities,
            });
          }
        } catch (claudeErr) {
          console.error("Claude fallback failed:", claudeErr.message);
          // Continue with Document AI results
        }
      }

      return res.status(200).json({
        mode: "document-ai",
        parsed: parsed,
        ocrText: document.text || "",
        debugEntities: rawEntities,
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
