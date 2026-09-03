const $ = id => document.getElementById(id);

const home = $("home");
const scannerView = $("scannerView");
const loading = $("loading");
const result = $("result");
const nonWine = $("nonWine");
const errorBox = $("error");

let html5QrCode = null;
let scannerRunning = false;
let alreadyRead = false;

/* =========================================================
   NAVIGAZIONE
========================================================= */

function hideAll() {
  [
    home,
    scannerView,
    loading,
    result,
    nonWine,
    errorBox
  ]
    .filter(Boolean)
    .forEach(el => el.classList.add("hidden"));
}

function show(el) {
  hideAll();

  if (el) {
    el.classList.remove("hidden");
  }

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

/* =========================================================
   UTILITY
========================================================= */

function val(v) {
  return v && String(v).trim()
    ? String(v).trim()
    : "—";
}

function cleanCode(v) {
  return String(v || "").replace(/\D/g, "");
}

function validEAN(v) {
  return (
    /^[0-9]{8}$/.test(v) ||
    /^[0-9]{12}$/.test(v) ||
    /^[0-9]{13}$/.test(v) ||
    /^[0-9]{14}$/.test(v)
  );
}

/* =========================================================
   TAG RISULTATO
========================================================= */

function renderTags(wine) {
  const container = $("resultTags");

  if (!container) return;

  container.innerHTML = "";

  const values = [
    wine.type,
    wine.region,
    wine.grape
  ].filter(Boolean);

  [...new Set(values)].forEach(value => {
    const tag = document.createElement("span");

    tag.className = "tag";
    tag.textContent = value;

    container.appendChild(tag);
  });
}

/* =========================================================
   ABBINAMENTI
========================================================= */

function renderPairings(value) {
  const chips = $("pairingChips");
  const fallback = $("resultPairings");

  if (!chips || !fallback) return;

  chips.innerHTML = "";

  const raw = String(value || "").trim();

  const items = raw
    .split(/,|;|\n|•/)
    .map(x => x.trim())
    .filter(Boolean);

  if (items.length < 2 || items.length > 8) {
    fallback.textContent = val(raw);
    fallback.classList.remove("hidden");
    return;
  }

  fallback.classList.add("hidden");

  items.slice(0, 6).forEach(item => {
    const chip = document.createElement("span");

    chip.className = "chip";
    chip.textContent = item;

    chips.appendChild(chip);
  });
}

/* =========================================================
   ERRORE
========================================================= */

function showError(title, message) {
  if ($("errorTitle")) {
    $("errorTitle").textContent =
      title || "Si è verificato un problema";
  }

  if ($("errorText")) {
    $("errorText").textContent =
      message || "Riprova tra qualche secondo.";
  }

  show(errorBox);
}

/* =========================================================
   COMPRESSIONE FOTO

   IMPORTANTE:
   la foto NON viene inviata nelle dimensioni originali
   dell'iPhone.

   Viene:
   - ridimensionata
   - convertita JPEG
   - compressa
========================================================= */

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(
        new Error("Non riesco a leggere la fotografia.")
      );
    };

    reader.onload = event => {
      const img = new Image();

      img.onerror = () => {
        reject(
          new Error("Non riesco ad elaborare la fotografia.")
        );
      };

      img.onload = () => {
        /*
         * 1280 px sono più che sufficienti
         * per leggere una normale etichetta,
         * evitando richieste enormi.
         */

        const MAX_SIZE = 1280;

        let width = img.width;
        let height = img.height;

        if (width > height && width > MAX_SIZE) {
          height = Math.round(
            height * (MAX_SIZE / width)
          );

          width = MAX_SIZE;
        } else if (
          height >= width &&
          height > MAX_SIZE
        ) {
          width = Math.round(
            width * (MAX_SIZE / height)
          );

          height = MAX_SIZE;
        }

        const canvas =
          document.createElement("canvas");

        canvas.width = width;
        canvas.height = height;

        const ctx =
          canvas.getContext("2d");

        if (!ctx) {
          reject(
            new Error(
              "Il browser non riesce ad elaborare la fotografia."
            )
          );
          return;
        }

        /*
         * Sfondo bianco:
         * evita problemi nel caso di immagini
         * con trasparenza.
         */

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(
          0,
          0,
          width,
          height
        );

        ctx.drawImage(
          img,
          0,
          0,
          width,
          height
        );

        /*
         * JPEG qualità 0.72.
         *
         * Abbastanza nitido per l'etichetta,
         * ma molto più leggero dell'originale.
         */

        let compressed =
          canvas.toDataURL(
            "image/jpeg",
            0.72
          );

        /*
         * Seconda sicurezza.
         *
         * Se per qualche motivo il risultato
         * è ancora troppo grande, riduciamo
         * ulteriormente la qualità.
         */

        if (compressed.length > 1800000) {
          compressed =
            canvas.toDataURL(
              "image/jpeg",
              0.55
            );
        }

        resolve(compressed);
      };

      img.src = event.target.result;
    };

    reader.readAsDataURL(file);
  });
}

/* =========================================================
   CHIAMATA AL SOMMELIER
========================================================= */

async function ask(payload) {
  await stopScanner();

  show(loading);

  if ($("loadingTitle")) {
    $("loadingTitle").textContent =
      payload.mode === "ean"
        ? `Sto verificando il codice ${payload.ean}…`
        : "Sto analizzando la bottiglia…";
  }

  if ($("loadingText")) {
    $("loadingText").textContent =
      payload.mode === "ean"
        ? "Sto identificando il prodotto e verificando che si tratti realmente di un vino."
        : "Sto leggendo l'etichetta e verificando che il prodotto sia realmente un vino.";
  }

  try {
    const response = await fetch(
      "/api/sommelier",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify(payload)
      }
    );

    /*
     * Non assumiamo che Vercel restituisca
     * sempre JSON.
     */

    const raw = await response.text();

    let data = {};

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      console.error(
        "Risposta API non JSON:",
        raw
      );

      throw new Error(
        "Il servizio non ha restituito una risposta valida."
      );
    }

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Si è verificato un problema durante la ricerca."
      );
    }

    const wine = data.wine || {};

    /* -----------------------------------------------------
       NON È VINO
    ----------------------------------------------------- */

    if (
      wine.non_wine === true ||
      wine.is_wine === false
    ) {
      if ($("nonWineText")) {
        $("nonWineText").textContent =
          wine.message ||
          "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini.";
      }

      show(nonWine);
      return;
    }

    /* -----------------------------------------------------
       NON IDENTIFICATO
    ----------------------------------------------------- */

    if (!wine.identified) {
      showError(
        "Non riesco a identificarlo con certezza",
        wine.message ||
        "Prova con una foto più chiara oppure scansiona il codice a barre."
      );

      return;
    }

    /* -----------------------------------------------------
       RISULTATO VINO
    ----------------------------------------------------- */

    if ($("resultName")) {
      $("resultName").textContent =
        val(wine.name);
    }

    if ($("resultProducer")) {
      $("resultProducer").textContent =
        val(wine.producer);
    }

    if ($("resultCode")) {
      $("resultCode").textContent =
        wine.ean
          ? `EAN / UPC ${wine.ean}`
          : "";
    }

    renderTags(wine);

    if ($("resultTaste")) {
      $("resultTaste").textContent =
        val(wine.taste);
    }

    renderPairings(wine.pairings);

    if ($("resultTemp")) {
      $("resultTemp").textContent =
        val(wine.temperature);
    }

    if ($("resultIdeal")) {
      $("resultIdeal").textContent =
        val(wine.ideal_for);
    }

    if ($("resultValue")) {
      $("resultValue").textContent =
        val(wine.value_story);
    }

    const uncertain = $("uncertain");

    if (uncertain) {
      if (wine.confidence_note) {
        uncertain.textContent =
          wine.confidence_note;

        uncertain.classList.remove(
          "hidden"
        );
      } else {
        uncertain.classList.add(
          "hidden"
        );
      }
    }

    show(result);

  } catch (error) {
    console.error(
      "Sommelier frontend:",
      error
    );

    showError(
      "Si è verificato un problema",
      error?.message ||
      "Riprova tra qualche secondo."
    );
  }
}

/* =========================================================
   SCANNER EAN
========================================================= */

async function startScanner() {
  alreadyRead = false;

  show(scannerView);

  if (typeof Html5Qrcode === "undefined") {
    showError(
      "Scanner non disponibile",
      "Non riesco a caricare lo scanner. Ricarica la pagina e riprova."
    );

    return;
  }

  html5QrCode =
    new Html5Qrcode(
      "reader",
      {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128
        ],

        verbose: false
      }
    );

  try {
    await html5QrCode.start(
      {
        facingMode: "environment"
      },

      {
        fps: 12,

        qrbox: (width, height) => ({
          width:
            Math.floor(
              width * 0.88
            ),

          height:
            Math.floor(
              Math.min(
                150,
                height * 0.30
              )
            )
        }),

        aspectRatio: 1.777778
      },

      async decodedText => {
        if (alreadyRead) return;

        const ean =
          cleanCode(decodedText);

        if (!validEAN(ean)) {
          return;
        }

        alreadyRead = true;

        if (navigator.vibrate) {
          navigator.vibrate(80);
        }

        await ask({
          mode: "ean",
          ean
        });
      },

      () => {}
    );

    scannerRunning = true;

  } catch (error) {
    scannerRunning = false;

    console.error(
      "Errore scanner:",
      error
    );

    showError(
      "Non riesco ad aprire la fotocamera",
      "Consenti l'accesso alla fotocamera nel browser e riprova."
    );
  }
}

/* =========================================================
   STOP SCANNER
========================================================= */

async function stopScanner() {
  if (
    html5QrCode &&
    scannerRunning
  ) {
    try {
      await html5QrCode.stop();
    } catch {}

    scannerRunning = false;
  }

  if (html5QrCode) {
    try {
      html5QrCode.clear();
    } catch {}

    html5QrCode = null;
  }
}

/* =========================================================
   EVENTI
========================================================= */

$("scanButton")?.addEventListener(
  "click",
  startScanner
);

$("closeScanner")?.addEventListener(
  "click",
  async () => {
    await stopScanner();
    show(home);
  }
);

/* =========================================================
   FOTO
========================================================= */

$("photoButton")?.addEventListener(
  "click",
  () => {
    const input = $("photoInput");

    if (!input) return;

    /*
     * Consente di fotografare di nuovo
     * anche lo stesso soggetto.
     */

    input.value = "";
    input.click();
  }
);

$("photoInput")?.addEventListener(
  "change",
  async event => {
    const file =
      event.target.files?.[0];

    if (!file) return;

    /*
     * Accettiamo anche foto originali grandi.
     * Verranno compresse prima dell'invio.
     */

    if (file.size > 25 * 1024 * 1024) {
      showError(
        "Foto troppo grande",
        "Usa una fotografia inferiore a 25 MB."
      );

      return;
    }

    try {
      show(loading);

      if ($("loadingTitle")) {
        $("loadingTitle").textContent =
          "Sto preparando la fotografia…";
      }

      if ($("loadingText")) {
        $("loadingText").textContent =
          "Ottimizzo l'immagine per riconoscere meglio l'etichetta.";
      }

      const compressedImage =
        await compressImage(file);

      /*
       * Protezione finale.
       */

      if (
        !compressedImage ||
        compressedImage.length > 2500000
      ) {
        throw new Error(
          "La fotografia è ancora troppo grande. Prova ad avvicinarti all'etichetta e scattare nuovamente."
        );
      }

      await ask({
        mode: "image",
        image: compressedImage
      });

    } catch (error) {
      console.error(
        "Compressione fotografia:",
        error
      );

      showError(
        "Non riesco ad elaborare la fotografia",
        error?.message ||
        "Scatta nuovamente la foto e riprova."
      );
    }
  }
);

/* =========================================================
   INSERIMENTO MANUALE EAN
========================================================= */

$("eanForm")?.addEventListener(
  "submit",
  event => {
    event.preventDefault();

    const ean =
      cleanCode(
        $("eanInput")?.value
      );

    if (!validEAN(ean)) {
      showError(
        "Codice non valido",
        "Inserisci un codice EAN / UPC valido."
      );

      return;
    }

    ask({
      mode: "ean",
      ean
    });
  }
);

/* =========================================================
   PULSANTI RITORNO
========================================================= */

$("backButton")?.addEventListener(
  "click",
  () => show(home)
);

$("retryButton")?.addEventListener(
  "click",
  () => show(home)
);

$("nonWineRetry")?.addEventListener(
  "click",
  () => show(home)
);

/* =========================================================
   TELEFONO IN BACKGROUND
========================================================= */

document.addEventListener(
  "visibilitychange",
  async () => {
    if (
      document.hidden &&
      scannerRunning
    ) {
      await stopScanner();
    }
  }
);
