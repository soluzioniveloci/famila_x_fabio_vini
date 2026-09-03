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


  /* =====================================================
     UTILITY
  ===================================================== */

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

      const char = cleaned[i];

      if (inString) {

        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }


      if (char === '"') {
        inString = true;
        continue;
      }


      if (char === "{") {

        if (depth === 0) {
          start = i;
        }

        depth++;
      }


      if (char === "}") {

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
            return JSON.parse(candidate);
          } catch {
            start = -1;
          }
        }
      }
    }


    return null;
  }


  /* =====================================================
     RISPOSTE
  ===================================================== */

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


  /* =====================================================
     GROQ
  ===================================================== */

  async function groqRequest(
    payload,
    retries = 1
  ) {

    for (
      let attempt = 0;
      attempt <= retries;
      attempt++
    ) {

      const response = await fetch(
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
        data = await response.json();
      } catch {}


      if (response.ok) {

        return (
          data?.choices?.[0]
            ?.message?.content || ""
        );
      }


      console.error(
        "GROQ STATUS:",
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

          if (!Number.isNaN(seconds)) {

            wait = Math.max(
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


      if (response.status === 413) {
        throw new Error("ENTITY_TOO_LARGE");
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
      throw new Error(
        "JSON_ERROR"
      );
    }

    return json;
  }


  /* =====================================================
     OPEN FOOD FACTS
     SOLO INDIZIO, MAI DECISIONE FINALE
  ===================================================== */

  async function barcodeHint(ean) {

    try {

      const fields =
        "product_name,product_name_it,brands,categories";

      const url =
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
          ean
        )}.json?fields=${fields}`;


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


      const product =
        data.product;


      return {
        name:
          product.product_name_it ||
          product.product_name ||
          "",

        brand:
          product.brands || "",

        category:
          product.categories || ""
      };


    } catch (error) {

      console.warn(
        "OpenFoodFacts:",
        error
      );

      return null;
    }
  }


  /* =====================================================
     FOTO
  ===================================================== */

  async function identifyPhoto(image) {

    /*
     * app.js dovrebbe già comprimere.
     * Questa è una seconda protezione.
     */

    if (
      !/^data:image\/jpeg;base64,/i
        .test(image)
    ) {

      throw new Error(
        "IMAGE_FORMAT"
      );
    }


    /*
     * circa 2,5 MB come stringa Base64.
     */

    if (image.length > 2600000) {

      throw new Error(
        "ENTITY_TOO_LARGE"
      );
    }


    const payload = {

      model:
        "qwen/qwen3.6-27b",

      reasoning_effort:
        "none",

      reasoning_format:
        "hidden",

      temperature: 0,

      max_completion_tokens: 180,

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
`Classifica il prodotto nella foto.

Status ammessi:
wine
non_wine
unknown

wine = soltanto vino.
non_wine = acqua, birra, liquori, bibite, olio, alimenti o altro non-vino.
unknown = non sei sicuro.

Non presumere che una bottiglia sia vino.

Se è vino, leggi nome, produttore, tipologia e informazioni visibili.

Rispondi solo JSON:

{"status":"wine","name":"","producer":"","type":"","details":""}

oppure:

{"status":"non_wine","product_name":"","category":""}

oppure:

{"status":"unknown"}`
            },

            {
              type: "image_url",

              image_url: {
                url: image
              }
            }
          ]
        }
      ]
    };


    return await groqJson(payload);
  }


  /* =====================================================
     RICERCA WEB VINO
  ===================================================== */

  async function searchWine(prompt) {

    /*
     * NIENTE response_format:
     * Compound può usare web_search
     * senza essere costretto dal JSON mode.
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


    return extractJson(raw);
  }


  /* =====================================================
     ELABORAZIONE
  ===================================================== */

  try {

    let wine = null;
    let ean = "";


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

        return res.status(400).json({
          error:
            "Codice EAN/UPC non valido."
        });
      }


      const hint =
        await barcodeHint(ean);


      /*
       * Manteniamo il contesto CORTISSIMO.
       */

      const hintText =
        hint
          ? `Possibile prodotto: ${hint.name || "n/d"}; marca: ${hint.brand || "n/d"}; categoria: ${hint.category || "n/d"}.`
          : "Il database barcode non ha fornito informazioni.";


      const prompt =
`Cerca sul web l'EAN esatto "${ean}".

${hintText}

Il database barcode è soltanto un indizio e può essere errato.
Verifica sempre l'EAN sul web prima di decidere.

Restituisci:

{"status":"non_wine","product_name":"","category":""}

se l'EAN è chiaramente acqua, birra, liquore, bibita, olio, alimento o altro non-vino.

Restituisci:

{"status":"unknown"}

se non riesci a identificare il prodotto.

Se è sicuramente un vino, restituisci:

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

Tutti i testi descrittivi devono essere in italiano.

taste: massimo 2 frasi.
pairings: 3-5 abbinamenti separati da virgola.
value_story: massimo 2 frasi professionali che spieghino elementi verificabili del suo posizionamento senza usare "caro", "economico", "costoso", "scarso" o giudizi denigratori.

Non inventare.
Rispondi SOLO JSON.`;


      wine =
        await searchWine(
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


      const visualStatus =
        normalize(
          vision.status
        );


      /*
       * NON VINO:
       * STOP QUI.
       * Nessuna seconda richiesta.
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


      if (
        visualStatus !==
        "wine"
      ) {

        return unknownResponse(
          "Non riesco a verificare con sufficiente certezza che il prodotto sia un vino. Prova a fotografare meglio la bottiglia o l'etichetta."
        );
      }


      /*
       * Passiamo SOLO testo.
       * Mai la foto una seconda volta.
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
          .slice(0, 700);


      const prompt =
`Identifica sul web questo vino usando queste informazioni lette dall'etichetta:

"${visible}"

Se non è identificabile con sufficiente certezza:

{"status":"unknown"}

Se scopri che non è vino:

{"status":"non_wine","product_name":"","category":""}

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

Scrivi i testi in italiano.

taste: massimo 2 frasi.
pairings: 3-5 abbinamenti separati da virgola.
value_story: massimo 2 frasi professionali sugli elementi verificati che contribuiscono al posizionamento.

Non inventare.
Rispondi SOLO JSON.`;


      wine =
        await searchWine(
          prompt
        );
    }


    /* ===================================================
       RISPOSTA COMPOUND NON INTERPRETABILE
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

          ? "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Puoi provare a fotografare l'etichetta."

          : "Non riesco a identificare questo vino con sufficiente certezza. Prova con una fotografia più chiara."
      );
    }


    /* ===================================================
       VINO
    =================================================== */

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
        error?.message || ""
      );


    /* ===================================================
       FOTO ANCORA TROPPO GRANDE
    =================================================== */

    if (
      message.includes(
        "ENTITY_TOO_LARGE"
      ) ||
      /request entity too large/i.test(
        message
      )
    ) {

      return res.status(413).json({

        error:
          "La fotografia è troppo grande. Prova a scattarla nuovamente avvicinandoti all'etichetta."
      });
    }


    /* ===================================================
       RATE LIMIT
    =================================================== */

    if (
      /RATE_LIMIT|rate limit|429|tokens per minute|TPM/i
        .test(message)
    ) {

      return res.status(429).json({

        error:
          "Il Sommelier Virtuale è momentaneamente molto richiesto. Attendi qualche secondo e riprova."
      });
    }


    /* ===================================================
       JSON
    =================================================== */

    if (
      message ===
      "JSON_ERROR"
    ) {

      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }


    /* ===================================================
       ERRORE GENERICO
    =================================================== */

    return res.status(500).json({

      error:
        "Si è verificato un problema durante la ricerca. Riprova tra qualche secondo."
    });
  }
}
