export default async function handler(req, res) {

  if (
    req.method !== "POST"
  ) {

    return res
      .status(405)
      .json({
        error:
          "Metodo non consentito"
      });
  }


  const apiKey =
    process.env
      .GROQ_API_KEY;


  if (!apiKey) {

    return res
      .status(500)
      .json({
        error:
          "GROQ_API_KEY non configurata su Vercel."
      });
  }


  const body =
    req.body || {};


  const mode =
    body.mode;


  if (
    ![
      "ean",
      "image"
    ].includes(mode)
  ) {

    return res
      .status(400)
      .json({
        error:
          "Richiesta non valida."
      });
  }


  /* =====================================================
     UTILITÀ
  ===================================================== */

  const sleep =
    ms =>
      new Promise(
        resolve =>
          setTimeout(
            resolve,
            ms
          )
      );


  function extractJson(
    text
  ) {

    const cleaned =
      String(
        text || ""
      )
        .replace(
          /^```json\s*/i,
          ""
        )
        .replace(
          /^```\s*/i,
          ""
        )
        .replace(
          /\s*```$/i,
          ""
        )
        .trim();


    try {

      return JSON.parse(
        cleaned
      );

    } catch {}


    /*
     * Cerca un oggetto JSON
     * anche se Groq aggiunge testo.
     */

    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;


    for (
      let i = 0;
      i < cleaned.length;
      i++
    ) {

      const char =
        cleaned[i];


      if (inString) {

        if (escaped) {

          escaped = false;

          continue;
        }


        if (
          char === "\\"
        ) {

          escaped = true;

          continue;
        }


        if (
          char === '"'
        ) {

          inString = false;
        }


        continue;
      }


      if (
        char === '"'
      ) {

        inString = true;

        continue;
      }


      if (
        char === "{"
      ) {

        if (
          depth === 0
        ) {

          start = i;
        }


        depth++;
      }


      if (
        char === "}"
      ) {

        if (
          depth > 0
        ) {

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


  function base64ApproxBytes(
    dataUrl
  ) {

    const base64 =
      String(dataUrl || "")
        .split(",")[1] || "";


    return (
      base64.length *
      0.75
    );
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

      const response =
        await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {

            method:
              "POST",

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


      if (
        response.ok
      ) {

        return (
          data
            ?.choices?.[0]
            ?.message?.content ||
          ""
        );
      }


      /*
       * RATE LIMIT
       */

      if (
        response.status === 429 &&
        attempt < retries
      ) {

        let waitMs =
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

            waitMs =
              Math.max(
                3000,
                seconds *
                  1000
              );
          }
        }


        await sleep(
          waitMs
        );


        continue;
      }


      console.error(
        "Groq error:",
        response.status,
        data
      );


      if (
        response.status ===
        429
      ) {

        throw new Error(
          "RATE_LIMIT"
        );
      }


      throw new Error(
        data
          ?.error
          ?.message ||
        "GROQ_ERROR"
      );
    }
  }


  async function groqJson(
    payload,
    retries = 1
  ) {

    const text =
      await groqRequest(
        payload,
        retries
      );


    const json =
      extractJson(
        text
      );


    if (!json) {

      console.error(
        "JSON non valido:",
        text
      );


      throw new Error(
        "JSON_ERROR"
      );
    }


    return json;
  }


  /* =====================================================
     RISPOSTE
  ===================================================== */

  function nonWineResponse(
    product = ""
  ) {

    const extra =
      product
        ? ` (${product})`
        : "";


    return res
      .status(200)
      .json({

        wine: {

          identified:
            false,

          is_wine:
            false,

          non_wine:
            true,

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

          identified:
            false,

          non_wine:
            false,

          message:
            message ||
            "Non riesco a identificare il prodotto con sufficiente certezza."
        }
      });
  }


  /* =====================================================
     ELABORAZIONE
  ===================================================== */

  try {

    let ean = "";

    let photoIdentity = "";


    /* ===================================================
       FOTO
    =================================================== */

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


      /*
       * Ulteriore protezione dimensione.
       */

      if (
        base64ApproxBytes(
          image
        ) >
        3.5 *
          1024 *
          1024
      ) {

        return res
          .status(413)
          .json({

            error:
              "La fotografia è troppo grande. Riprova scattando nuovamente la foto."
          });
      }


      /*
       * QWEN VISION
       */

      const vision =
        await groqJson(
          {

            model:
              "qwen/qwen3.6-27b",


            /*
             * Niente reasoning:
             * più veloce,
             * meno token,
             * JSON più pulito.
             */
            reasoning_effort:
              "none",

            reasoning_format:
              "hidden",


            messages: [
              {

                role:
                  "user",

                content: [

                  {

                    type:
                      "text",

                    text: `
Sei il filtro visivo del Sommelier Virtuale.

Il servizio è dedicato ESCLUSIVAMENTE ai vini.

Analizza attentamente la fotografia.

Devi classificare il prodotto con uno
e un solo status:

"wine"
"non_wine"
"unknown"


Usa "wine" SOLTANTO quando
la bottiglia è chiaramente:

- vino rosso
- vino bianco
- vino rosato
- vino spumante
- vino frizzante
- Champagne
- Prosecco
- altro prodotto chiaramente appartenente alla categoria vino


Usa "non_wine" quando riconosci chiaramente:

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
- qualsiasi altro prodotto non appartenente al vino


Usa "unknown" se:

- l'immagine è poco chiara
- non si vede bene l'etichetta
- non riesci a capire la categoria
- hai qualsiasi dubbio


NON presumere che una bottiglia sia vino.


Se è vino,
leggi soltanto informazioni realmente visibili:

- nome
- produttore
- tipologia
- denominazione
- regione
- annata
- vitigno


Se NON vino,
identifica se possibile categoria e nome prodotto.


Rispondi SOLO JSON.


VINO:

{
  "status": "wine",
  "name": "nome",
  "producer": "produttore",
  "type": "tipologia",
  "details": "dati utili leggibili"
}


NON VINO:

{
  "status": "non_wine",
  "category": "categoria",
  "product_name": "nome se leggibile"
}


INCERTO:

{
  "status": "unknown"
}
`
                  },


                  {

                    type:
                      "image_url",

                    image_url: {

                      url:
                        image
                    }
                  }
                ]
              }
            ],


            response_format: {

              type:
                "json_object"
            },


            temperature:
              0,


            max_completion_tokens:
              220
          },

          1
        );


      const status =
        String(
          vision.status ||
          ""
        )
          .trim()
          .toLowerCase();


      /*
       * ACQUA / BIRRA / OLIO ECC.
       */

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


      /*
       * FOTO INCERTA
       */

      if (
        status !==
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


    /* ===================================================
       EAN
    =================================================== */

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
    }


    /* ===================================================
       RICERCA WEB
    =================================================== */

    const prompt =
      mode === "ean"

      ? `
Sei il backend del Sommelier Virtuale.

Cerca sul web questo EAN/UPC ESATTO:

"${ean}"

PRIMA identifica il prodotto.

NON presumere che sia vino.

Restituisci UNO SOLO di questi status:

"wine"
"non_wine"
"unknown"


NON_WINE:

usa status="non_wine" se il codice
appartiene con ragionevole certezza a:

acqua, birra, sidro, distillato,
liquore, olio, aceto, bibita,
succo, alimento o altro prodotto
che non sia vino.


UNKNOWN:

usa status="unknown" quando:

- non trovi il codice
- trovi risultati contrastanti
- non riesci a verificare prodotto e categoria


WINE:

usa status="wine" soltanto
quando il prodotto è chiaramente un vino.


Se NON VINO:

{
  "status": "non_wine",
  "product_name": "nome",
  "category": "categoria"
}


Se sconosciuto:

{
  "status": "unknown"
}


Se vino:

{
  "status": "wine",
  "name": "Nome completo",
  "producer": "Produttore",
  "region": "Regione",
  "type": "Tipologia",
  "grape": "Vitigno",
  "taste": "Profilo sintetico massimo 2 frasi",
  "pairings": "Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature": "Temperatura",
  "ideal_for": "Occasioni",
  "value_story": "Massimo 2 frasi professionali sugli elementi verificati che contribuiscono al posizionamento",
  "confidence_note": ""
}


REGOLE:

Non inventare.

Non dire mai:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato

Nel value_story cita soltanto
elementi realmente verificati.

Rispondi SOLO JSON.
`

      : `
Sei il backend del Sommelier Virtuale.

La fotografia è stata classificata come vino.

Informazioni lette:

"${photoIdentity}"

Cerca sul web il prodotto
e verifica l'identità.

Restituisci:

"wine"
"non_wine"
oppure
"unknown".


Se scopri che NON è vino:

{
  "status": "non_wine",
  "product_name": "nome",
  "category": "categoria"
}


Se non sei sufficientemente sicuro:

{
  "status": "unknown"
}


Se è vino:

{
  "status": "wine",
  "name": "Nome completo",
  "producer": "Produttore",
  "region": "Regione",
  "type": "Tipologia",
  "grape": "Vitigno",
  "taste": "Profilo sintetico massimo 2 frasi",
  "pairings": "Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature": "Temperatura",
  "ideal_for": "Occasioni",
  "value_story": "Massimo 2 frasi professionali sul posizionamento",
  "confidence_note": ""
}


Non inventare.

Non usare giudizi denigratori
o riferimenti diretti a vino economico/costoso.

Rispondi SOLO JSON.
`;


    /*
     * Una sola ricerca web.
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
      extractJson(
        raw
      );


    /*
     * RISPOSTA NON LEGGIBILE
     */

    if (!wine) {

      console.error(
        "Risposta Compound:",
        raw
      );


      return unknownResponse(
        "Non riesco a identificare il prodotto con sufficiente certezza. Prova nuovamente."
      );
    }


    const status =
      String(
        wine.status ||
        ""
      )
        .trim()
        .toLowerCase();


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
     * SCONOSCIUTO
     */

    if (
      status !==
      "wine"
    ) {

      return unknownResponse(
        mode === "ean"
          ?
          "Non riesco a identificare con sufficiente certezza il prodotto associato a questo codice. Prova nuovamente oppure fotografa l'etichetta."
          :
          "Non riesco a identificare questo vino con sufficiente certezza. Prova con una foto più chiara."
      );
    }


    /*
     * VINO CONFERMATO
     */

    return res
      .status(200)
      .json({

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
              wine.name ||
              ""
            ),

          producer:
            String(
              wine.producer ||
              ""
            ),

          region:
            String(
              wine.region ||
              ""
            ),

          type:
            String(
              wine.type ||
              ""
            ),

          grape:
            String(
              wine.grape ||
              ""
            ),

          taste:
            String(
              wine.taste ||
              ""
            ),

          pairings:
            String(
              wine.pairings ||
              ""
            ),

          temperature:
            String(
              wine.temperature ||
              ""
            ),

          ideal_for:
            String(
              wine.ideal_for ||
              ""
            ),

          value_story:
            String(
              wine.value_story ||
              ""
            ),

          confidence_note:
            String(
              wine.confidence_note ||
              ""
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
