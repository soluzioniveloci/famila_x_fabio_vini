export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GROQ_API_KEY non configurata."
    });
  }

  const body = req.body || {};
  const mode = body.mode;

  if (!["ean", "image"].includes(mode)) {
    return res.status(400).json({
      error: "Richiesta non valida."
    });
  }

  /* ======================================================
     UTILITÀ
  ====================================================== */

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function normalize(v) {
    return String(v || "")
      .trim()
      .toLowerCase();
  }

  function extractJson(text) {
    const cleaned = String(text || "")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {}

    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === "\\") {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = false;
        }

        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") {
        if (depth === 0) {
          start = i;
        }

        depth++;
      }

      if (ch === "}") {
        depth--;

        if (
          depth === 0 &&
          start !== -1
        ) {
          const candidate =
            cleaned.slice(start, i + 1);

          try {
            return JSON.parse(candidate);
          } catch {
            start = -1;
          }
        }
      }
    }

    return null;
  }

  function nonWineResponse(name = "") {
    const extra =
      name
        ? ` (${name})`
        : "";

    return res.status(200).json({
      wine: {
        identified: false,
        is_wine: false,
        non_wine: true,

        message:
          `Il prodotto identificato${extra} non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini.`
      }
    });
  }

  function unknownResponse(message) {
    return res.status(200).json({
      wine: {
        identified: false,
        non_wine: false,

        message:
          message ||
          "Non riesco a identificare il prodotto con sufficiente certezza."
      }
    });
  }

  /* ======================================================
     GROQ
  ====================================================== */

  async function groqRequest(payload, retries = 1) {
    for (
      let attempt = 0;
      attempt <= retries;
      attempt++
    ) {
      const response =
        await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              "Content-Type":
                "application/json",

              "Groq-Model-Version":
                "latest"
            },

            body:
              JSON.stringify(payload)
          }
        );

      let data = {};

      try {
        data = await response.json();
      } catch {}

      if (response.ok) {
        return (
          data?.choices?.[0]
            ?.message?.content ||
          ""
        );
      }

      console.error(
        "Groq API:",
        response.status,
        JSON.stringify(data)
      );

      if (
        response.status === 429 &&
        attempt < retries
      ) {
        let wait = 3500;

        const retryAfter =
          response.headers.get(
            "retry-after"
          );

        if (retryAfter) {
          const seconds =
            Number(retryAfter);

          if (
            !Number.isNaN(seconds)
          ) {
            wait =
              Math.max(
                3000,
                seconds * 1000
              );
          }
        }

        await sleep(wait);
        continue;
      }

      if (response.status === 429) {
        throw new Error("RATE_LIMIT");
      }

      throw new Error(
        data?.error?.message ||
        `GROQ_${response.status}`
      );
    }
  }

  async function groqJson(payload) {
    const raw =
      await groqRequest(
        payload,
        1
      );

    const json =
      extractJson(raw);

    if (!json) {
      console.error(
        "JSON non interpretabile:",
        raw
      );

      throw new Error(
        "JSON_ERROR"
      );
    }

    return json;
  }

  /* ======================================================
     OPEN FOOD FACTS
  ====================================================== */

  async function lookupBarcode(ean) {
    try {
      const fields = [
        "product_name",
        "product_name_it",
        "brands",
        "categories",
        "categories_tags"
      ].join(",");

      const url =
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
          ean
        )}.json?fields=${encodeURIComponent(
          fields
        )}`;

      const response =
        await fetch(url, {
          headers: {
            "User-Agent":
              "Famila-Sommelier/1.0"
          }
        });

      if (!response.ok) {
        return null;
      }

      const data =
        await response.json();

      if (
        data?.status !== 1 ||
        !data?.product
      ) {
        return null;
      }

      const p = data.product;

      const name =
        p.product_name_it ||
        p.product_name ||
        "";

      const categories =
        normalize(
          [
            p.categories,
            ...(Array.isArray(
              p.categories_tags
            )
              ? p.categories_tags
              : [])
          ].join(" ")
        );

      const wineWords = [
        "wine",
        "wines",
        "vino",
        "vini",
        "red-wine",
        "white-wine",
        "rose-wine",
        "rosé",
        "sparkling-wine",
        "prosecco",
        "champagne",
        "spumante"
      ];

      const nonWineWords = [
        "water",
        "waters",
        "acqua",
        "birra",
        "beer",
        "beers",
        "soft-drink",
        "soda",
        "juice",
        "succo",
        "oil",
        "olio",
        "vinegar",
        "aceto",
        "whisky",
        "whiskey",
        "vodka",
        "gin",
        "rum",
        "liqueur",
        "liquore",
        "cider",
        "sidro"
      ];

      if (
        wineWords.some(word =>
          categories.includes(word)
        )
      ) {
        return {
          status: "wine",
          name,
          brand: p.brands || "",
          categories: p.categories || ""
        };
      }

      if (
        nonWineWords.some(word =>
          categories.includes(word)
        )
      ) {
        return {
          status: "non_wine",
          name,
          brand: p.brands || "",
          categories: p.categories || ""
        };
      }

      return {
        status: "unknown",
        name,
        brand: p.brands || "",
        categories: p.categories || ""
      };

    } catch (error) {
      console.warn(
        "Open Food Facts:",
        error
      );

      return null;
    }
  }

  /* ======================================================
     ELABORAZIONE
  ====================================================== */

  try {
    let ean = "";
    let photoIdentity = "";

    /* ====================================================
       FOTO
    ==================================================== */

    if (mode === "image") {
      const image =
        String(body.image || "");

      if (
        !/^data:image\/(jpeg|jpg|png|webp);base64,/i
          .test(image)
      ) {
        return res.status(400).json({
          error:
            "Formato immagine non supportato."
        });
      }

      const vision =
        await groqJson({
          model:
            "qwen/qwen3.6-27b",

          reasoning_effort:
            "none",

          reasoning_format:
            "hidden",

          messages: [
            {
              role: "user",

              content: [
                {
                  type: "text",

                  text: `
Classifica il prodotto fotografato.

Il servizio è esclusivamente dedicato ai vini.

Status possibili:

wine
non_wine
unknown

WINE soltanto per:
vino rosso, bianco, rosato,
spumante, vino frizzante,
Champagne, Prosecco o altro vino.

NON_WINE per:
acqua, birra, sidro,
distillato, liquore, bibita,
succo, olio, aceto,
alimento o qualsiasi altro prodotto.

UNKNOWN se non sei sicuro.

Non presumere che una bottiglia sia vino.

Se è vino leggi:
nome, produttore, tipologia,
regione e dettagli visibili.

Se non è vino identifica,
se possibile, nome e categoria.

Rispondi SOLO JSON:

{
 "status":"wine",
 "name":"",
 "producer":"",
 "type":"",
 "details":""
}

oppure

{
 "status":"non_wine",
 "product_name":"",
 "category":""
}

oppure

{
 "status":"unknown"
}
`
                },

                {
                  type:
                    "image_url",

                  image_url: {
                    url: image
                  }
                }
              ]
            }
          ],

          response_format: {
            type:
              "json_object"
          },

          temperature: 0,

          max_completion_tokens:
            220
        });

      const status =
        normalize(
          vision.status
        );

      if (
        status ===
        "non_wine"
      ) {
        return nonWineResponse(
          vision.product_name ||
          vision.category ||
          ""
        );
      }

      if (
        status !== "wine"
      ) {
        return unknownResponse(
          "Non riesco a verificare con sufficiente certezza che il prodotto sia un vino. Prova a fotografare meglio la bottiglia o l'etichetta."
        );
      }

      photoIdentity =
        [
          vision.name,
          vision.producer,
          vision.type,
          vision.details
        ]
          .filter(Boolean)
          .join(" | ");
    }

    /* ====================================================
       EAN
    ==================================================== */

    let barcodeInfo = null;

    if (mode === "ean") {
      ean =
        String(body.ean || "")
          .replace(/\D/g, "");

      if (
        !(
          /^[0-9]{8}$/.test(ean) ||
          /^[0-9]{12}$/.test(ean) ||
          /^[0-9]{13}$/.test(ean) ||
          /^[0-9]{14}$/.test(ean)
        )
      ) {
        return res.status(400).json({
          error:
            "Codice EAN/UPC non valido."
        });
      }

      barcodeInfo =
        await lookupBarcode(ean);

      /*
       * ACQUA/BIRRA/OLIO ECC.
       * STOP IMMEDIATO.
       */
      if (
        barcodeInfo?.status ===
        "non_wine"
      ) {
        return nonWineResponse(
          barcodeInfo.name ||
          barcodeInfo.brand ||
          ""
        );
      }
    }

    /* ====================================================
       RICERCA COMPOUND
    ==================================================== */

    let prompt = "";

    if (mode === "ean") {
      const known =
        barcodeInfo
          ? `
Database barcode:
Nome: ${barcodeInfo.name || "n/d"}
Marca: ${barcodeInfo.brand || "n/d"}
Categoria: ${barcodeInfo.categories || "n/d"}
Classificazione preliminare: ${barcodeInfo.status}
`
          : `
Il database barcode non ha fornito
un'identificazione affidabile.
`;

      prompt = `
You are the backend of an Italian wine assistant.

Exact EAN/UPC:

${ean}

${known}

Search the web for this EXACT barcode.

FIRST determine whether the product is actually wine.

Return only one JSON object.

If it is definitely NOT wine:

{
  "status":"non_wine",
  "product_name":"product name",
  "category":"category"
}

If the product cannot be reliably identified:

{
  "status":"unknown"
}

If it is definitely wine:

{
  "status":"wine",
  "name":"full wine name",
  "producer":"producer",
  "region":"region",
  "type":"wine type",
  "grape":"grape",
  "taste":"Italian description, maximum two sentences",
  "pairings":"three to five Italian food pairings separated by commas",
  "temperature":"serving temperature",
  "ideal_for":"ideal occasions in Italian",
  "value_story":"two professional Italian sentences explaining verified factors contributing to its positioning",
  "confidence_note":""
}

Never invent information.

Water, beer, spirits, liqueurs,
soft drinks, juices, oils,
vinegars and foods are NON_WINE.

In value_story never say
cheap, expensive, poor,
overpriced or similar.

Answer ONLY with the JSON object.
`;

    } else {
      prompt = `
You are the backend of an Italian wine assistant.

The image classifier identified a probable wine.

Visible information:

${photoIdentity}

Search the web and identify the wine.

Return ONLY JSON.

If it is not actually wine:

{
  "status":"non_wine",
  "product_name":"",
  "category":""
}

If identification is uncertain:

{
  "status":"unknown"
}

If confirmed as wine:

{
  "status":"wine",
  "name":"full wine name",
  "producer":"producer",
  "region":"region",
  "type":"wine type",
  "grape":"grape",
  "taste":"Italian description, maximum two sentences",
  "pairings":"three to five Italian food pairings separated by commas",
  "temperature":"serving temperature",
  "ideal_for":"ideal occasions in Italian",
  "value_story":"two professional Italian sentences explaining verified factors contributing to its positioning",
  "confidence_note":""
}

Never invent information.
`;
    }

    /*
     * IMPORTANTE:
     *
     * NIENTE response_format qui.
     *
     * Compound Mini usa web search
     * e poi il nostro parser
     * estrae il JSON.
     */

    const raw =
      await groqRequest(
        {
          model:
            "groq/compound-mini",

          messages: [
            {
              role: "user",
              content: prompt
            }
          ],

          compound_custom: {
            tools: {
              enabled_tools: [
                "web_search"
              ]
            }
          }
        },
        1
      );

    let wine =
      extractJson(raw);

    /*
       Se Compound non restituisce JSON
       NON mostriamo un errore tecnico.
    */

    if (!wine) {
      console.error(
        "Compound raw:",
        raw
      );

      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }

    const status =
      normalize(
        wine.status
      );

    /* ====================================================
       NON VINO
    ==================================================== */

    if (
      status ===
      "non_wine"
    ) {
      return nonWineResponse(
        wine.product_name ||
        wine.category ||
        ""
      );
    }

    /* ====================================================
       UNKNOWN
    ==================================================== */

    if (
      status !== "wine"
    ) {
      return unknownResponse(
        mode === "ean"

          ? "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Puoi provare a fotografare direttamente l'etichetta."

          : "Non riesco a identificare questo vino con sufficiente certezza. Prova con una fotografia più chiara."
      );
    }

    /* ====================================================
       VINO
    ==================================================== */

    return res.status(200).json({
      wine: {
        identified: true,
        is_wine: true,
        non_wine: false,

        ean:
          mode === "ean"
            ? ean
            : "",

        name:
          String(
            wine.name || ""
          ),

        producer:
          String(
            wine.producer || ""
          ),

        region:
          String(
            wine.region || ""
          ),

        type:
          String(
            wine.type || ""
          ),

        grape:
          String(
            wine.grape || ""
          ),

        taste:
          String(
            wine.taste || ""
          ),

        pairings:
          String(
            wine.pairings || ""
          ),

        temperature:
          String(
            wine.temperature || ""
          ),

        ideal_for:
          String(
            wine.ideal_for || ""
          ),

        value_story:
          String(
            wine.value_story || ""
          ),

        confidence_note:
          String(
            wine.confidence_note || ""
          )
      }
    });

  } catch (error) {
    console.error(
      "SOMMELIER ERROR:",
      error
    );

    const message =
      String(
        error?.message || ""
      );

    if (
      /RATE_LIMIT|rate limit|429|tokens per minute|TPM/i
        .test(message)
    ) {
      return res.status(429).json({
        error:
          "Il Sommelier Virtuale è momentaneamente molto richiesto. Attendi qualche secondo e riprova."
      });
    }

    /*
     * Qualsiasi errore di parsing
     * diventa NON IDENTIFICATO,
     * non pagina tecnica.
     */

    if (
      message === "JSON_ERROR"
    ) {
      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }

    return res.status(500).json({
      error:
        "Si è verificato un problema durante la ricerca. Riprova tra qualche secondo."
    });
  }
}
