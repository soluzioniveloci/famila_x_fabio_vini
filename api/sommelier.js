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
            Number(
              retryAfter
            );

          if (
            !Number.isNaN(
              seconds
            )
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

      if (
        response.status === 429
      ) {
        throw new Error(
          "RATE_LIMIT"
        );
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

      const name =
        p.product_name_it ||
        p.product_name ||
        "";

      const categories =
        normalize(
          [
            p.categories,

            ...(
              Array.isArray(
                p.categories_tags
              )
                ? p.categories_tags
                : []
            )
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

      let status =
        "unknown";

      if (
        wineWords.some(
          word =>
            categories.includes(
              word
            )
        )
      ) {
        status =
          "wine";
      } else if (
        nonWineWords.some(
          word =>
            categories.includes(
              word
            )
        )
      ) {
        status =
          "non_wine";
      }

      return {
        status,
        name,
        brand:
          p.brands || "",
        categories:
          p.categories || ""
      };

    } catch (error) {
      console.warn(
        "Open Food Facts:",
        error
      );

      return null;
    }
  }

  try {
    let ean = "";
    let photoIdentity = "";
    let barcodeInfo = null;

    /* ===============================================
       FOTO
    =============================================== */

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
Champagne, Prosecco
o altro vino chiaramente riconoscibile.

NON_WINE per:
acqua, birra, sidro,
distillato, liquore,
bibita, succo, olio,
aceto, alimento
o qualsiasi altro prodotto.

UNKNOWN se non sei sicuro.

Non presumere che una bottiglia sia vino.

Se è vino leggi:
nome, produttore,
tipologia, regione
e dettagli visibili.

Se non è vino identifica,
se possibile,
nome e categoria.

Rispondi SOLO JSON:

{
  "status":"wine",
  "name":"",
  "producer":"",
  "type":"",
  "details":""
}

oppure:

{
  "status":"non_wine",
  "product_name":"",
  "category":""
}

oppure:

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

    /* ===============================================
       EAN
    =============================================== */

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
        return res.status(400).json({
          error:
            "Codice EAN/UPC non valido."
        });
      }

      /*
       * IMPORTANTE:
       * il database è SOLO un indizio.
       *
       * NON blocchiamo più qui
       * acqua/non-vino.
       */
      barcodeInfo =
        await lookupBarcode(
          ean
        );
    }

    /* ===============================================
       RICERCA WEB
    =============================================== */

    let prompt = "";

    if (
      mode === "ean"
    ) {
      const known =
        barcodeInfo
          ? `
DATABASE BARCODE
(SOLO INDIZIO - PUÒ ESSERE SBAGLIATO)

Nome:
${barcodeInfo.name || "n/d"}

Marca:
${barcodeInfo.brand || "n/d"}

Categoria:
${barcodeInfo.categories || "n/d"}

Classificazione preliminare:
${barcodeInfo.status}
`
          : `
Il database barcode
non ha fornito informazioni affidabili.
`;

      prompt = `
Sei il backend di un assistente vini italiano.

Devi identificare il prodotto associato
all'EAN/UPC ESATTO:

"${ean}"

${known}

ATTENZIONE FONDAMENTALE:

Le informazioni del database barcode
sono soltanto un INDIZIO
e possono contenere errori.

NON devi classificare un prodotto
come non-vino basandoti
soltanto sul database barcode.

DEVI cercare l'EAN ESATTO sul web.

Se il database barcode
e le fonti web sono in conflitto,
dai maggiore peso
a più fonti web affidabili
che riportano esplicitamente
lo stesso EAN.

Devi stabilire uno status:

"wine"
"non_wine"
"unknown"


-------------------------
NON WINE
-------------------------

Usa:

{
  "status":"non_wine",
  "product_name":"nome prodotto",
  "category":"categoria"
}

SOLTANTO quando
la ricerca web conferma
con ragionevole certezza
che questo EAN appartiene
a un prodotto non-vino:

acqua,
birra,
sidro,
distillato,
liquore,
bibita,
succo,
olio,
aceto,
alimento
o altro prodotto non-vino.


-------------------------
UNKNOWN
-------------------------

Se:

- non trovi l'EAN;
- trovi risultati contrastanti;
- non riesci a verificare
  il prodotto con sufficiente certezza;

restituisci:

{
  "status":"unknown"
}


-------------------------
VINO
-------------------------

Se più informazioni affidabili
confermano che l'EAN
corrisponde a un vino:

{
  "status":"wine",
  "name":"Nome completo del vino",
  "producer":"Produttore",
  "region":"Regione",
  "type":"Tipologia",
  "grape":"Vitigno",
  "taste":"Descrizione in italiano, massimo 2 frasi",
  "pairings":"3-5 abbinamenti in italiano separati da virgole",
  "temperature":"Temperatura di servizio",
  "ideal_for":"Occasioni ideali in italiano",
  "value_story":"Massimo 2 frasi professionali in italiano sugli elementi verificati che contribuiscono al posizionamento",
  "confidence_note":""
}


REGOLE:

Non inventare informazioni.

Per il valore non usare:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato

Descrivi soltanto
elementi realmente verificati,
come territorio,
denominazione,
produttore,
metodo produttivo,
affinamento o stile,
quando disponibili.

Rispondi SOLO JSON.
`;

    } else {
      prompt = `
Sei il backend
di un assistente vini italiano.

Il classificatore visivo
ha identificato un probabile vino.

Informazioni visibili:

${photoIdentity}

Cerca sul web
e verifica l'identità.

Rispondi SOLO JSON.

Se scopri che NON è vino:

{
  "status":"non_wine",
  "product_name":"",
  "category":""
}

Se non riesci
a identificarlo con certezza:

{
  "status":"unknown"
}

Se è confermato vino:

{
  "status":"wine",
  "name":"Nome completo del vino",
  "producer":"Produttore",
  "region":"Regione",
  "type":"Tipologia",
  "grape":"Vitigno",
  "taste":"Descrizione in italiano, massimo 2 frasi",
  "pairings":"3-5 abbinamenti in italiano separati da virgole",
  "temperature":"Temperatura di servizio",
  "ideal_for":"Occasioni ideali in italiano",
  "value_story":"Massimo 2 frasi professionali sugli elementi verificati che contribuiscono al posizionamento",
  "confidence_note":""
}

Non inventare informazioni.
`;
    }

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

    const wine =
      extractJson(raw);

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

    /* ===============================================
       NON VINO
    =============================================== */

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

    /* ===============================================
       UNKNOWN
    =============================================== */

    if (
      status !== "wine"
    ) {
      return unknownResponse(
        mode === "ean"

          ? "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Puoi provare a fotografare direttamente l'etichetta."

          : "Non riesco a identificare questo vino con sufficiente certezza. Prova con una fotografia più chiara."
      );
    }

    /* ===============================================
       VINO CONFERMATO
    =============================================== */

    return res.status(200).json({
      wine: {
        identified:
          true,

        is_wine:
          true,

        non_wine:
          false,

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
        error?.message ||
        ""
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

    if (
      message ===
      "JSON_ERROR"
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
