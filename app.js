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
   UTILITÀ
========================================================= */

function val(v) {
  return v && String(v).trim()
    ? String(v).trim()
    : "—";
}

function code(v) {
  return String(v || "")
    .replace(/\D/g, "");
}

function valid(v) {
  return (
    /^[0-9]{8}$/.test(v) ||
    /^[0-9]{12}$/.test(v) ||
    /^[0-9]{13}$/.test(v) ||
    /^[0-9]{14}$/.test(v)
  );
}


/* =========================================================
   TAG DEL VINO
========================================================= */

function tags(w) {

  const target = $("resultTags");

  if (!target) return;

  target.innerHTML = "";

  const values = [
    w.type,
    w.region,
    w.grape
  ]
    .filter(Boolean)
    .map(v => String(v).trim())
    .filter(Boolean);

  [...new Set(values)]
    .forEach(text => {

      const tag = document.createElement("span");

      tag.className = "tag";
      tag.textContent = text;

      target.appendChild(tag);
    });
}


/* =========================================================
   ABBINAMENTI
========================================================= */

function pairings(v) {

  const chips = $("pairingChips");
  const fallback = $("resultPairings");

  if (!chips || !fallback) return;

  chips.innerHTML = "";

  const raw =
    String(v || "").trim();

  const items =
    raw
      .split(/,|;|\n|•/)
      .map(x => x.trim())
      .filter(Boolean);

  if (
    items.length < 2 ||
    items.length > 8
  ) {

    fallback.textContent =
      val(raw);

    fallback.classList.remove(
      "hidden"
    );

    return;
  }

  fallback.classList.add(
    "hidden"
  );

  items
    .slice(0, 6)
    .forEach(item => {

      const chip =
        document.createElement(
          "span"
        );

      chip.className = "chip";
      chip.textContent = item;

      chips.appendChild(chip);
    });
}


/* =========================================================
   COMPRESSIONE FOTO
========================================================= */

function loadImageFromFile(file) {

  return new Promise(
    (resolve, reject) => {

      const reader =
        new FileReader();

      reader.onload = () => {

        const img =
          new Image();

        img.onload = () =>
          resolve(img);

        img.onerror = () =>
          reject(
            new Error(
              "Non riesco a leggere questa fotografia."
            )
          );

        img.src =
          reader.result;
      };

      reader.onerror = () =>
        reject(
          new Error(
            "Errore durante la lettura della fotografia."
          )
        );

      reader.readAsDataURL(file);
    }
  );
}


async function compressImage(file) {

  const img =
    await loadImageFromFile(
      file
    );

  /*
   * 1280px sono più che sufficienti
   * per leggere etichette e bottiglie.
   */
  const MAX_SIDE = 1280;

  let width =
    img.naturalWidth ||
    img.width;

  let height =
    img.naturalHeight ||
    img.height;

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


  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext(
      "2d",
      {
        alpha: false
      }
    );

  /*
   * Sfondo bianco:
   * evita problemi con trasparenze.
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


  let quality = 0.80;

  let dataUrl =
    canvas.toDataURL(
      "image/jpeg",
      quality
    );


  /*
   * Teniamoci MOLTO sotto i 4 MB
   * richiesti da Groq.
   *
   * Base64 ~ 1,33 volte i byte reali.
   */
  const TARGET =
    2.7 * 1024 * 1024;


  while (
    dataUrl.length > TARGET &&
    quality > 0.45
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
   * ridimensioniamo una seconda volta.
   */
  if (
    dataUrl.length > TARGET
  ) {

    const smaller =
      document.createElement(
        "canvas"
      );

    smaller.width =
      Math.round(
        width * 0.75
      );

    smaller.height =
      Math.round(
        height * 0.75
      );

    const sctx =
      smaller.getContext(
        "2d",
        {
          alpha: false
        }
      );

    sctx.fillStyle =
      "#ffffff";

    sctx.fillRect(
      0,
      0,
      smaller.width,
      smaller.height
    );

    sctx.drawImage(
      canvas,
      0,
      0,
      smaller.width,
      smaller.height
    );

    dataUrl =
      smaller.toDataURL(
        "image/jpeg",
        0.70
      );
  }


  return dataUrl;
}


/* =========================================================
   RICHIESTA AL SOMMELIER
========================================================= */

async function ask(payload) {

  await stop();

  show(loading);


  if (
    payload.mode === "ean"
  ) {

    $("loadingTitle").textContent =
      "Sto verificando il codice " +
      payload.ean +
      "…";

    $("loadingText").textContent =
      "Identifico il prodotto, verifico che sia un vino e raccolgo le informazioni più utili.";

  } else {

    $("loadingTitle").textContent =
      "Sto analizzando la bottiglia…";

    $("loadingText").textContent =
      "Verifico prima che il prodotto sia realmente un vino, poi approfondisco le informazioni.";
  }


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
            JSON.stringify(
              payload
            )
        }
      );


    let data = {};

    try {

      data =
        await response.json();

    } catch {

      throw new Error(
        "Il servizio non ha restituito una risposta valida."
      );
    }


    if (!response.ok) {

      throw new Error(
        data.error ||
        "Errore del servizio."
      );
    }


    const w =
      data.wine || {};


    /*
     * =============================
     * NON VINO CERTO
     * =============================
     */

    if (
      w.non_wine === true
    ) {

      $("nonWineText")
        .textContent =
          w.message ||
          "Il prodotto identificato non è un vino. Il Sommelier Virtuale è dedicato esclusivamente ai vini.";

      show(nonWine);

      return;
    }


    /*
     * =============================
     * NON IDENTIFICATO
     * =============================
     */

    if (
      w.identified !== true
    ) {

      $("errorTitle")
        .textContent =
          "Non riesco a identificarlo con certezza";

      $("errorText")
        .textContent =
          w.message ||
          "Prova con una foto più chiara oppure scansiona il codice a barre.";

      show(errorBox);

      return;
    }


    /*
     * =============================
     * RISULTATO VINO
     * =============================
     */

    $("resultName")
      .textContent =
        val(w.name);

    $("resultProducer")
      .textContent =
        val(w.producer);

    $("resultCode")
      .textContent =
        w.ean
          ? "EAN / UPC " + w.ean
          : "";


    tags(w);


    $("resultTaste")
      .textContent =
        val(w.taste);


    pairings(
      w.pairings
    );


    $("resultTemp")
      .textContent =
        val(
          w.temperature
        );


    $("resultIdeal")
      .textContent =
        val(
          w.ideal_for
        );


    $("resultValue")
      .textContent =
        val(
          w.value_story
        );


    const uncertain =
      $("uncertain");


    if (uncertain) {

      if (
        w.confidence_note
      ) {

        uncertain.textContent =
          w.confidence_note;

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
      error
    );


    $("errorTitle")
      .textContent =
        "Si è verificato un problema";


    $("errorText")
      .textContent =
        error.message ||
        "Riprova tra qualche secondo.";


    show(errorBox);
  }
}


/* =========================================================
   SCANNER EAN
========================================================= */

async function start() {

  alreadyRead = false;

  show(scannerView);


  if (
    typeof Html5Qrcode ===
    "undefined"
  ) {

    $("errorTitle")
      .textContent =
        "Scanner non disponibile";

    $("errorText")
      .textContent =
        "Non riesco a caricare lo scanner. Controlla la connessione e riprova.";

    show(errorBox);

    return;
  }


  html5QrCode =
    new Html5Qrcode(
      "reader",
      {
        formatsToSupport: [

          Html5QrcodeSupportedFormats
            .EAN_13,

          Html5QrcodeSupportedFormats
            .EAN_8,

          Html5QrcodeSupportedFormats
            .UPC_A,

          Html5QrcodeSupportedFormats
            .UPC_E,

          Html5QrcodeSupportedFormats
            .CODE_128
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

        if (
          alreadyRead
        ) {
          return;
        }


        const ean =
          code(
            decodedText
          );


        if (
          !valid(ean)
        ) {
          return;
        }


        alreadyRead =
          true;


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


    scannerRunning =
      true;


  } catch (error) {

    scannerRunning =
      false;


    $("errorTitle")
      .textContent =
        "Non riesco ad aprire la fotocamera";


    $("errorText")
      .textContent =
        "Consenti l'accesso alla fotocamera nel browser e riprova.";


    show(errorBox);
  }
}


/* =========================================================
   STOP SCANNER
========================================================= */

async function stop() {

  if (
    html5QrCode &&
    scannerRunning
  ) {

    try {

      await html5QrCode.stop();

    } catch {}


    scannerRunning =
      false;
  }


  if (html5QrCode) {

    try {

      html5QrCode.clear();

    } catch {}


    html5QrCode =
      null;
  }
}


/* =========================================================
   EVENTI SCANNER
========================================================= */

$("scanButton")
  ?.addEventListener(
    "click",
    start
  );


$("closeScanner")
  ?.addEventListener(
    "click",
    async () => {

      await stop();

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

      /*
       * Resetta il valore,
       * così è possibile fotografare
       * due volte la stessa immagine.
       */
      $("photoInput").value = "";

      $("photoInput").click();
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
       * Blocchiamo solo file enormi.
       * Poi li comprimiamo.
       */
      if (
        file.size >
        25 * 1024 * 1024
      ) {

        $("errorTitle")
          .textContent =
            "Foto troppo grande";

        $("errorText")
          .textContent =
            "Prova a scattare nuovamente la fotografia.";

        show(errorBox);

        return;
      }


      try {

        show(loading);

        $("loadingTitle")
          .textContent =
            "Sto preparando la fotografia…";

        $("loadingText")
          .textContent =
            "Ottimizzo l'immagine per riconoscere meglio la bottiglia.";


        const compressed =
          await compressImage(
            file
          );


        await ask({
          mode: "image",
          image: compressed
        });


      } catch (error) {

        console.error(
          error
        );


        $("errorTitle")
          .textContent =
            "Non riesco a leggere la fotografia";


        $("errorText")
          .textContent =
            "Prova a scattare nuovamente la foto assicurandoti che la bottiglia o l'etichetta siano ben visibili.";


        show(errorBox);
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
        code(
          $("eanInput")
            ?.value
        );


      if (
        !valid(ean)
      ) {

        $("errorTitle")
          .textContent =
            "Codice non valido";

        $("errorText")
          .textContent =
            "Inserisci un codice EAN/UPC valido.";

        show(errorBox);

        return;
      }


      ask({
        mode: "ean",
        ean
      });
    }
  );


/* =========================================================
   PULSANTI
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
   CHIUSURA SCANNER
========================================================= */

document.addEventListener(
  "visibilitychange",
  async () => {

    if (
      document.hidden &&
      scannerRunning
    ) {

      await stop();
    }
  }
);
