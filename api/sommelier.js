export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo non consentito" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "La chiave API non è configurata sul server." });
    return;
  }

  const body = req.body || {};
  if (!["name", "image"].includes(body.mode)) {
    res.status(400).json({ error: "Richiesta non valida." });
    return;
  }

  const instructions = `Sei il Sommelier di Famila Sud Italia.
Aiuta un cliente di supermercato a capire rapidamente un vino.

Devi essere prudente: non inventare produttore, vitigno, denominazione o annata.
Se una foto non consente di identificare con ragionevole certezza la bottiglia,
identified deve essere false.

Restituisci SOLO JSON valido, senza markdown, con questa struttura:
{
  "identified": true,
  "name": "nome completo del vino",
  "producer": "cantina/produttore",
  "region": "regione o territorio",
  "type": "rosso/bianco/rosato/spumante/ecc.",
  "grape": "vitigno principale o uvaggio",
  "taste": "massimo due frasi semplici sul gusto",
  "pairings": "3-5 abbinamenti semplici",
  "temperature": "temperatura di servizio",
  "ideal_for": "una frase breve sull'occasione ideale",
  "confidence_note": ""
}

Se non puoi identificarlo:
{
  "identified": false,
  "message": "Non riesco a identificare con certezza questa bottiglia. Prova a fotografare meglio l'etichetta oppure inserisci il nome del vino."
}

Non parlare di prezzo.`;

  const content = [{ type: "input_text", text: instructions }];

  if (body.mode === "name") {
    const name = String(body.name || "").trim();
    if (!name) {
      res.status(400).json({ error: "Inserisci il nome del vino." });
      return;
    }
    content.push({
      type: "input_text",
      text: `Il cliente ha inserito questo nome: ${name}. Identifica il vino e restituisci le informazioni richieste.`
    });
  } else {
    const image = String(body.image || "");
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)) {
      res.status(400).json({ error: "Formato immagine non supportato." });
      return;
    }
    content.push({
      type: "input_text",
      text: "Questa è una foto dell'etichetta. Leggi con attenzione il testo visibile e identifica la bottiglia."
    });
    content.push({
      type: "input_image",
      image_url: image,
      detail: "high"
    });
  }

  try {
    const ai = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [{ role: "user", content }]
      })
    });

    const data = await ai.json();

    if (!ai.ok) {
      res.status(502).json({
        error: data?.error?.message || "Errore del servizio AI."
      });
      return;
    }

    let outputText = "";
    for (const item of data.output || []) {
      if (item.type !== "message") continue;
      for (const part of item.content || []) {
        if (part.type === "output_text") outputText += part.text || "";
      }
    }

    outputText = outputText.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");

    let wine;
    try {
      wine = JSON.parse(outputText);
    } catch {
      res.status(502).json({ error: "La risposta del Sommelier non è leggibile. Riprova." });
      return;
    }

    res.status(200).json({ wine });
  } catch (err) {
    res.status(500).json({ error: "Errore di connessione al servizio AI." });
  }
}
