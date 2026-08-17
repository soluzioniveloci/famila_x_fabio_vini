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

  async function groqRequest(payload, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {

      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },

          body: JSON.stringify(payload)
        }
      );

      const data = await response.json();

      if (response.ok) {
        return data?.choices?.[0]?.message?.content || "";
      }

      /*
       * RATE LIMIT
       */
      if (response.status === 429 && attempt < retries) {

        let waitMs = 3500;

        const retryAfter =
          response.headers.get("retry-after");

        if (retryAfter) {
          const seconds =
            Number(retryAfter);

          if (!Number.isNaN(seconds)) {
            waitMs =
              Math.max(
                2500,
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

      if (response.status === 429) {
        throw new Error(
          "Il Sommelier Virtuale è momentaneamente molto richiesto. Riprova tra qualche secondo."
        );
      }

      throw new Error(
        data?.error?.message ||
        "Errore durante la ricerca."
      );
    }
  }

  function cleanJson(text) {
    return String(text || "")
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
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
        "La risposta del Sommelier non è leggibile. Riprova."
      );
    }
  }

  try {

    let ean = "";
    let wineQuery = "";

    /*
     * ==========================================
     * FOTO
     *
     * 1 SOLA chiamata Vision:
     * - verifica se è vino
     * - identifica la bottiglia
     * ==========================================
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
Analizza questa fotografia.

PRIMA stabilisci se il prodotto è realmente un VINO.

Sono considerati vino:
- vino rosso
- vino bianco
- vino rosato
- spumante
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
- altri prodotti.

Non presumere che sia vino.

Se non sei sicuro,
identified deve essere false.

Se è vino,
leggi soltanto ciò che riesci realmente a vedere:

- nome
- produttore/cantina
- denominazione
- regione
- annata
- vitigno
- tipologia

Rispondi SOLO JSON valido.

Se è vino:

{
  "identified": true,
  "is_wine": true,
  "name": "nome",
  "producer": "produttore",
  "type": "tipologia",
  "details": "tutte le informazioni leggibili utili alla ricerca"
}

Se è chiaramente NON vino:

{
  "identified": true,
  "is_wine": false,
  "category": "categoria prodotto"
}

Se non sei sicuro:

{
  "identified": false,
  "is_wine": false
}
`
                },

                {
                  type: "image_url",

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

          temperature: 0,

          max_completion_tokens: 450
        });

      /*
       * BLOCCO NON VINO
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
       * FOTO NON CHIARA
       */

      if (
        vision.identified !== true ||
        vision.is_wine !== true
      ) {
        return res.status(200).json({
          wine: {
            identified: false,

            message:
              "Non riesco a verificare con sufficiente certezza che il prodotto sia un vino. Prova a fotografare meglio la bottiglia o l'etichetta."
          }
        });
      }

      wineQuery =
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
     * ==========================================
     * EAN
     * ==========================================
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

      wineQuery =
        `EAN ${ean}`;
    }

    /*
     * ==========================================
     * UNA SOLA RICERCA WEB
     *
     * Compound Mini:
     * identifica
     * controlla categoria
     * raccoglie info
     * ==========================================
     */

    const researchPrompt =
      mode === "ean"

        ? `
Cerca sul web il codice EAN esatto:

"${ean}"

Prima identifica il prodotto.

NON presumere che sia vino.

Devi specificare chiaramente se il prodotto è:
- vino
oppure
- non vino.

Se non trovi una corrispondenza affidabile,
scrivi NON IDENTIFICATO.

Se è NON VINO,
indica chiaramente:
NON VINO
e la categoria del prodotto.

Se è un VINO,
raccogli in modo sintetico:

- nome completo
- produttore/cantina
- tipologia
- regione
- denominazione
- vitigno/uvaggio
- profilo gustativo
- 3-5 abbinamenti
- temperatura di servizio
- occasioni ideali

Cerca inoltre SOLO elementi verificabili
che aiutano a raccontarne il posizionamento:

- territorio
- denominazione
- metodo produttivo
- affinamento
- reputazione del produttore
- caratteristiche distintive

Puoi osservare il prezzo sul web
solo come contesto interno.

Non inventare.
Mantieni la risposta sotto 900 parole.
`

        : `
Cerca sul web questo vino identificato dalla fotografia:

"${wineQuery}"

Prima verifica che corrisponda realmente
a un prodotto appartenente alla categoria VINO.

Se scopri che NON è vino,
scrivi chiaramente:
NON VINO.

Se non riesci a identificarlo con certezza,
scrivi:
NON IDENTIFICATO.

Se è vino,
raccogli sinteticamente:

- nome completo
- produttore
- tipologia
- regione
- denominazione
- vitigno
- profilo gustativo
- 3-5 abbinamenti
- temperatura
- occasioni ideali

Raccogli inoltre SOLO elementi verificabili
che aiutano a raccontarne il posizionamento:

- territorio
- denominazione
- metodo produttivo
- affinamento
- reputazione
- caratteristiche distintive

Non inventare.
Mantieni la risposta sotto 900 parole.
`;

    const research =
      await groqRequest({

        model:
          "groq/compound-mini",

        messages: [
          {
            role: "user",
            content:
              researchPrompt
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
      });

    /*
     * ==========================================
     * UNA SOLA CHIAMATA FINALE
     *
     * controlla NON VINO
     * + genera direttamente la scheda.
     * ==========================================
     */

    const final =
      await groqJson({

        model:
          "openai/gpt-oss-20b",

        messages: [
          {
            role: "user",

            content: `
Sei il backend del "Sommelier Virtuale".

Devi analizzare il risultato della ricerca
e restituire la scheda finale.

RICERCA:

${research}

REGOLE DI SICUREZZA:

1. NON dare per scontato che il prodotto sia vino.

2. Se dalla ricerca emerge chiaramente
che il prodotto NON è vino
(es. birra, liquore, distillato,
olio, acqua, bibita ecc.),
restituisci:

{
  "identified": false,
  "is_wine": false,
  "non_wine": true,
  "message": "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini."
}

3. Se non riesci a identificarlo
con sufficiente certezza:

{
  "identified": false,
  "is_wine": false,
  "non_wine": false,
  "message": "Non riesco a identificare con sufficiente certezza questo vino. Prova con una foto più chiara o con il codice a barre della bottiglia."
}

4. Genera una scheda completa
SOLTANTO se sei ragionevolmente certo
che il prodotto sia un vino.

5. Non inventare informazioni.

6. Se un dato non è disponibile,
usa una stringa vuota.

7. Niente URL, citazioni o markdown.

8. pairings:
3-5 abbinamenti brevi,
separati da virgola.

9. value_story:
massimo 2-3 frasi.

Deve spiegare professionalmente
gli elementi VERIFICATI
che contribuiscono al valore
e al posizionamento del vino.

Non usare mai:

- costa tanto
- costa poco
- economico
- scarso
- costoso
- sovrapprezzato

Per vini accessibili puoi valorizzare,
solo se coerente:

- freschezza
- immediatezza
- piacevolezza
- versatilità
- facilità di abbinamento

Per vini di fascia superiore puoi valorizzare,
solo se verificati:

- territorio
- denominazione
- selezione delle uve
- metodo produttivo
- affinamento
- reputazione della cantina

Non inventare elementi premium.

Se è vino rispondi SOLO JSON:

{
  "identified": true,
  "is_wine": true,
  "non_wine": false,
  "ean": "${ean}",
  "name": "Nome completo",
  "producer": "Produttore",
  "region": "Regione",
  "type": "Tipologia",
  "grape": "Vitigno",
  "taste": "Profilo del vino",
  "pairings": "Abbinamento 1, Abbinamento 2, Abbinamento 3",
  "temperature": "Temperatura",
  "ideal_for": "Occasioni ideali",
  "value_story": "Spiegazione del valore",
  "confidence_note": ""
}
`
          }
        ],

        response_format: {
          type: "json_object"
        },

        temperature: 0.1,

        /*
         * IMPORTANTE:
         * output corto per consumare meno TPM.
         */
        max_completion_tokens: 700
      });

    if (
      mode === "ean" &&
      final.identified === true
    ) {
      final.ean = ean;
    }

    return res.status(200).json({
      wine: final
    });

  } catch (error) {

    console.error(
      "Errore Sommelier:",
      error
    );

    /*
     * Il cliente non vede più
     * il messaggio tecnico Groq.
     */

    const message =
      String(
        error?.message || ""
      );

    if (
      /rate limit|429|tokens per minute|tpm/i
        .test(message)
    ) {
      return res.status(429).json({
        error:
          "Il Sommelier Virtuale è momentaneamente molto richiesto. Attendi qualche secondo e riprova."
      });
    }

    return res.status(500).json({
      error:
        message ||
        "Si è verificato un problema durante la ricerca. Riprova."
    });
  }
}
