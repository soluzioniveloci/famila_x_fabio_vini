export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "La chiave GROQ_API_KEY non è configurata su Vercel."
    });
  }

  const body = req.body || {};

  if (!["name", "image"].includes(body.mode)) {
    return res.status(400).json({ error: "Richiesta non valida." });
  }

  async function groq(payload) {
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
      throw new Error(
        data?.error?.message || "Errore durante la richiesta a Groq."
      );
    }

    return data?.choices?.[0]?.message?.content || "";
  }

  try {
    let wineQuery = "";

    // ==========================
    // SCANSIONE ETICHETTA
    // ==========================

    if (body.mode === "image") {
      const image = String(body.image || "");

      if (
        !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)
      ) {
        return res.status(400).json({
          error: "Formato immagine non supportato."
        });
      }

      const visionResult = await groq({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `
Osserva attentamente questa etichetta di vino.

Cerca di identificare:
- nome del vino
- produttore o cantina
- denominazione
- eventuale annata
- regione o territorio

NON inventare informazioni.

Se non riesci a identificare con sufficiente certezza
la bottiglia, rispondi soltanto:

NON_IDENTIFICATO

Altrimenti rispondi con una sola riga contenente
le informazioni che riesci a leggere.
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
        max_completion_tokens: 500
      });

      if (
        !visionResult ||
        visionResult.toUpperCase().includes("NON_IDENTIFICATO")
      ) {
        return res.status(200).json({
          wine: {
            identified: false,
            message:
              "Non riesco a identificare con certezza questa bottiglia. Prova a fotografare meglio l'etichetta oppure inserisci il nome del vino."
          }
        });
      }

      wineQuery = visionResult.trim();
    }

    // ==========================
    // RICERCA PER NOME
    // ==========================

    if (body.mode === "name") {
      wineQuery = String(body.name || "").trim();

      if (!wineQuery) {
        return res.status(400).json({
          error: "Inserisci il nome del vino."
        });
      }
    }

    // ==========================
    // SOMMELIER
    // ==========================

    const prompt = `
Sei il Sommelier digitale di Famila Sud Italia.

Il cliente vuole informazioni su questo vino:

"${wineQuery}"

Fornisci SOLO le informazioni più importanti
per un cliente di supermercato.

Devi essere prudente.

NON inventare:
- produttore
- vitigno
- denominazione
- annata
- territorio

Se non sei sufficientemente sicuro
dell'identificazione del vino,
imposta "identified" su false.

NON parlare del prezzo.

Rispondi ESCLUSIVAMENTE con JSON valido.
Niente markdown.
Niente testo prima o dopo.

Usa esattamente questa struttura:

{
  "identified": true,
  "name": "Nome completo del vino",
  "producer": "Cantina o produttore",
  "region": "Regione o territorio",
  "type": "Rosso, Bianco, Rosato, Spumante ecc.",
  "grape": "Vitigno principale o uvaggio",
  "taste": "Descrizione semplice del gusto in massimo due frasi",
  "pairings": "3-5 abbinamenti consigliati",
  "temperature": "Temperatura ideale di servizio",
  "ideal_for": "Occasione ideale per bere questo vino"
}

Se non riesci a identificarlo:

{
  "identified": false,
  "message": "Non riesco a identificare con certezza questo vino. Prova a inserire il nome completo o a fotografare meglio l'etichetta."
}
`;

    const result = await groq({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_completion_tokens: 1200
    });

    const cleaned = result
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let wine;

    try {
      wine = JSON.parse(cleaned);
    } catch (error) {
      return res.status(502).json({
        error:
          "Il Sommelier ha restituito una risposta non leggibile. Riprova."
      });
    }

    return res.status(200).json({ wine });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        error?.message ||
        "Errore durante la connessione al Sommelier AI."
    });
  }
}
