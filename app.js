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

function val(value) {
  const text = String(value || "").trim();
  return text || "—";
}

function cleanCode(value) {
  return String(value || "")
    .replace(/\D/g, "");
}

function validEAN(value) {
  return (
    /^[0-9]{8}$/.test(value) ||
    /^[0-9]{12}$/.test(value) ||
    /^[0-9]{13}$/.test(value) ||
    /^[0-9]{14}$/.test(value)
  );
}

function showError(title, text) {
  $("errorTitle").textContent =
    title || "Si è verificato un problema";

  $("errorText").textContent =
    text || "Riprova tra qualche secondo.";

  show(errorBox);
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
  ]
    .map(x => String(x || "").trim())
    .filter(Boolean);

  [...new Set(values)].forEach(value => {
    const tag =
      document.createElement("span");

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

  const raw =
    String(value || "").trim();

  const items =
    raw
      .split(/,|;|\n|•/)
      .map(x => x.trim())
      .filter(Boolean);

  if (
    items.length < 2 ||
    items.length > 8
  ) {
    fallback.textContent = val(raw);
    fallback.classList.remove("hidden");
    return;
  }

  fallback.classList.add("hidden");

  items
    .slice(0, 6)
    .forEach(item => {
      const chip =
        document.createElement("span");

      chip.className = "chip";
      chip.textContent = item;

      chips.appendChild(chip);
    });
}


/* =========================================================
   CARICAMENTO IMMAGINE
========================================================= */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(
        new Error(
          "Non riesco a leggere la fotografia."
        )
      );
    };

    reader.onload = () => {
      const img = new Image();

      img.onload = () =>
        resolve(img);

      img.onerror = () => {
        reject(
          new Error(
            "Non riesco ad elaborare la fotografia."
          )
        );
      };

      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}


/* =========================================================
   COMPRESSIONE FOTO

   Questa è la parte importante.

   Foto iPhone:
   3000/4000 px -> massimo 1200 px

   Poi:
   JPEG -> qualità ridotta automaticamente.

   Obiettivo:
   Base64 inferiore a circa 1.4 MB.
========================================================= */

async function compressImage(file) {
  const img =
    await loadImage(file);

  let width =
    img.naturalWidth || img.width;

  let height =
    img.naturalHeight || img.height;

  const MAX_SIDE = 1200;

  if (
    width > MAX_SIDE ||
    height > MAX_SIDE
  ) {
    const ratio =
      Math.min(
        MAX_SIDE / width,
        MAX_SIDE / height
      );

    width =
      Math.round(
        width * ratio
      );

    height =
      Math.round(
        height * ratio
      );
  }

  let canvas =
    document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  let ctx =
    canvas.getContext(
      "2d",
      {
        alpha: false
      }
    );

  if (!ctx) {
    throw new Error(
      "Il browser non riesce ad elaborare la fotografia."
    );
  }

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
   * TARGET estremamente prudente.
   *
   * Evitiamo di avvicinarci ai limiti
   * del backend/Groq.
   */
  const TARGET_LENGTH =
    1400000;

  let quality = 0.78;

  let dataUrl =
    canvas.toDataURL(
      "image/jpeg",
      quality
    );


  /*
   * Prima abbassiamo la qualità.
   */
  while (
    dataUrl.length >
      TARGET_LENGTH &&
    quality > 0.48
  ) {
    quality -= 0.08;

    dataUrl =
      canvas.toDataURL(
        "image/jpeg",
        quality
      );
  }


  /*
   * Se ancora troppo grande,
   * riduciamo fisicamente l'immagine.
   */
  while (
    dataUrl.length >
      TARGET_LENGTH &&
    canvas.width > 700 &&
    canvas.height > 700
  ) {
    const oldCanvas =
      canvas;

    const newWidth =
      Math.round(
        oldCanvas.width * 0.82
      );

    const newHeight =
      Math.round(
        oldCanvas.height * 0.82
      );

    canvas =
      document.createElement(
        "canvas"
      );

    canvas.width = newWidth;
    canvas.height = newHeight;

    ctx =
      canvas.getContext(
        "2d",
        {
          alpha: false
        }
      );

    ctx.fillStyle =
      "#ffffff";

    ctx.fillRect(
      0,
      0,
      newWidth,
      newHeight
    );

    ctx.drawImage(
      oldCanvas,
      0,
      0,
      newWidth,
      newHeight
    );

    dataUrl =
      canvas.toDataURL(
        "image/jpeg",
        0.62
      );
  }


  if (
    dataUrl.length >
    1800000
  ) {
    throw new Error(
      "La fotografia è ancora troppo pesante. Avvicinati all'etichetta e riprova."
    );
  }

  return dataUrl;
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
   CHIAMATA API
========================================================= */

async function ask(payload) {
  await stopScanner();

  show(loading);


  if (
    payload.mode === "ean"
  ) {
    $("loadingTitle").textContent =
      `Sto verificando il codice ${payload.ean}…`;

    $("loadingText").textContent =
      "Identifico il prodotto, verifico che sia un vino e raccolgo le informazioni più utili.";
  } else {
    $("loadingTitle").textContent =
      "Sto analizzando la bottiglia…";

    $("loadingText").textContent =
      "Leggo l'etichetta, verifico che sia realmente un vino e approfondisco le informazioni.";
  }


  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      45000
    );


  try {
    const response =
      await fetch(
        "/api/sommelier",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(payload),

          signal:
            controller.signal
        }
      );


    clearTimeout(timeout);


    const raw =
      await response.text();

    let data = {};

    try {
      data =
        raw
          ? JSON.parse(raw)
          : {};
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


    const wine =
      data.wine || {};


    /* =====================================================
       NON VINO
    ===================================================== */

    if (
      wine.non_wine === true
    ) {
      $("nonWineText").textContent =
        wine.message ||
        "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini.";

      show(nonWine);

      return;
    }


    /* =====================================================
       NON IDENTIFICATO
    ===================================================== */

    if (
      wine.identified !== true
    ) {
      showError(
        "Non riesco a identificarlo con certezza",
        wine.message ||
        "Prova con una foto più chiara oppure scansiona il codice a barre."
      );

      return;
    }


    /* =====================================================
       VINO
    ===================================================== */

    $("resultName").textContent =
      val(wine.name);

    $("resultProducer").textContent =
      val(wine.producer);

    $("resultCode").textContent =
      wine.ean
        ? `EAN / UPC ${wine.ean}`
        : "";


    renderTags(wine);


    $("resultTaste").textContent =
      val(wine.taste);


    renderPairings(
      wine.pairings
    );


    $("resultTemp").textContent =
      val(
        wine.temperature
      );


    $("resultIdeal").textContent =
      val(
        wine.ideal_for
      );


    $("resultValue").textContent =
      val(
        wine.value_story
      );


    const uncertain =
      $("uncertain");


    if (uncertain) {
      if (
        wine.confidence_note
      ) {
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
    clearTimeout(timeout);

    console.error(
      "Sommelier frontend:",
      error
    );


    if (
      error?.name ===
      "AbortError"
    ) {
      showError(
        "La ricerca sta impiegando troppo tempo",
        "Riprova tra qualche secondo."
      );

      return;
    }


    showError(
      "Si è verificato un problema",
      error?.message ||
      "Riprova tra qualche secondo."
    );
  }
}


/* =========================================================
   AVVIO SCANNER EAN
========================================================= */

async function startScanner() {
  alreadyRead = false;

  show(scannerView);


  if (
    typeof Html5Qrcode ===
    "undefined"
  ) {
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
        facingMode:
          "environment"
      },

      {
        fps: 12,

        qrbox: (
          width,
          height
        ) => ({
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

        aspectRatio:
          1.777778
      },


      async decodedText => {
        if (alreadyRead) {
          return;
        }


        const ean =
          cleanCode(
            decodedText
          );


        if (
          !validEAN(ean)
        ) {
          return;
        }


        alreadyRead = true;


        if (
          navigator.vibrate
        ) {
          navigator.vibrate(
            80
          );
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
      "Scanner:",
      error
    );


    showError(
      "Non riesco ad aprire la fotocamera",
      "Consenti l'accesso alla fotocamera nel browser e riprova."
    );
  }
}


/* =========================================================
   EVENTI SCANNER
========================================================= */

$("scanButton")
  ?.addEventListener(
    "click",
    startScanner
  );


$("closeScanner")
  ?.addEventListener(
    "click",
    async () => {
      await stopScanner();
      show(home);
    }
  );


/* =========================================================
   FOTO
========================================================= */

$("photoButton")
  ?.addEventListener(
    "click",
    () => {
      const input =
        $("photoInput");

      if (!input) return;

      /*
       * Permette di rifare anche
       * la stessa fotografia.
       */
      input.value = "";

      input.click();
    }
  );


$("photoInput")
  ?.addEventListener(
    "change",
    async event => {

      const file =
        event.target.files?.[0];


      if (!file) {
        return;
      }


      /*
       * Limite sul file ORIGINALE.
       * Verrà comunque compresso.
       */
      if (
        file.size >
        30 * 1024 * 1024
      ) {
        showError(
          "Foto troppo grande",
          "Scatta nuovamente la fotografia."
        );

        return;
      }


      try {
        show(loading);

        $("loadingTitle").textContent =
          "Sto preparando la fotografia…";

        $("loadingText").textContent =
          "Ottimizzo l'immagine per leggere meglio la bottiglia e l'etichetta.";


        const compressed =
          await compressImage(
            file
          );


        console.log(
          "Foto compressa:",
          Math.round(
            compressed.length /
            1024
          ),
          "KB base64"
        );


        await ask({
          mode: "image",
          image: compressed
        });

      } catch (error) {
        console.error(
          "Foto:",
          error
        );


        showError(
          "Non riesco ad elaborare la fotografia",
          error?.message ||
          "Prova a scattare nuovamente la foto."
        );
      }
    }
  );


/* =========================================================
   EAN MANUALE
========================================================= */

$("eanForm")
  ?.addEventListener(
    "submit",
    event => {

      event.preventDefault();


      const ean =
        cleanCode(
          $("eanInput")?.value
        );


      if (
        !validEAN(ean)
      ) {
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
   RITORNO
========================================================= */

$("backButton")
  ?.addEventListener(
    "click",
    () => show(home)
  );


$("retryButton")
  ?.addEventListener(
    "click",
    () => show(home)
  );


$("nonWineRetry")
  ?.addEventListener(
    "click",
    () => show(home)
  );


/* =========================================================
   STOP CAMERA QUANDO L'APP VA IN BACKGROUND
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
