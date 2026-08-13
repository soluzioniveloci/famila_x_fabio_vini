const $ = id => document.getElementById(id);

const home = $("home");
const scannerView = $("scannerView");
const loading = $("loading");
const result = $("result");
const errorBox = $("error");

let html5QrCode = null;
let scannerRunning = false;
let alreadyRead = false;

function hideAll() {
  [home, scannerView, loading, result, errorBox]
    .filter(Boolean)
    .forEach(x => x.classList.add("hidden"));
}

function show(el) {
  hideAll();
  if (el) el.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function value(v) {
  return v && String(v).trim() ? String(v).trim() : "—";
}

function normalizeCode(raw) {
  return String(raw || "").replace(/\D/g, "");
}

function validBarcode(code) {
  return /^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/.test(code);
}

async function askSommelier(payload) {
  await stopScanner();
  show(loading);

  if (payload.mode === "ean") {
    if ($("loadingTitle")) {
      $("loadingTitle").textContent =
        "Sto cercando il codice " + payload.ean + "…";
    }

    if ($("loadingText")) {
      $("loadingText").textContent =
        "Il Sommelier Virtuale sta verificando a quale vino appartiene.";
    }
  }

  if (payload.mode === "image") {
    if ($("loadingTitle")) {
      $("loadingTitle").textContent = "Sto riconoscendo il vino…";
    }

    if ($("loadingText")) {
      $("loadingText").textContent =
        "Analizzo la foto e poi verifico le informazioni sul web.";
    }
  }

  try {
    const response = await fetch("/api/sommelier", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "Errore del servizio."
      );
    }

    const w = data.wine || {};

    if (!w.identified) {
      if ($("errorTitle")) {
        $("errorTitle").textContent =
          "Non riesco a identificarlo con certezza";
      }

      if ($("errorText")) {
        $("errorText").textContent =
          w.message ||
          "Prova con una foto più chiara oppure scansiona il codice a barre.";
      }

      show(errorBox);
      return;
    }

    if ($("resultName")) {
      $("resultName").textContent = value(w.name);
    }

    if ($("resultMeta")) {
      $("resultMeta").textContent =
        [
          w.producer,
          w.region,
          w.type,
          w.grape
        ]
          .filter(Boolean)
          .join(" · ");
    }

    if ($("resultTaste")) {
      $("resultTaste").textContent =
        value(w.taste);
    }

    if ($("resultPairings")) {
      $("resultPairings").textContent =
        value(w.pairings);
    }

    if ($("resultTemp")) {
      $("resultTemp").textContent =
        value(w.temperature);
    }

    if ($("resultIdeal")) {
      $("resultIdeal").textContent =
        value(w.ideal_for);
    }

    if ($("resultCode")) {
      $("resultCode").textContent =
        w.ean ? "Codice: " + w.ean : "";
    }

    const uncertain = $("uncertain");

    if (uncertain) {
      if (w.confidence_note) {
        uncertain.textContent =
          w.confidence_note;

        uncertain.classList.remove("hidden");
      } else {
        uncertain.classList.add("hidden");
      }
    }

    show(result);

  } catch (err) {
    if ($("errorTitle")) {
      $("errorTitle").textContent =
        "Si è verificato un problema";
    }

    if ($("errorText")) {
      $("errorText").textContent =
        err.message ||
        "Riprova tra qualche secondo.";
    }

    show(errorBox);
  }
}

async function startScanner() {
  alreadyRead = false;

  show(scannerView);

  if (typeof Html5Qrcode === "undefined") {
    if ($("errorTitle")) {
      $("errorTitle").textContent =
        "Scanner non disponibile";
    }

    if ($("errorText")) {
      $("errorText").textContent =
        "La libreria di scansione non è stata caricata. Controlla la connessione e riprova.";
    }

    show(errorBox);
    return;
  }

  html5QrCode = new Html5Qrcode(
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

  const onSuccess = async decodedText => {
    if (alreadyRead) return;

    const code =
      normalizeCode(decodedText);

    if (!validBarcode(code)) return;

    alreadyRead = true;

    if (navigator.vibrate) {
      navigator.vibrate(80);
    }

    await askSommelier({
      mode: "ean",
      ean: code
    });
  };

  try {
    await html5QrCode.start(
      {
        facingMode: "environment"
      },
      {
        fps: 12,

        qrbox: (w, h) => ({
          width:
            Math.floor(w * 0.88),

          height:
            Math.floor(
              Math.min(
                150,
                h * 0.30
              )
            )
        }),

        aspectRatio: 1.777778,
        disableFlip: false
      },

      onSuccess,
      () => {}
    );

    scannerRunning = true;

  } catch (err) {
    scannerRunning = false;

    if ($("errorTitle")) {
      $("errorTitle").textContent =
        "Non riesco ad aprire la fotocamera";
    }

    if ($("errorText")) {
      $("errorText").textContent =
        "Consenti l'accesso alla fotocamera nel browser e riprova.";
    }

    show(errorBox);
  }
}

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

if ($("scanButton")) {
  $("scanButton")
    .addEventListener(
      "click",
      startScanner
    );
}

if ($("closeScanner")) {
  $("closeScanner")
    .addEventListener(
      "click",
      async () => {
        await stopScanner();
        show(home);
      }
    );
}

if (
  $("photoButton") &&
  $("photoInput")
) {
  $("photoButton")
    .addEventListener(
      "click",
      () => {
        $("photoInput").click();
      }
    );

  $("photoInput")
    .addEventListener(
      "change",
      e => {
        const file =
          e.target.files &&
          e.target.files[0];

        if (!file) return;

        if (
          file.size >
          8 * 1024 * 1024
        ) {
          if ($("errorTitle")) {
            $("errorTitle").textContent =
              "Foto troppo grande";
          }

          if ($("errorText")) {
            $("errorText").textContent =
              "Usa una foto inferiore a 8 MB.";
          }

          show(errorBox);
          return;
        }

        const reader =
          new FileReader();

        reader.onload =
          () =>
            askSommelier({
              mode: "image",
              image: reader.result
            });

        reader.readAsDataURL(file);
      }
    );
}

if ($("eanForm")) {
  $("eanForm")
    .addEventListener(
      "submit",
      e => {
        e.preventDefault();

        const ean =
          normalizeCode(
            $("eanInput")?.value
          );

        if (!validBarcode(ean)) {
          if ($("errorTitle")) {
            $("errorTitle").textContent =
              "Codice non valido";
          }

          if ($("errorText")) {
            $("errorText").textContent =
              "Inserisci un codice numerico da 8, 12, 13 o 14 cifre.";
          }

          show(errorBox);
          return;
        }

        askSommelier({
          mode: "ean",
          ean
        });
      }
    );
}

if ($("backButton")) {
  $("backButton")
    .addEventListener(
      "click",
      () => {
        show(home);
      }
    );
}

if ($("retryButton")) {
  $("retryButton")
    .addEventListener(
      "click",
      () => {
        show(home);
      }
    );
}

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
