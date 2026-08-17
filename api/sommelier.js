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

  /*
   * =====================================================
   * FUNZIONI BASE
   * =====================================================
   */

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function cleanJson(text) {
    return String(text || "")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  async function groqRequest(payload, retries = 1) {

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

      const data =
        await response.json();

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

        let wait = 4000;

        const retryAfter =
          response.headers.get(
            "retry-after"
          );

        if (retryAfter) {
          const sec =
            Number(retryAfter);

          if (!Number.isNaN(sec)) {
            wait =
              Math.max(
                3000,
                sec * 1000
              );
          }
        }

        await sleep(wait);
        continue;
      }

      console.error(
        "Errore Groq:",
        data
      );

      if (response.status === 429) {
        throw new Error(
          "RATE_LIMIT"
        );
      }

      throw new Error(
        data?.error?.message ||
        "Errore durante la ricerca."
      );
    }
  }

  async function groqJson(payload) {

    const raw =
      await groqRequest(payload);

    try {
      return JSON.parse(
        cleanJson(raw)
      );
    } catch (error) {

      console.error(
        "JSON non valido:",
        raw
      );

      throw new Error(
        "JSON_ERROR"
      );
    }
  }

  try {

    let ean = "";
    let identifiedFromPhoto = "";

    /*
     * =====================================================
     * FOTO
     *
     * UNA SOLA CHIAMATA VISION
     *
     * - verifica se è vino
     * - identifica bottiglia
     * =====================================================
     */

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
        await groqJson({

          model:
            "qwen/qwen3.6-27b",

          messages: [
            {
              role: "user",

              content: [
                {
                  type: "text",

                  text: `
Analizza questa fotografia con estrema prudenza.

PRIMA devi stabilire se il prodotto è realmente un VINO.

Sono considerati vino:

- vino rosso
- vino bianco
- vino rosato
- vino spumante
- vino frizzante
- Champagne
- Prosecco

NON sono vino:

- birra
- sidro
- whisky
- rum
- vodka
- gin
- grappa
- amari
- liquori
- vermouth
- cocktail
- acqua
- bibite
- succhi
- olio
- aceto
- alimenti
- altri prodotti

NON presumere che una bottiglia contenga vino.

Se non sei sufficientemente sicuro,
identified deve essere false.

Se è realmente vino,
leggi soltanto ciò che è visibile:

- nome vino
- produttore / cantina
- tipologia
- denominazione
- regione
- annata
- vitigno

Rispondi SOLO JSON.

VINO:

{
  "identified": true,
  "is_wine": true,
  "name": "nome del vino",
  "producer": "produttore",
  "type": "tipologia",
  "details": "altre informazioni utili visibili"
}

NON VINO:

{
  "identified": true,
  "is_wine": false,
  "category": "categoria prodotto"
}

INCERTO:

{
  "identified": false,
  "is_wine": false
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
            type: "json_object"
          },

          /*
           * OUTPUT MOLTO CORTO
           */

          temperature: 0,

          max_completion_tokens:
            250
        });

      /*
       * NON VINO
       */

      if (
        vision.identified === true &&
        vision.is_wine === false
      ) {
        return res.status(200).json({
          wine: {
            identified: false,
            is_wine: false,
            non_wine: true,

            message:
              "Il prodotto inquadrato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini."
          }
        });
      }

      /*
       * FOTO NON SUFFICIENTE
       */

      if (
        vision.identified !== true ||
        vision.is_wine !== true
      ) {
        return res.status(200).json({
          wine: {
            identified: false,
            is_wine: false,

            message:
              "Non riesco a verificare con sufficiente certezza che il prodotto sia un vino. Prova a fotografare meglio la bottiglia o l'etichetta."
          }
        });
      }

      identifiedFromPhoto =
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
     * =====================================================
     * EAN
     * =====================================================
     */

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

    /*
     * =====================================================
     * UNICA RICERCA WEB
     *
     * COMPOUND MINI
     *
     * DEVE GIÀ PRODURRE IL JSON FINALE
     *
     * NIENTE SECONDO GPT-OSS.
     * =====================================================
     */

    const searchPrompt =
      mode === "ean"

        ? `
Sei il backend del Sommelier Virtuale.

Cerca sul web il codice EAN/UPC esatto:

"${ean}"

IMPORTANTE:

NON presumere che sia vino.

Prima identifica il prodotto e la sua categoria.

Se è chiaramente NON VINO
(es. birra, sidro, liquore, distillato,
olio, acqua, bibita o altro prodotto),
restituisci SOLO:

{
  "identified": false,
  "is_wine": false,
  "non_wine": true,
  "message": "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini."
}

Se non trovi una corrispondenza affidabile:

{
  "identified": false,
  "is_wine": false,
  "non_wine": false,
  "message": "Non riesco a identificare con sufficiente certezza un vino associato a questo codice."
}

Se è realmente un VINO,
cerca soltanto le informazioni necessarie per questa scheda:

- nome
- produttore
- regione
- tipologia
- vitigno
- profilo gusto
- 3-5 abbinamenti
- temperatura
- occasioni ideali
- elementi realmente verificati
  che contribuiscono al posizionamento

IMPORTANTE PER IL VALORE:

Non dire mai:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato

Se il vino è accessibile,
puoi valorizzare SOLO se coerente:

- freschezza
- immediatezza
- piacevolezza
- versatilità
- facilità di abbinamento

Se è di posizionamento superiore,
puoi valorizzare SOLO se verificati:

- territorio
- denominazione
- selezione delle uve
- metodo produttivo
- affinamento
- reputazione della cantina

NON inventare elementi premium.

Rispondi ESCLUSIVAMENTE JSON:

{
  "identified": true,
  "is_wine": true,
  "non_wine": false,
  "ean": "${ean}",
  "name": "Nome vino",
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

La risposta deve essere MOLTO sintetica.
Non superare 350 parole totali.
`

        : `
Sei il backend del Sommelier Virtuale.

La fotografia è già stata verificata:
il prodotto è un vino.

Dati letti dalla foto:

"${identifiedFromPhoto}"

Cerca sul web il vino
e verifica la sua identità.

Se scopri che l'identificazione era sbagliata
e il prodotto NON è vino:

{
  "identified": false,
  "is_wine": false,
  "non_wine": true,
  "message": "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini."
}

Se non riesci a identificarlo con certezza:

{
  "identified": false,
  "is_wine": false,
  "non_wine": false,
  "message": "Non riesco a identificare questo vino con sufficiente certezza."
}

Se confermato come vino,
cerca esclusivamente:

- nome
- produttore
- regione
- tipologia
- vitigno
- profilo gusto
- 3-5 abbinamenti
- temperatura
- occasioni ideali
- elementi verificati del suo posizionamento

VALUE STORY:

massimo 2 frasi.

Non dire mai:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato

Non inventare
barrique,
vendemmia manuale,
produzione limitata,
lungo affinamento
o altri elementi premium.

Rispondi SOLO JSON:

{
  "identified": true,
  "is_wine": true,
  "non_wine": false,
  "ean": "",
  "name": "Nome vino",
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

La risposta deve essere MOLTO sintetica.
Non superare 350 parole.
`;

    /*
     * =====================================================
     * COMPOUND MINI
     *
     * UNA SOLA CHIAMATA.
     * =====================================================
     */

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
           * UNA SOLA RICERCA WEB
           */

          compound_custom: {
            tools: {
              enabled_tools: [
                "web_search"
              ]
            }
          }
        },

        /*
         * SOLO 1 RETRY
         */

        1
      );

    /*
     * =====================================================
     * IL COMPOUND DEVE RESTITUIRE JSON
     * =====================================================
     */

    let wine;

    try {

      wine =
        JSON.parse(
          cleanJson(raw)
        );

    } catch (error) {

      console.error(
        "Risposta non JSON:",
        raw
      );

      return res.status(502).json({
        error:
          "Il Sommelier Virtuale non è riuscito a completare la ricerca. Riprova."
      });
    }

    /*
     * SICUREZZA ULTERIORE
     */

    if (
      wine.non_wine === true ||
      wine.is_wine === false
    ) {

      return res.status(200).json({
        wine
      });
    }

    if (
      wine.identified !== true ||
      wine.is_wine !== true
    ) {

      return res.status(200).json({
        wine: {
          identified: false,

          message:
            wine.message ||
            "Non riesco a identificare questo vino con sufficiente certezza."
        }
      });
    }

    /*
     * EAN ORIGINALE
     */

    if (mode === "ean") {
      wine.ean = ean;
    }

    return res.status(200).json({
      wine
    });

  } catch (error) {

    console.error(
      "Errore Sommelier:",
      error
    );

    /*
     * RATE LIMIT
     */

    if (
      /RATE_LIMIT|rate limit|429|tokens per minute|TPM/i
        .test(
          String(
            error?.message || ""
          )
        )
    ) {

      return res.status(429).json({
        error:
          "Il Sommelier Virtuale è momentaneamente molto richiesto. Attendi qualche secondo e riprova."
      });
    }

    /*
     * ALTRI ERRORI
     */

    return res.status(500).json({
      error:
        "Si è verificato un problema durante la ricerca. Riprova tra qualche secondo."
    });
  }
}
