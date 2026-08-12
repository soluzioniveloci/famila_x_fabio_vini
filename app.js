const $ = id => document.getElementById(id);
const home = $("home"), loading = $("loading"), result = $("result"), errorBox = $("error");

function show(el){
  [home, loading, result, errorBox].forEach(x => x.classList.add("hidden"));
  el.classList.remove("hidden");
  window.scrollTo({top:0, behavior:"smooth"});
}
function value(v){ return v && String(v).trim() ? String(v).trim() : "—"; }

async function askSommelier(payload){
  show(loading);
  try{
    const response = await fetch("/api/sommelier", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload)
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || "Errore del servizio.");

    const w = data.wine || {};
    if(!w.identified){
      $("errorText").textContent = w.message || "Prova a fotografare meglio l'etichetta oppure inserisci il nome del vino.";
      show(errorBox);
      return;
    }

    $("resultName").textContent = value(w.name);
    $("resultMeta").textContent = [w.producer, w.region, w.type, w.grape].filter(Boolean).join(" · ");
    $("resultTaste").textContent = value(w.taste);
    $("resultPairings").textContent = value(w.pairings);
    $("resultTemp").textContent = value(w.temperature);
    $("resultIdeal").textContent = value(w.ideal_for);

    if(w.confidence_note){
      $("uncertain").textContent = w.confidence_note;
      $("uncertain").classList.remove("hidden");
    } else {
      $("uncertain").classList.add("hidden");
    }
    show(result);
  }catch(err){
    $("errorText").textContent = err.message || "Si è verificato un errore. Riprova.";
    show(errorBox);
  }
}

$("scanButton").addEventListener("click", () => $("cameraInput").click());

$("cameraInput").addEventListener("change", e => {
  const file = e.target.files && e.target.files[0];
  if(!file) return;

  if(file.size > 8 * 1024 * 1024){
    $("errorText").textContent = "La foto è troppo grande. Usa una foto inferiore a 8 MB.";
    show(errorBox);
    return;
  }

  const reader = new FileReader();
  reader.onload = () => askSommelier({mode:"image", image:reader.result});
  reader.readAsDataURL(file);
});

$("wineForm").addEventListener("submit", e => {
  e.preventDefault();
  const name = $("wineName").value.trim();
  if(name) askSommelier({mode:"name", name});
});

$("backButton").addEventListener("click", () => show(home));
$("retryButton").addEventListener("click", () => show(home));
