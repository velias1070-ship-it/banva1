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
        result.productos.push(parseLineItem(entity));
        break;
    }
  }

  // If no net amount but we have total and tax, calculate it
  if (!result.costo_neto && result.costo_bruto && result.iva) {
    result.costo_neto = Math.round((result.costo_bruto - result.iva) * 100) / 100;
  }

  return result;
}

function parseLineItem(entity) {
  const item = {
    sku: "",
    nombre: "",
    cantidad: 0,
    costo_unitario: 0,
    confianza: entity.confidence >= 0.8 ? "alta" : "baja",
  };

  const properties = entity.properties || [];
  const allCodes = [];

  for (const prop of properties) {
    const type = prop.type;
    const text = (prop.mentionText || "").trim();
    const value = prop.normalizedValue?.text || text;

    switch (type) {
      case "line_item/product_code":
        allCodes.push(value);
        break;
      case "line_item/description":
        item.nombre = value;
        break;
      case "line_item/quantity":
        // Handle both integer and decimal formats: "4", "4.0", "4,0"
        const qtyStr = value.replace(",", ".");
        const qty = parseFloat(qtyStr);
        item.cantidad = !isNaN(qty) ? Math.round(qty) : 0;
        break;
      case "line_item/unit_price":
        item.costo_unitario = parseAmount(value);
        break;
      case "line_item/amount":
        // Fallback: total line amount
        if (!item.costo_unitario) {
          item.costo_total = parseAmount(value);
        }
        break;
    }
  }

  // Pick the best SKU from detected codes
  // Idetex invoices have Cod.Alter (starts with letters like TXV, JSE, ALP)
  // and Código column - both are valid, prefer the second one if two exist
  if (allCodes.length >= 2) {
    // If two codes detected, use the second (Código column)
    item.sku = allCodes[1];
  } else if (allCodes.length === 1) {
    item.sku = allCodes[0];
  }

  // If no SKU found, try to extract from description or mentionText
  if (!item.sku) {
    // Try from the full entity mentionText (may contain codes before description)
    const fullText = (entity.mentionText || "").trim();
    const skuMatch = fullText.match(/\b([A-Z]{2,}[A-Z0-9]{4,}[A-Z0-9]*)\b/);
    if (skuMatch) {
      item.sku = skuMatch[1];
    }
    // Also try from nombre
    if (!item.sku && item.nombre) {
      const nameMatch = item.nombre.match(/^([A-Z0-9]{5,})\b/);
      if (nameMatch) {
        item.sku = nameMatch[1];
        item.nombre = item.nombre.replace(nameMatch[0], "").trim();
      }
    }
  }

  // Calculate unit price from total if missing
  if (!item.costo_unitario && item.costo_total && item.cantidad > 0) {
    item.costo_unitario = Math.round((item.costo_total / item.cantidad) * 100) / 100;
  }
  delete item.costo_total;

  return item;
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
