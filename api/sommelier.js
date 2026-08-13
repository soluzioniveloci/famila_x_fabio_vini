export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo non consentito"
    });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "La chiave GROQ_API_KEY non è configurata su Vercel."
    });
  }

  const body = req.body || {};
  const mode = body.mode;

  if (!["name", "image"].includes(mode)) {
    return res.status(400).json({
      error: "Richiesta non valida."
    });
  }

  // =====================================================
  // FUNZIONE GENERICA GROQ
  // =====================================================

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
      console.error("Errore Groq:", data);

      throw new Error(
        data?.error?.message ||
        "Errore durante la richiesta al Sommelier AI."
      );
    }

    return data?.choices?.[0]?.message?.content || "";
  }

  try {
    let wineQuery = "";

    // =====================================================
    // 1. SCANSIONE ETICHETTA
    // =====================================================

    if (mode === "image") {
      const image = String(body.image || "");

      if (
        !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)
      ) {
        return res.status(400).json({
          error: "Formato immagine non supportato."
        });
      }

      const visionResult = await groqChat({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",

        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `
Stai analizzando la fotografia dell'etichetta di una bottiglia di vino.

Devi leggere con attenzione tutto ciò che riesci a vedere.

Cerca soprattutto:

- nome commerciale del vino
- cantina o produttore
- denominazione
- vitigno, se scritto
- regione o territorio
- eventuale annata

NON inventare parole che non riesci a leggere.

Se riconosci almeno il nome del vino oppure il produttore,
restituisci una sola frase del tipo:

Nome vino | Produttore | Denominazione | Regione | Annata

Inserisci solamente le informazioni realmente leggibili.

Se invece non riesci assolutamente a leggere né nome né produttore,
rispondi solamente:

NON_IDENTIFICATO
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

        temperature: 0.1,
        max_completion_tokens: 400
      });

      if (
        !visionResult ||
        visionResult
          .toUpperCase()
          .includes("NON_IDENTIFICATO")
      ) {
        return res.status(200).json({
          wine: {
            identified: false,
            message:
              "Non riesco a leggere bene questa etichetta. Prova ad avvicinarti alla bottiglia, evita i riflessi e scatta nuovamente la foto."
          }
        });
      }

      wineQuery = visionResult.trim();
    }

    // =====================================================
    // 2. RICERCA MANUALE PER NOME
    // =====================================================

    if (mode === "name") {
      wineQuery = String(body.name || "").trim();

      if (!wineQuery) {
        return res.status(400).json({
          error: "Inserisci il nome del vino."
        });
      }
    }

    // =====================================================
    // 3. RICERCA ONLINE DEL VINO
    // =====================================================

    const researchPrompt = `
Sei un assistente specializzato in vini.

Devi cercare informazioni sul seguente vino:

"${wineQuery}"

Cerca sul web e prova a determinare con precisione:

- nome completo
- produttore o cantina
- regione o territorio
- tipologia
- vitigno o uvaggio
- caratteristiche del gusto
- abbinamenti gastronomici
- temperatura di servizio
- occasioni di consumo

Dai priorità, quando disponibili, a:

1. sito ufficiale del produttore;
2. sito ufficiale della cantina;
3. consorzio della denominazione;
4. fonti enologiche affidabili.

IMPORTANTE:

Se l'utente ha scritto soltanto un nome parziale
ma esiste chiaramente un vino corrispondente,
prova comunque ad identificarlo.

NON rifiutare semplicemente perché manca l'annata.

NON parlare di prezzo.

NON inventare informazioni.

Scrivi una breve scheda informativa in italiano.
`;

    let researchResult = "";

    try {
      researchResult = await groqChat({
        model: "groq/compound-mini",

        messages: [
          {
            role: "user",
            content: researchPrompt
          }
        ]
      });
    } catch (error) {
      // Se la ricerca web non è disponibile,
      // continuiamo comunque con il modello.
      researchResult = `
Il vino indicato dal cliente è:
${wineQuery}

Utilizza le tue conoscenze per identificarlo.
Se qualche informazione non è sicura, omettila.
`;
    }

    // =====================================================
    // 4. CREAZIONE DELLA SCHEDA PER LA LANDING
    // =====================================================

    const finalPrompt = `
Sei "Il Sommelier di Famila Sud Italia".

Un cliente del supermercato vuole conoscere rapidamente
le informazioni principali su un vino.

Il vino cercato è:

"${wineQuery}"

Queste sono le informazioni raccolte:

${researchResult}

Devi creare una scheda MOLTO SEMPLICE e utile
per una persona che si trova davanti allo scaffale.

REGOLE IMPORTANTI:

- Se il vino è ragionevolmente identificabile,
  "identified" DEVE essere true.

- Non impostare identified=false
  soltanto perché manca l'annata.

- Non impostare identified=false
  soltanto perché il nome inserito dal cliente è incompleto.

- Se hai identificato produttore e vino,
  considera l'identificazione sufficiente.

- Non inventare dati specifici non supportati.

- Se non conosci un dato, puoi lasciare una stringa vuota.

- Non parlare di prezzi.

- Usa un linguaggio molto semplice.

- NON usare termini tecnici inutili.

- Non scrivere markdown.

Restituisci ESCLUSIVAMENTE un JSON valido.

Deve essere esattamente strutturato così:

{
  "identified": true,
  "name": "Nome completo del vino",
  "producer": "Cantina o produttore",
  "region": "Regione o territorio",
  "type": "Rosso, Bianco, Rosato, Spumante ecc.",
  "grape": "Vitigno principale oppure uvaggio",
  "taste": "Descrizione semplice del gusto in massimo due frasi",
  "pairings": "3-5 abbinamenti consigliati",
  "temperature": "Temperatura ideale di servizio",
  "ideal_for": "Una frase semplice sull'occasione ideale",
  "confidence_note": ""
}

Usa identified=false SOLTANTO se non riesci realmente
a capire quale vino stia cercando il cliente.

In quel caso restituisci:

{
  "identified": false,
  "message": "Non riesco a identificare con certezza questo vino. Prova a inserire anche il nome della cantina oppure fotografa l'etichetta."
}
`;

    const finalResult = await groqChat({
      model: "openai/gpt-oss-20b",

      messages: [
        {
          role: "user",
          content: finalPrompt
        }
      ],

      response_format: {
        type: "json_object"
      },

      temperature: 0.1,
      max_completion_tokens: 1200
    });

    // =====================================================
    // 5. LETTURA DEL JSON
    // =====================================================

    const cleaned = finalResult
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let wine;

    try {
      wine = JSON.parse(cleaned);
    } catch (error) {
      console.error(
        "JSON non valido ricevuto:",
        cleaned
      );

      return res.status(502).json({
        error:
          "Il Sommelier ha restituito una risposta non leggibile. Riprova."
      });
    }

    return res.status(200).json({
      wine
    });

  } catch (error) {
    console.error("Errore Sommelier:", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Si è verificato un errore durante la ricerca del vino."
    });
  }
}
