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
  [home, scannerView, loading, result, errorBox].forEach(x => x.classList.add("hidden"));
}

function show(el) {
  hideAll();
  el.classList.remove("hidden");
  window.scrollTo({top:0, behavior:"smooth"});
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
    $("loadingTitle").textContent = "Sto cercando il codice " + payload.ean + "…";
    $("loadingText").textContent = "Cerco online a quale vino appartiene e verifico le informazioni principali.";
  } else {
    $("loadingTitle").textContent = "Sto cercando il vino…";
    $("loadingText").textContent = "Un attimo, il Sommelier sta verificando le informazioni più importanti.";
  }

  try {
    const response = await fetch("/api/sommelier", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "Errore del servizio.");

    const w = data.wine || {};

    if (!w.identified) {
      $("errorTitle").textContent = "Non riesco a identificarlo con certezza";
      $("errorText").textContent = w.message || "Prova con il nome del vino oppure controlla il codice a barre.";
      show(errorBox);
      return;
    }

    $("resultName").textContent = value(w.name);
    $("resultMeta").textContent = [w.producer, w.region, w.type, w.grape].filter(Boolean).join(" · ");
    $("resultTaste").textContent = value(w.taste);
    $("resultPairings").textContent = value(w.pairings);
    $("resultTemp").textContent = value(w.temperature);
    $("resultIdeal").textContent = value(w.ideal_for);

    if (w.ean) {
      $("resultCode").textContent = "Codice: " + w.ean;
    } else {
      $("resultCode").textContent = "";
    }

    if (w.confidence_note) {
      $("uncertain").textContent = w.confidence_note;
      $("uncertain").classList.remove("hidden");
    } else {
      $("uncertain").classList.add("hidden");
    }

    show(result);
  } catch (err) {
    $("errorTitle").textContent = "Si è verificato un problema";
    $("errorText").textContent = err.message || "Riprova tra qualche secondo.";
    show(errorBox);
  }
}

async function startScanner() {
  alreadyRead = false;
  show(scannerView);

  if (typeof Html5Qrcode === "undefined") {
    $("errorTitle").textContent = "Scanner non disponibile";
    $("errorText").textContent = "La libreria di scansione non è stata caricata. Controlla la connessione e riprova.";
    show(errorBox);
    return;
  }

  html5QrCode = new Html5Qrcode("reader", {
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128
    ],
    verbose: false
  });

  const onSuccess = async (decodedText) => {
    if (alreadyRead) return;
    const code = normalizeCode(decodedText);
    if (!validBarcode(code)) return;

    alreadyRead = true;
    if (navigator.vibrate) navigator.vibrate(80);
    await askSommelier({mode:"ean", ean:code});
  };

  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 12,
        qrbox: (viewfinderWidth, viewfinderHeight) => ({
          width: Math.floor(viewfinderWidth * 0.88),
          height: Math.floor(Math.min(150, viewfinderHeight * 0.30))
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
    $("errorTitle").textContent = "Non riesco ad aprire la fotocamera";
    $("errorText").textContent = "Consenti l'accesso alla fotocamera nel browser e riprova. Puoi anche inserire l'EAN manualmente.";
    show(errorBox);
  }
}

async function stopScanner() {
  if (html5QrCode && scannerRunning) {
    try { await html5QrCode.stop(); } catch {}
    scannerRunning = false;
  }
  if (html5QrCode) {
    try { html5QrCode.clear(); } catch {}
    html5QrCode = null;
  }
}

$("scanButton").addEventListener("click", startScanner);

$("closeScanner").addEventListener("click", async () => {
  await stopScanner();
  show(home);
});

$("wineForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("wineName").value.trim();
  if (name) askSommelier({mode:"name", name});
});

$("eanForm").addEventListener("submit", e => {
  e.preventDefault();
  const ean = normalizeCode($("eanInput").value);
  if (!validBarcode(ean)) {
    $("errorTitle").textContent = "Codice non valido";
    $("errorText").textContent = "Inserisci un codice a barre numerico da 8, 12, 13 o 14 cifre.";
    show(errorBox);
    return;
  }
  askSommelier({mode:"ean", ean});
});

$("backButton").addEventListener("click", () => show(home));
$("retryButton").addEventListener("click", () => show(home));

document.addEventListener("visibilitychange", async () => {
  if (document.hidden && scannerRunning) await stopScanner();
});
