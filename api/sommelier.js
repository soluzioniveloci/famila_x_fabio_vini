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
  const mode = body.mode;

  if (!["name", "ean"].includes(mode)) {
    return res.status(400).json({ error: "Richiesta non valida." });
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
      console.error("Errore Groq:", data);
      throw new Error(
        data?.error?.message || "Errore durante la richiesta al Sommelier AI."
      );
    }

    return data?.choices?.[0]?.message?.content || "";
  }

  try {
    let query = "";
    let ean = "";

    if (mode === "ean") {
      ean = String(body.ean || "").replace(/\D/g, "");

      if (!/^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/.test(ean)) {
        return res.status(400).json({
          error: "Codice EAN/UPC non valido."
        });
      }

      query = `codice a barre EAN/UPC ${ean}`;
    }

    if (mode === "name") {
      query = String(body.name || "").trim();

      if (!query) {
        return res.status(400).json({
          error: "Inserisci il nome del vino."
        });
      }
    }

    const researchPrompt =
      mode === "ean"
      ? `
Cerca sul web ESATTAMENTE questo codice a barre di una bottiglia di vino:

${ean}

L'obiettivo è capire a quale prodotto/vino appartiene il codice.

Cerca il numero esatto, anche racchiuso tra virgolette.
Prova anche eventuali pagine di prodotto, cataloghi, ecommerce, siti del produttore,
database pubblici di prodotti, schede vino e risultati indicizzati.

Se trovi una corrispondenza affidabile, ricava:
- nome completo del vino
- produttore/cantina
- regione o territorio
- tipologia
- vitigno o uvaggio
- gusto/caratteristiche
- abbinamenti
- temperatura di servizio

Se trovi più prodotti diversi con lo stesso risultato o non hai una corrispondenza
ragionevolmente affidabile, dichiaralo chiaramente.

Non inventare e non parlare di prezzo.
`
      : `
Cerca sul web informazioni affidabili sul seguente vino:

"${query}"

Privilegia sito del produttore/cantina, consorzio della denominazione e fonti
enologiche affidabili.

Ricava:
- nome completo
- produttore
- regione/territorio
- tipologia
- vitigno/uvaggio
- gusto
- abbinamenti
- temperatura di servizio

Non inventare e non parlare di prezzo.
`;

    let researchResult = "";

    try {
      researchResult = await groqChat({
        model: "groq/compound-mini",
        messages: [{ role: "user", content: researchPrompt }]
      });
    } catch (error) {
      console.error("Ricerca web non disponibile:", error);
      researchResult = "";
    }

    const finalPrompt = `
Sei "Il Sommelier di Famila Sud Italia".

Richiesta del cliente:
${mode === "ean" ? `Codice EAN/UPC: ${ean}` : `Vino: ${query}`}

Risultati della ricerca web:
${researchResult || "Nessun risultato web utilizzabile."}

Devi creare una scheda molto semplice per un cliente di supermercato.

REGOLE:
- Per una ricerca EAN/UPC, identified=true SOLO se i risultati collegano il codice
  a un vino/prodotto con ragionevole affidabilità.
- Se il codice non permette di risalire al prodotto, identified=false.
- Per una ricerca per nome, identified=true se il vino è ragionevolmente riconoscibile.
- Non inventare dati.
- Non parlare di prezzo.
- Se un dato non è noto, usa una stringa vuota.
- Rispondi SOLO con JSON valido, senza markdown.

Formato se identificato:
{
  "identified": true,
  "ean": "${ean}",
  "name": "Nome completo del vino",
  "producer": "Cantina o produttore",
  "region": "Regione o territorio",
  "type": "Rosso, Bianco, Rosato, Spumante ecc.",
  "grape": "Vitigno principale o uvaggio",
  "taste": "Descrizione semplice del gusto in massimo due frasi",
  "pairings": "3-5 abbinamenti consigliati",
  "temperature": "Temperatura ideale di servizio",
  "ideal_for": "Occasione ideale",
  "confidence_note": ""
}

Formato se non identificato:
{
  "identified": false,
  "message": "Non riesco a collegare con certezza questo codice a un vino. Prova a cercare il vino per nome."
}
`;

    const finalResult = await groqChat({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: finalPrompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_completion_tokens: 1200
    });

    const cleaned = finalResult
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let wine;

    try {
      wine = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({
        error: "Il Sommelier ha restituito una risposta non leggibile. Riprova."
      });
    }

    if (mode === "ean" && wine.identified) {
      wine.ean = ean;
    }

    return res.status(200).json({ wine });

  } catch (error) {
    console.error("Errore Sommelier:", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Si è verificato un errore durante la ricerca del vino."
    });
  }
}
