export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error:
        "La chiave GROQ_API_KEY non è configurata su Vercel."
    });
  }

  const body = req.body || {};
  const mode = body.mode;

  if (!["ean", "image"].includes(mode)) {
    return res.status(400).json({
      error: "Richiesta non valida."
    });
  }

  async function groqChat(payload) {
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

    if (!response.ok) {
      console.error(
        "Errore Groq:",
        data
      );

      throw new Error(
        data?.error?.message ||
        "Errore durante la richiesta al Sommelier Virtuale."
      );
    }

    return (
      data?.choices?.[0]
        ?.message?.content || ""
    );
  }

  try {
    let ean = "";
    let wineQuery = "";

    // =====================================================
    // 1. RICERCA TRAMITE EAN
    // =====================================================

    if (mode === "ean") {
      ean = String(
        body.ean || ""
      ).replace(/\D/g, "");

      if (
        !/^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/.test(
          ean
        )
      ) {
        return res.status(400).json({
          error:
            "Codice EAN/UPC non valido."
        });
      }

      wineQuery =
        `codice a barre EAN/UPC ${ean}`;
    }

    // =====================================================
    // 2. RICONOSCIMENTO DA FOTO
    // =====================================================

    if (mode === "image") {
      const image = String(
        body.image || ""
      );

      if (
        !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(
          image
        )
      ) {
        return res.status(400).json({
          error:
            "Formato immagine non supportato."
        });
      }

      const visionResult =
        await groqChat({
          model:
            "qwen/qwen3.6-27b",

          messages: [
            {
              role: "user",

              content: [
                {
                  type: "text",

                  text: `
Osserva attentamente questa fotografia di una bottiglia di vino o della sua etichetta.

Devi identificare soltanto informazioni realmente visibili.

Cerca:

- nome del vino
- produttore o cantina
- denominazione
- regione o territorio
- eventuale annata
- vitigno, se leggibile

NON inventare nulla.

Se riesci a riconoscere almeno il nome del vino o il produttore,
rispondi con UNA SOLA riga sintetica contenente le informazioni leggibili.

Esempio:

Nome vino | Produttore | Denominazione | Regione | Annata

Se non riesci a riconoscere informazioni sufficienti,
rispondi ESATTAMENTE:

NON_IDENTIFICATO
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

          temperature: 0.1,
          max_completion_tokens: 500
        });

      if (
        !visionResult ||
        visionResult
          .toUpperCase()
          .includes(
            "NON_IDENTIFICATO"
          )
      ) {
        return res.status(200).json({
          wine: {
            identified: false,

            message:
              "Non riesco a riconoscere il vino dalla foto. Prova a fotografare meglio l'etichetta oppure scansiona il codice a barre."
          }
        });
      }

      wineQuery =
        visionResult.trim();
    }

    // =====================================================
    // 3. RICERCA APPROFONDITA SUL WEB
    // =====================================================

    const researchPrompt =
      mode === "ean"

        ? `
Cerca sul web in modo approfondito questo codice a barre:

"${ean}"

Devi identificare il vino o il prodotto associato.

Cerca il codice esatto anche tra virgolette.

Consulta, quando disponibili:

- sito ufficiale del produttore
- sito della cantina
- consorzio della denominazione
- schede vino
- cataloghi
- ecommerce
- database pubblici di prodotti
- rivenditori affidabili
- fonti enologiche attendibili

Devi ricavare, se verificabili:

- nome completo del vino
- produttore o cantina
- regione o territorio
- denominazione
- tipologia
- vitigno o uvaggio
- caratteristiche del gusto
- abbinamenti gastronomici
- temperatura di servizio
- occasioni di consumo

Inoltre devi cercare elementi REALI che contribuiscono al valore
e al posizionamento del vino, per esempio:

- denominazione
- territorio
- vitigno
- selezione delle uve
- metodo produttivo
- eventuale affinamento
- storia o reputazione del produttore
- caratteristiche distintive
- eventuale fascia/prezzo osservato sul web

Il prezzo può essere utilizzato soltanto come contesto interno
per comprendere il posizionamento.

NON devi giudicare il vino come:

- economico
- scarso
- costoso
- sovrapprezzato

NON inventare barrique, vendemmia manuale, produzione limitata,
affinamento lungo o altri elementi premium se non risultano dalle fonti.

Scrivi un report sintetico ma completo.
`

        : `
Cerca sul web in modo approfondito informazioni sul vino identificato
da questa fotografia:

"${wineQuery}"

Privilegia:

- sito ufficiale del produttore
- sito della cantina
- consorzio della denominazione
- fonti enologiche attendibili
- rivenditori affidabili

Devi ricavare, se verificabili:

- nome completo
- produttore
- regione o territorio
- denominazione
- tipologia
- vitigno o uvaggio
- caratteristiche del gusto
- abbinamenti
- temperatura di servizio
- occasioni di consumo

Inoltre cerca elementi REALI che contribuiscono al valore
e al posizionamento del vino:

- denominazione
- territorio
- vitigno
- selezione delle uve
- metodo produttivo
- eventuale affinamento
- storia o reputazione del produttore
- caratteristiche distintive
- eventuale fascia/prezzo osservato sul web

Il prezzo serve soltanto come contesto interno.

NON definire mai il vino:

- economico
- scarso
- costoso
- sovrapprezzato

NON inventare elementi premium non presenti nelle fonti.

Scrivi un report sintetico ma completo.
`;

    let researchResult = "";

    try {
      researchResult =
        await groqChat({
          model:
            "groq/compound-mini",

          messages: [
            {
              role: "user",
              content:
                researchPrompt
            }
          ]
        });

    } catch (error) {
      console.error(
        "Ricerca web non disponibile:",
        error
      );

      researchResult =
        wineQuery;
    }

    // =====================================================
    // 4. CREAZIONE DELLA SCHEDA FINALE
    // =====================================================

    const finalPrompt = `
Sei "Il Sommelier Virtuale".

Devi creare una scheda semplice, elegante e professionale
per un cliente che si trova davanti allo scaffale vini di un supermercato.

RICHIESTA DEL CLIENTE:

${
  mode === "ean"
    ? `EAN/UPC: ${ean}`
    : `Vino riconosciuto dalla fotografia: ${wineQuery}`
}

RISULTATI DELLA RICERCA APPROFONDITA SUL WEB:

${researchResult}

REGOLE IMPORTANTI:

- identified deve essere true soltanto se il vino è ragionevolmente identificato.
- Non inventare informazioni.
- Se un dato non è verificabile, usa una stringa vuota.
- Usa italiano semplice e professionale.
- Non scrivere markdown.
- Non mostrare citazioni o URL.
- Non scrivere frasi come "secondo le recensioni".
- Non scrivere "informazioni provenienti da fonti ufficiali e recensioni enologiche".
- La landing mostra già la frase:
  "Queste informazioni derivano da una ricerca approfondita dal web".

=====================================================
SEZIONE "COSA RACCONTA IL SUO VALORE"
=====================================================

Devi creare il campo "value_story".

"Value_story" deve essere composto da 2 o massimo 3 frasi.

Deve spiegare professionalmente QUALI ELEMENTI REALMENTE RISCONTRATI
nella ricerca contribuiscono al valore e al posizionamento del vino.

Non devi mai dire:

- "costa tanto"
- "costa poco"
- "vino economico"
- "vino scarso"
- "vino costoso"
- "sovrapprezzato"

Se il vino è di fascia accessibile,
valorizza soltanto quando coerente con le informazioni trovate:

- immediatezza
- piacevolezza
- freschezza
- versatilità
- facilità di abbinamento
- vocazione al consumo quotidiano

Esempio di tono:

"Una proposta pensata per esprimere freschezza, piacevolezza e immediatezza.
La sua versatilità lo rende adatto a diversi abbinamenti e occasioni di consumo."

NON copiare automaticamente questa frase.
Adattala al vino realmente trovato.

Se il vino ha un posizionamento superiore,
puoi valorizzare SOLTANTO quando verificati:

- territorio
- denominazione
- selezione delle uve
- metodo produttivo
- affinamento
- complessità
- storia o reputazione della cantina

Esempio di tono:

"Il suo valore nasce dal legame con il territorio e dalla cura dedicata alla produzione.
La selezione delle uve e il percorso di affinamento contribuiscono alla complessità
e al carattere del vino."

NON copiare automaticamente questa frase.
Adattala alle informazioni realmente trovate.

NON attribuire mai:

- barrique
- vendemmia manuale
- basse rese
- produzione limitata
- lungo affinamento
- selezioni speciali

se questi elementi NON risultano chiaramente dalla ricerca.

Se non hai abbastanza elementi per spiegare il posizionamento,
scrivi una frase prudente basata soltanto sulle caratteristiche verificate.

=====================================================
FORMATO JSON
=====================================================

Restituisci ESCLUSIVAMENTE JSON valido.

Se identificato:

{
  "identified": true,
  "ean": "${ean}",
  "name": "Nome completo del vino",
  "producer": "Cantina o produttore",
  "region": "Regione o territorio",
  "type": "Rosso, Bianco, Rosato, Spumante ecc.",
  "grape": "Vitigno principale o uvaggio",
  "taste": "Descrizione semplice del gusto in massimo due frasi",
  "pairings": "3-5 abbinamenti gastronomici consigliati",
  "temperature": "Temperatura ideale di servizio",
  "ideal_for": "2-4 occasioni ideali, in forma breve",
  "value_story": "2-3 frasi professionali che raccontano gli elementi verificati che contribuiscono al valore e al posizionamento del vino",
  "confidence_note": ""
}

Se NON identificato:

{
  "identified": false,
  "message": "Non riesco a identificare con certezza questo vino. Prova con una foto più chiara oppure scansiona il codice a barre."
}
`;

    const finalResult =
      await groqChat({
        model:
          "openai/gpt-oss-20b",

        messages: [
          {
            role: "user",
            content:
              finalPrompt
          }
        ],

        response_format: {
          type:
            "json_object"
        },

        temperature: 0.1,

        max_completion_tokens:
          1500
      });

    // =====================================================
    // 5. LETTURA JSON
    // =====================================================

    const cleaned =
      finalResult
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

    let wine;

    try {
      wine =
        JSON.parse(cleaned);

    } catch (error) {
      console.error(
        "JSON non valido:",
        cleaned
      );

      return res.status(502).json({
        error:
          "Il Sommelier Virtuale ha restituito una risposta non leggibile. Riprova."
      });
    }

    if (
      mode === "ean" &&
      wine.identified
    ) {
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

    return res.status(500).json({
      error:
        error?.message ||
        "Si è verificato un errore durante la ricerca del vino."
    });
  }
}
