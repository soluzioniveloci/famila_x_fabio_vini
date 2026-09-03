export default async function handler(req, res) {

  /* ======================================================
     CONTROLLO RICHIESTA
  ====================================================== */

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


  /* ======================================================
     FUNZIONI DI SUPPORTO
  ====================================================== */

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));


  function cleanText(text) {
    return String(text || "")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }


  /*
   * Estrae il primo oggetto JSON valido anche quando
   * il modello mette del testo prima o dopo.
   */
  function extractJson(text) {

    const cleaned = cleanText(text);

    /*
     * Prima prova semplice.
     */
    try {
      return JSON.parse(cleaned);
    } catch {}


    /*
     * Ricerca robusta dell'oggetto {...}
     */
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
                "application/json",

              /*
               * Usa la versione corrente dei tool Compound.
               */
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
      } catch {
        data = {};
      }


      if (response.ok) {

        return (
          data?.choices?.[0]
            ?.message?.content || ""
        );
      }


      /*
       * RATE LIMIT
       */
      if (
        response.status === 429 &&
        attempt < retries
      ) {

        let waitMs = 4000;

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
        "Errore Groq:",
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
        "Risposta non interpretabile:",
        raw
      );

      throw new Error(
        "JSON_ERROR"
      );
    }

    return parsed;
  }


  /* ======================================================
     FUNZIONI DI RISPOSTA
  ====================================================== */

  function nonWineResponse(
    message
  ) {

    return res.status(200).json({
      wine: {
        identified: false,
        non_wine: true,

        /*
         * is_wine false SOLO
         * quando siamo realmente sicuri.
         */
        is_wine: false,

        message:
          message ||
          "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini."
      }
    });
  }


  function unknownResponse(
    message
  ) {

    return res.status(200).json({
      wine: {
        /*
         * IMPORTANTISSIMO:
         * non inseriamo is_wine:false.
         *
         * Il tuo app.js interpreta is_wine:false
         * come prodotto sicuramente non-vino.
         */
        identified: false,
        non_wine: false,

        message:
          message ||
          "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      }
    });
  }


  /* ======================================================
     ELABORAZIONE
  ====================================================== */

  try {

    let ean = "";

    let photoIdentification = "";


    /* ====================================================
       FOTO

       Prima chiamata:
       Qwen Vision verifica che sia davvero vino
       e legge l'etichetta.
    ==================================================== */

    if (mode === "image") {

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
        await groqJson(
          {

            model:
              "qwen/qwen3.6-27b",

            messages: [
              {

                role: "user",

                content: [

                  {
                    type: "text",

                    text: `
Analizza questa immagine come filtro di sicurezza
per un servizio dedicato esclusivamente ai vini.

Determina prima la categoria del prodotto.

Usa ESATTAMENTE uno di questi status:

"wine"
"non_wine"
"unknown"


STATUS "wine" soltanto se la bottiglia
è chiaramente un vino:

- vino rosso
- vino bianco
- vino rosato
- vino spumante
- vino frizzante
- Champagne
- Prosecco


STATUS "non_wine" se è chiaramente:

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


STATUS "unknown" se la foto
non permette di stabilirlo con sicurezza.

NON presumere che una bottiglia contenga vino.


Se status="wine",
leggi inoltre soltanto ciò che è realmente visibile:

- nome vino
- produttore/cantina
- denominazione
- tipologia
- regione
- annata
- vitigno


Rispondi SOLO JSON:

{
  "status": "wine",
  "name": "nome",
  "producer": "produttore",
  "type": "tipologia",
  "details": "altre informazioni leggibili"
}

oppure:

{
  "status": "non_wine",
  "category": "categoria identificata"
}

oppure:

{
  "status": "unknown"
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


      /*
       * NON VINO CERTO
       */
      if (
        vision.status ===
        "non_wine"
      ) {

        return nonWineResponse(
          "Il prodotto inquadrato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini."
        );
      }


      /*
       * FOTO INCERTA
       */
      if (
        vision.status !==
        "wine"
      ) {

        return unknownResponse(
          "Non riesco a verificare con sufficiente certezza che il prodotto sia un vino. Prova a fotografare meglio la bottiglia o l'etichetta."
        );
      }


      photoIdentification =
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
       EAN / UPC
    ==================================================== */

    if (mode === "ean") {

      ean =
        String(
          body.ean || ""
        )
          .replace(/\D/g, "");


      if (
        !/^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/
          .test(ean)
      ) {

        return res.status(400).json({
          error:
            "Codice EAN/UPC non valido."
        });
      }
    }


    /* ====================================================
       PROMPT RICERCA WEB
    ==================================================== */

    const searchPrompt =
      mode === "ean"

        ?

`
Sei il backend del Sommelier Virtuale.

Cerca sul web questo codice EAN/UPC ESATTO:

"${ean}"

Il servizio è dedicato esclusivamente ai vini.

PRIMA identifica il prodotto e la categoria.

NON presumere che sia vino.


Devi restituire uno dei tre status:

"wine"
"non_wine"
"unknown"


Usa status="non_wine" quando il codice
è associato con ragionevole certezza a:

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
- qualsiasi altro prodotto non-vino.


Usa status="unknown" quando:

- non trovi il codice;
- trovi risultati contrastanti;
- non riesci a identificare con certezza
  categoria e prodotto.


Usa status="wine" SOLTANTO quando
il prodotto trovato è realmente un vino.


Se NON VINO:

{
  "status": "non_wine",
  "category": "categoria prodotto",
  "product_name": "nome prodotto"
}


Se NON IDENTIFICATO:

{
  "status": "unknown"
}


Se VINO:

cerca soltanto:

- nome completo
- produttore/cantina
- regione
- tipologia
- vitigno/uvaggio
- profilo gustativo
- 3-5 abbinamenti
- temperatura di servizio
- occasioni ideali
- elementi verificabili
  che contribuiscono al posizionamento


Per il valore NON usare mai:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato


Non inventare caratteristiche premium.


Se vino rispondi:

{
  "status": "wine",
  "ean": "${ean}",
  "name": "Nome completo",
  "producer": "Produttore",
  "region": "Regione",
  "type": "Tipologia",
  "grape": "Vitigno",
  "taste": "Descrizione sintetica, massimo 2 frasi",
  "pairings": "Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature": "Temperatura",
  "ideal_for": "Occasioni",
  "value_story": "Massimo 2 frasi professionali",
  "confidence_note": ""
}

Rispondi SOLO con JSON valido.
`

        :

`
Sei il backend del Sommelier Virtuale.

Una prima analisi visiva
ha verificato che la bottiglia sembra un vino.

Dati letti dalla fotografia:

"${photoIdentification}"


Cerca sul web e verifica
l'identità esatta del prodotto.


Usa uno di questi status:

"wine"
"non_wine"
"unknown"


Se scopri che NON è realmente vino:

{
  "status": "non_wine",
  "category": "categoria prodotto",
  "product_name": "nome prodotto"
}


Se non riesci a identificare
il prodotto con sufficiente certezza:

{
  "status": "unknown"
}


Se confermi che è vino,
raccogli:

- nome
- produttore
- regione
- tipologia
- vitigno
- profilo gustativo
- 3-5 abbinamenti
- temperatura
- occasioni ideali
- elementi verificati
  che contribuiscono al posizionamento


Non inventare.

Non usare espressioni come:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato


Rispondi SOLO JSON:

{
  "status": "wine",
  "ean": "",
  "name": "Nome completo",
  "producer": "Produttore",
  "region": "Regione",
  "type": "Tipologia",
  "grape": "Vitigno",
  "taste": "Massimo 2 frasi",
  "pairings": "Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature": "Temperatura",
  "ideal_for": "Occasioni",
  "value_story": "Massimo 2 frasi professionali",
  "confidence_note": ""
}
`;


    /* ====================================================
       COMPOUND MINI + WEB SEARCH

       Una sola ricerca.
    ==================================================== */

    const raw =
      await groqRequest(
        {

          model:
            "groq/compound-mini",

          messages: [
            {
              role: "user",
              content:
                searchPrompt
            }
          ],


          /*
           * Compound Mini supporta JSON Object Mode.
           */
          response_format: {
            type:
              "json_object"
          },


          /*
           * Limitiamo i tool
           * alla sola ricerca web.
           */
          compound_custom: {

            tools: {

              enabled_tools: [
                "web_search"
              ]
            }
          },


          /*
           * Output compatto.
           */
          max_completion_tokens:
            600

        },

        1
      );


    /* ====================================================
       LETTURA RISPOSTA

       Parser robusto.
    ==================================================== */

    let wine =
      extractJson(raw);


    /*
     * FALLBACK:
     * se Compound non restituisce JSON,
     * proviamo almeno a capire se
     * ha dichiarato esplicitamente NON VINO.
     */
    if (!wine) {

      const lower =
        String(raw || "")
          .toLowerCase();


      if (
        lower.includes(
          "non vino"
        ) ||
        lower.includes(
          "non_wine"
        ) ||
        lower.includes(
          '"status": "non_wine"'
        )
      ) {

        return nonWineResponse();
      }


      console.error(
        "Risposta Compound non JSON:",
        raw
      );


      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }


    /* ====================================================
       NORMALIZZAZIONE STATUS
    ==================================================== */

    let status =
      String(
        wine.status || ""
      )
        .trim()
        .toLowerCase();


    /*
     * Compatibilità con eventuali
     * vecchie risposte del modello.
     */
    if (!status) {

      if (
        wine.non_wine === true ||
        (
          wine.is_wine === false &&
          wine.identified === true
        )
      ) {

        status =
          "non_wine";

      } else if (
        wine.is_wine === true ||
        wine.identified === true
      ) {

        status =
          "wine";

      } else {

        status =
          "unknown";
      }
    }


    /* ====================================================
       NON VINO
    ==================================================== */

    if (
      status ===
      "non_wine"
    ) {

      const product =
        wine.product_name
          ? ` (${wine.product_name})`
          : "";


      return nonWineResponse(
        `Il prodotto identificato${product} non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini.`
      );
    }


    /* ====================================================
       NON IDENTIFICATO
    ==================================================== */

    if (
      status !== "wine"
    ) {

      return unknownResponse(
        mode === "ean"

          ?
          "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Prova nuovamente oppure fotografa l'etichetta."

          :
          "Non riesco a identificare questo vino con sufficiente certezza. Prova con una foto più chiara."
      );
    }


    /* ====================================================
       VINO CONFERMATO

       Convertiamo nel formato
       atteso dal tuo app.js.
    ==================================================== */

    wine = {

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
    };


    return res.status(200).json({
      wine
    });


  } catch (error) {

    console.error(
      "Errore Sommelier:",
      error
    );


    const message =
      String(
        error?.message || ""
      );


    /* ====================================================
       RATE LIMIT
    ==================================================== */

    if (
      /RATE_LIMIT|rate limit|429|tokens per minute|TPM/i
        .test(message)
    ) {

      return res.status(429).json({

        error:
          "Il Sommelier Virtuale è momentaneamente molto richiesto. Attendi qualche secondo e riprova."
      });
    }


    /* ====================================================
       JSON NON INTERPRETABILE

       Non mostriamo un errore tecnico al cliente.
    ==================================================== */

    if (
      message === "JSON_ERROR"
    ) {

      return res.status(200).json({

        wine: {

          identified: false,

          non_wine: false,

          message:
            "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
        }
      });
    }


    /* ====================================================
       ERRORE GENERICO
    ==================================================== */

    return res.status(500).json({

      error:
        "Si è verificato un problema durante la ricerca. Riprova tra qualche secondo."
    });
  }
}
