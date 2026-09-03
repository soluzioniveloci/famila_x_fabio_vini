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

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function normalize(value) {
    return String(value || "")
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
        if (depth > 0) {
          depth--;
        }

        if (depth === 0 && start !== -1) {
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

  async function groqRequest(
    payload,
    retries = 1
  ) {
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
                "application/json"
            },
            body:
              JSON.stringify(payload)
          }
        );

      let data = {};

      try {
        data =
          await response.json();
      } catch {}

      if (response.ok) {
        return (
          data?.choices?.[0]
            ?.message?.content || ""
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
        let wait =
          3500;

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
        throw new Error(
          "RATE_LIMIT"
        );
      }

      if (response.status === 413) {
        throw new Error(
          "ENTITY_TOO_LARGE"
        );
      }

      throw new Error(
        data?.error?.message ||
        `GROQ_${response.status}`
      );
    }
  }

  async function groqJson(
    payload,
    retries = 1
  ) {
    const raw =
      await groqRequest(
        payload,
        retries
      );

    const parsed =
      extractJson(raw);

    if (!parsed) {
      console.error(
        "JSON non interpretabile:",
        raw
      );

      throw new Error(
        "JSON_ERROR"
      );
    }

    return parsed;
  }

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
        await fetch(
          url,
          {
            headers: {
              "User-Agent":
                "Famila-Sommelier/1.0"
            }
          }
        );

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

      const p =
        data.product;

      return {
        name:
          p.product_name_it ||
          p.product_name ||
          "",
        brand:
          p.brands || "",
        categories:
          p.categories || "",
        categoriesTags:
          Array.isArray(
            p.categories_tags
          )
            ? p.categories_tags
            : []
      };

    } catch (error) {
      console.warn(
        "Open Food Facts:",
        error
      );

      return null;
    }
  }

  async function identifyPhoto(image) {
    if (
      !/^data:image\/jpeg;base64,/i
        .test(image)
    ) {
      return {
        status: "unknown"
      };
    }

    /*
     * app.js tiene già la foto molto leggera.
     * Questa è solo una seconda barriera.
     */
    if (image.length > 1900000) {
      throw new Error(
        "ENTITY_TOO_LARGE"
      );
    }

    return await groqJson(
      {
        model:
          "qwen/qwen3.6-27b",

        reasoning_effort:
          "none",

        reasoning_format:
          "hidden",

        temperature: 0,

        max_completion_tokens:
          180,

        response_format: {
          type:
            "json_object"
        },

        messages: [
          {
            role: "user",

            content: [
              {
                type: "text",

                text:
`Classifica il prodotto fotografato.

Status possibili:
wine
non_wine
unknown

wine solo se è chiaramente vino, spumante, Champagne o Prosecco.
non_wine se è acqua, birra, sidro, distillato, liquore, bibita, succo, olio, aceto, alimento o altro prodotto.
unknown se non sei sicuro.

Non presumere che una bottiglia sia vino.

Se è vino leggi nome, produttore, tipologia e informazioni visibili.
Se non è vino identifica se possibile nome e categoria.

Rispondi solo JSON:

{"status":"wine","name":"","producer":"","type":"","details":""}

oppure:

{"status":"non_wine","product_name":"","category":""}

oppure:

{"status":"unknown"}`
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
        ]
      },
      1
    );
  }

  async function webSearchJson(prompt) {
    const raw =
      await groqRequest(
        {
          model:
            "groq/compound-mini",

          messages: [
            {
              role: "user",
              content:
                prompt
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

    return extractJson(raw);
  }

  try {
    let ean = "";
    let wine = null;

    /* ===================================================
       EAN
    =================================================== */

    if (mode === "ean") {
      ean =
        String(
          body.ean || ""
        )
          .replace(/\D/g, "");

      if (
        !(
          /^[0-9]{8}$/.test(ean) ||
          /^[0-9]{12}$/.test(ean) ||
          /^[0-9]{13}$/.test(ean) ||
          /^[0-9]{14}$/.test(ean)
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Codice EAN/UPC non valido."
          });
      }

      const hint =
        await lookupBarcode(
          ean
        );

      const hintText =
        hint
          ? `Database barcode: nome="${hint.name}", marca="${hint.brand}", categoria="${hint.categories}". Questi dati sono solo un indizio e possono essere errati.`
          : "Il database barcode non ha trovato un prodotto affidabile.";

      const prompt =
`Cerca sul web l'EAN esatto "${ean}".

${hintText}

Devi decidere tra:
wine
non_wine
unknown

IMPORTANTE:
non classificare come non_wine solo perché il database barcode lo suggerisce.
Verifica sempre l'EAN esatto sul web.

Se è chiaramente acqua, birra, liquore, bibita, olio, alimento o altro non-vino:

{"status":"non_wine","product_name":"","category":""}

Se non riesci a identificarlo con sufficiente certezza:

{"status":"unknown"}

Se è un vino confermato:

{
"status":"wine",
"name":"",
"producer":"",
"region":"",
"type":"",
"grape":"",
"taste":"",
"pairings":"",
"temperature":"",
"ideal_for":"",
"value_story":"",
"confidence_note":""
}

Scrivi i campi descrittivi in italiano.

taste: massimo 2 frasi.
pairings: 3-5 elementi separati da virgole.
value_story: massimo 2 frasi professionali sugli elementi verificati che contribuiscono al posizionamento.

Non inventare.
Rispondi SOLO JSON.`;

      wine =
        await webSearchJson(
          prompt
        );
    }

    /* ===================================================
       FOTO
    =================================================== */

    if (mode === "image") {
      const image =
        String(
          body.image || ""
        );

      const vision =
        await identifyPhoto(
          image
        );

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
        status !==
        "wine"
      ) {
        return unknownResponse(
          "Non riesco a verificare con sufficiente certezza che il prodotto sia un vino. Prova a fotografare meglio la bottiglia o l'etichetta."
        );
      }

      /*
       * IMPORTANTISSIMO:
       * da qui in poi inviamo SOLO testo.
       * La foto non viene più inviata.
       */
      const visible =
        [
          vision.name,
          vision.producer,
          vision.type,
          vision.details
        ]
          .filter(Boolean)
          .join(" | ")
          .slice(0, 600);

      const prompt =
`Cerca sul web questo vino identificato dalla foto:

"${visible}"

Se scopri che non è vino:

{"status":"non_wine","product_name":"","category":""}

Se non riesci a identificarlo con certezza:

{"status":"unknown"}

Se è un vino confermato:

{
"status":"wine",
"name":"",
"producer":"",
"region":"",
"type":"",
"grape":"",
"taste":"",
"pairings":"",
"temperature":"",
"ideal_for":"",
"value_story":"",
"confidence_note":""
}

Scrivi in italiano.

taste: massimo 2 frasi.
pairings: 3-5 elementi separati da virgole.
value_story: massimo 2 frasi professionali sugli elementi verificati che contribuiscono al posizionamento.

Non inventare.
Rispondi SOLO JSON.`;

      wine =
        await webSearchJson(
          prompt
        );
    }

    /* ===================================================
       NESSUN JSON
    =================================================== */

    if (!wine) {
      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }

    const status =
      normalize(
        wine.status
      );

    /* ===================================================
       NON VINO
    =================================================== */

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

    /* ===================================================
       UNKNOWN
    =================================================== */

    if (
      status !==
      "wine"
    ) {
      return unknownResponse(
        mode === "ean"
          ? "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Prova a fotografare direttamente l'etichetta."
          : "Non riesco a identificare questo vino con sufficiente certezza. Prova con una fotografia più chiara."
      );
    }

    /* ===================================================
       VINO
    =================================================== */

    return res
      .status(200)
      .json({
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
      /ENTITY_TOO_LARGE|Request Entity Too Large/i
        .test(message)
    ) {
      return res
        .status(413)
        .json({
          error:
            "La fotografia è troppo grande. Prova a scattarla nuovamente avvicinandoti all'etichetta."
        });
    }

    if (
      /RATE_LIMIT|rate limit|429|tokens per minute|TPM/i
        .test(message)
    ) {
      return res
        .status(429)
        .json({
          error:
            "Il Sommelier Virtuale è momentaneamente molto richiesto. Attendi qualche secondo e riprova."
        });
    }

    if (
      message ===
      "JSON_ERROR"
    ) {
      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }

    return res
      .status(500)
      .json({
        error:
          "Si è verificato un problema durante la ricerca. Riprova tra qualche secondo."
      });
  }
}
