export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GROQ_API_KEY non configurata su Vercel."
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
      } else if (ch === "}") {
        if (depth > 0) {
          depth--;
        }

        if (
          depth === 0 &&
          start !== -1
        ) {
          const candidate =
            cleaned.slice(
              start,
              i + 1
            );

          try {
            return JSON.parse(
              candidate
            );
          } catch {
            start = -1;
          }
        }
      }
    }

    return null;
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
              JSON.stringify(
                payload
              )
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

      if (
        response.status === 429 &&
        attempt < retries
      ) {
        let waitMs = 3500;

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
            waitMs =
              Math.max(
                3000,
                seconds * 1000
              );
          }
        }

        await sleep(waitMs);

        continue;
      }

      console.error(
        "Groq error:",
        response.status,
        data
      );

      if (
        response.status === 429
      ) {
        throw new Error(
          "RATE_LIMIT"
        );
      }

      throw new Error(
        data?.error?.message ||
        "GROQ_ERROR"
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
        "JSON non valido:",
        raw
      );

      throw new Error(
        "JSON_ERROR"
      );
    }

    return parsed;
  }

  function nonWineResponse(
    productName = ""
  ) {
    const extra =
      productName
        ? ` (${productName})`
        : "";

    return res
      .status(200)
      .json({
        wine: {
          identified: false,
          is_wine: false,
          non_wine: true,

          message:
            `Il prodotto identificato${extra} non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini.`
        }
      });
  }

  function unknownResponse(
    message
  ) {
    return res
      .status(200)
      .json({
        wine: {
          identified: false,
          non_wine: false,

          message:
            message ||
            "Non riesco a identificare il prodotto con sufficiente certezza."
        }
      });
  }

  function normalizeText(v) {
    return String(v || "")
      .toLowerCase()
      .trim();
  }

  function uniqueStrings(arr) {
    return [
      ...new Set(
        (arr || [])
          .filter(Boolean)
          .map(x =>
            String(x).trim()
          )
      )
    ];
  }

  /*
   * =====================================================
   * CLASSIFICAZIONE OPEN FOOD FACTS
   * =====================================================
   */

  function classifyOpenFoodFactsProduct(
    product
  ) {
    if (
      !product ||
      typeof product !== "object"
    ) {
      return {
        status: "unknown"
      };
    }

    const tags =
      uniqueStrings([
        ...(
          Array.isArray(
            product.categories_tags
          )
            ? product.categories_tags
            : []
        ),

        ...(
          Array.isArray(
            product.labels_tags
          )
            ? product.labels_tags
            : []
        )
      ])
        .map(normalizeText);

    const text =
      normalizeText(
        [
          product.product_name,
          product.product_name_it,
          product.generic_name,
          product.generic_name_it,
          product.brands,
          product.categories
        ]
          .filter(Boolean)
          .join(" | ")
      );

    /*
     * CATEGORIE VINO
     */
    const wineMarkers = [
      "en:wines",
      "en:red-wines",
      "en:white-wines",
      "en:rose-wines",
      "en:sparkling-wines",
      "en:champagnes",
      "en:prosecco",
      "en:fortified-wines",
      "en:dessert-wines",
      "en:table-wines"
    ];

    /*
     * CATEGORIE NON VINO
     */
    const nonWineTagMarkers = [
      "en:waters",
      "en:mineral-waters",
      "en:spring-waters",
      "en:beers",
      "en:beer",
      "en:ciders",
      "en:soft-drinks",
      "en:sodas",
      "en:fruit-juices",
      "en:juices",
      "en:iced-teas",
      "en:energy-drinks",
      "en:spirits",
      "en:whiskies",
      "en:whisky",
      "en:rums",
      "en:vodkas",
      "en:gins",
      "en:liqueurs",
      "en:olive-oils",
      "en:oils",
      "en:vinegars",
      "en:milk",
      "en:dairy-drinks",
      "en:plant-based-beverages"
    ];

    const wineText = [
      "vino ",
      "wine ",
      "vin ",
      "prosecco",
      "champagne",
      "spumante",
      "sparkling wine",
      "vino rosso",
      "vino bianco",
      "vino rosato",
      "red wine",
      "white wine",
      "rosé wine",
      "rose wine"
    ];

    const nonWineText = [
      "acqua",
      "water",
      "birra",
      "beer",
      "sidro",
      "cider",
      "whisky",
      "whiskey",
      "rum ",
      "vodka",
      "gin ",
      "grappa",
      "amaro",
      "liquore",
      "liqueur",
      "vermouth",
      "cocktail",
      "bibita",
      "soft drink",
      "soda",
      "succo",
      "juice",
      "olio",
      "oil ",
      "aceto",
      "vinegar"
    ];

    if (
      tags.some(tag =>
        wineMarkers.includes(tag)
      ) ||
      wineText.some(x =>
        text.includes(x)
      )
    ) {
      return {
        status: "wine"
      };
    }

    if (
      tags.some(tag =>
        nonWineTagMarkers.includes(
          tag
        )
      ) ||
      nonWineText.some(x =>
        text.includes(x)
      )
    ) {
      return {
        status: "non_wine"
      };
    }

    return {
      status: "unknown"
    };
  }

  /*
   * =====================================================
   * OPEN FOOD FACTS
   * =====================================================
   */

  async function lookupOpenFoodFacts(
    ean
  ) {
    try {
      const fields = [
        "code",
        "product_name",
        "product_name_it",
        "generic_name",
        "generic_name_it",
        "brands",
        "categories",
        "categories_tags",
        "labels_tags"
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
            method: "GET",

            headers: {
              "User-Agent":
                "FamilaSommelier/1.0 (Sommelier Virtuale)"
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

      const product =
        data.product;

      const classification =
        classifyOpenFoodFactsProduct(
          product
        );

      return {
        found: true,

        classification:
          classification.status,

        name:
          product.product_name_it ||
          product.product_name ||
          "",

        brand:
          product.brands ||
          "",

        categories:
          product.categories ||
          "",

        categories_tags:
          Array.isArray(
            product.categories_tags
          )
            ? product.categories_tags
            : []
      };

    } catch (error) {
      console.warn(
        "Open Food Facts non disponibile:",
        error
      );

      /*
       * Se OFF non risponde
       * non blocchiamo tutto:
       * useremo Groq come fallback.
       */
      return null;
    }
  }

  /*
   * =====================================================
   * INIZIO ELABORAZIONE
   * =====================================================
   */

  try {
    let ean = "";
    let photoIdentity = "";
    let offContext = null;

    /*
     * ===================================================
     * FOTO
     * ===================================================
     */

    if (
      mode === "image"
    ) {
      const image =
        String(
          body.image || ""
        );

      if (
        !/^data:image\/(jpeg|jpg|png|webp);base64,/i
          .test(image)
      ) {
        return res
          .status(400)
          .json({
            error:
              "Formato immagine non supportato."
          });
      }

      const vision =
        await groqJson(
          {
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
Sei il filtro visivo del Sommelier Virtuale.

Il servizio è dedicato esclusivamente ai vini.

Classifica il prodotto con uno status ESATTO:

"wine"
"non_wine"
"unknown"

Usa "wine" soltanto se è chiaramente:

- vino rosso
- vino bianco
- vino rosato
- vino spumante
- vino frizzante
- Champagne
- Prosecco
- altro vino chiaramente riconoscibile

Usa "non_wine" se riconosci chiaramente:

- acqua
- birra
- sidro
- whisky
- rum
- vodka
- gin
- grappa
- amaro
- liquore
- vermouth
- cocktail
- bibita
- succo
- olio
- aceto
- alimento
- altro prodotto non-vino

Usa "unknown" se:

- la fotografia non è abbastanza chiara
- non riesci a capire la categoria
- hai dubbi

NON presumere che una bottiglia sia vino.

Se status="wine",
leggi soltanto dati realmente visibili:

- nome
- produttore
- tipologia
- denominazione
- regione
- annata
- vitigno

Se status="non_wine",
indica se possibile categoria
e nome prodotto.

Rispondi SOLO JSON valido.

VINO:
{
  "status":"wine",
  "name":"nome",
  "producer":"produttore",
  "type":"tipologia",
  "details":"dati leggibili"
}

NON VINO:
{
  "status":"non_wine",
  "category":"categoria",
  "product_name":"nome prodotto"
}

INCERTO:
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
          },

          1
        );

      const visualStatus =
        normalizeText(
          vision.status
        );

      /*
       * FOTO NON VINO
       */
      if (
        visualStatus ===
        "non_wine"
      ) {
        return nonWineResponse(
          vision.product_name ||
          vision.category ||
          ""
        );
      }

      /*
       * FOTO INCERTA
       */
      if (
        visualStatus !==
        "wine"
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

    /*
     * ===================================================
     * EAN
     * ===================================================
     */

    if (
      mode === "ean"
    ) {
      ean =
        String(
          body.ean || ""
        )
          .replace(
            /\D/g,
            ""
          );

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

      /*
       * PRIMO CONTROLLO:
       * Open Food Facts
       */
      offContext =
        await lookupOpenFoodFacts(
          ean
        );

      /*
       * Se OFF ci dice chiaramente
       * che è acqua, birra, olio ecc.,
       * NON chiamiamo nemmeno Groq.
       */
      if (
        offContext
          ?.classification ===
        "non_wine"
      ) {
        return nonWineResponse(
          offContext.name ||
          offContext.brand ||
          offContext.categories ||
          ""
        );
      }
    }

    /*
     * ===================================================
     * PROMPT RICERCA WEB
     * ===================================================
     */

    let prompt = "";

    if (
      mode === "ean"
    ) {
      const knownProductContext =
        offContext

          ? `
Open Food Facts ha trovato:

Nome:
${offContext.name || "non disponibile"}

Marca:
${offContext.brand || "non disponibile"}

Categorie:
${offContext.categories || "non disponibili"}

Classificazione preliminare:
${offContext.classification}
`

          : `
Open Food Facts non ha trovato
informazioni affidabili per questo barcode.
`;

      prompt = `
Sei il backend del Sommelier Virtuale.

EAN/UPC esatto:

"${ean}"

${knownProductContext}

Verifica sul web il prodotto.

NON presumere mai che sia vino.

Devi restituire uno status:

"wine"
"non_wine"
"unknown"

Usa "wine"
soltanto se il prodotto è realmente vino.

Usa "non_wine"
se è:

- acqua
- birra
- sidro
- distillato
- liquore
- bibita
- succo
- olio
- aceto
- alimento
- altro prodotto non-vino

Usa "unknown"
se non riesci a identificare
con sufficiente certezza
prodotto e categoria.

SE NON VINO:

{
  "status":"non_wine",
  "product_name":"nome prodotto",
  "category":"categoria"
}

SE UNKNOWN:

{
  "status":"unknown"
}

SE VINO:

{
  "status":"wine",
  "name":"Nome completo",
  "producer":"Produttore",
  "region":"Regione",
  "type":"Tipologia",
  "grape":"Vitigno",
  "taste":"Profilo sintetico massimo 2 frasi",
  "pairings":"Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature":"Temperatura",
  "ideal_for":"Occasioni",
  "value_story":"Massimo 2 frasi professionali sugli elementi verificati che contribuiscono al posizionamento",
  "confidence_note":""
}

Nel value_story
NON dire mai:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato

Non inventare caratteristiche premium.

Rispondi SOLO JSON valido.
`;

    } else {
      prompt = `
Sei il backend del Sommelier Virtuale.

Una prima analisi visiva
ha classificato la bottiglia come vino.

Dati letti dalla fotografia:

"${photoIdentity}"

Cerca sul web
e verifica l'identità del prodotto.

Status possibili:

"wine"
"non_wine"
"unknown"

Se scopri che NON è vino:

{
  "status":"non_wine",
  "product_name":"nome prodotto",
  "category":"categoria"
}

Se non sei sufficientemente sicuro:

{
  "status":"unknown"
}

Se confermi che è vino:

{
  "status":"wine",
  "name":"Nome completo",
  "producer":"Produttore",
  "region":"Regione",
  "type":"Tipologia",
  "grape":"Vitigno",
  "taste":"Profilo sintetico massimo 2 frasi",
  "pairings":"Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature":"Temperatura",
  "ideal_for":"Occasioni",
  "value_story":"Massimo 2 frasi professionali sul posizionamento",
  "confidence_note":""
}

Non inventare.

Non usare giudizi denigratori
sul prezzo.

Rispondi SOLO JSON valido.
`;
    }

    /*
     * ===================================================
     * GROQ COMPOUND MINI
     * ===================================================
     */

    const raw =
      await groqRequest(
        {
          model:
            "groq/compound-mini",

          messages: [
            {
              role:
                "user",

              content:
                prompt
            }
          ],

          response_format: {
            type:
              "json_object"
          },

          compound_custom: {
            tools: {
              enabled_tools: [
                "web_search"
              ]
            }
          },

          max_completion_tokens:
            550
        },

        1
      );

    const wine =
      extractJson(raw);

    /*
     * RISPOSTA NON INTERPRETABILE
     */
    if (!wine) {
      console.error(
        "Risposta Compound non interpretabile:",
        raw
      );

      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }

    const status =
      normalizeText(
        wine.status
      );

    /*
     * NON VINO
     */
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

    /*
     * UNKNOWN
     */
    if (
      status !== "wine"
    ) {
      return unknownResponse(
        mode === "ean"

          ? "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Prova nuovamente oppure fotografa l'etichetta."

          : "Non riesco a identificare questo vino con sufficiente certezza. Prova con una foto più chiara."
      );
    }

    /*
     * ===================================================
     * VINO CONFERMATO
     * ===================================================
     */

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
      "Sommelier error:",
      error
    );

    const message =
      String(
        error?.message ||
        ""
      );

    /*
     * RATE LIMIT
     */
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

    /*
     * JSON
     */
    if (
      message ===
      "JSON_ERROR"
    ) {
      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }

    /*
     * ERRORE GENERICO
     */
    return res
      .status(500)
      .json({
        error:
          "Si è verificato un problema durante la ricerca. Riprova tra qualche secondo."
      });
  }
}
