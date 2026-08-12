# Famila Sommelier

Questa versione è pronta per essere caricata su GitHub e poi pubblicata con Vercel.

## File da caricare nel repository GitHub

- index.html
- styles.css
- app.js
- vercel.json
- cartella api
  - sommelier.js

## Perché Vercel e non GitHub Pages

GitHub Pages pubblica solo file statici. La chiave OpenAI non può essere messa nel browser.
Vercel esegue `api/sommelier.js` sul server, quindi la chiave resta segreta.

## Dopo GitHub

1. Accedi a Vercel.
2. Importa il repository `famila-sommelier`.
3. Nelle Environment Variables crea:
   OPENAI_API_KEY = la tua chiave OpenAI
4. Premi Deploy.
5. Vercel ti darà un indirizzo HTTPS.
6. Apri quell'indirizzo dal telefono.
7. Prova prima la ricerca per nome, poi la scansione dell'etichetta.

Il QR definitivo dovrà puntare all'indirizzo Vercel (o a un dominio personalizzato).
