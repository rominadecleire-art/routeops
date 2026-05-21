// ════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════
var CONFIG = {
  // Relative URL when served by Flask (local or Render); absolute only when opening index.html directly from disk
  apiBase: window.location.protocol === 'file:' ? 'http://localhost:5000' : '',
  baseCity: localStorage.getItem('routeops_base_city') || '',
  googleMapsKey: localStorage.getItem('routeops_gmaps_key') || '',
};

// ════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════
var baseCityCenter = null;

function saveSettings() {
  var keyVal  = (document.getElementById('gmaps-key-inp').value || '').trim();
  var cityVal = (document.getElementById('city-inp').value || '').trim();

  CONFIG.googleMapsKey = keyVal;
  localStorage.setItem('routeops_gmaps_key', keyVal);

  CONFIG.baseCity = cityVal;
  localStorage.setItem('routeops_base_city', cityVal);
  baseCityCenter = null;

  updateGmapsKeyHint();
  updateCityHint();
  showToast('Configuración guardada', 'ok');
}

function updateGmapsKeyHint() {
  var hint = document.getElementById('gmaps-key-hint');
  if (!hint) return;
  hint.textContent = CONFIG.googleMapsKey
    ? '✓ Google Maps activo'
    : 'Sin clave — se usará Nominatim (menos preciso en ciudades pequeñas)';
}

async function getBaseCityCenter() {
  if (baseCityCenter) return baseCityCenter;
  if (!CONFIG.baseCity) return null;
  try {
    var data = await fetch(
      'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(CONFIG.baseCity) +
      '&format=json&limit=1',
      {headers: {'Accept-Language': 'es', 'User-Agent': 'RouteOps/1.0'}}
    ).then(function(r) { return r.json(); });
    if (data && data.length) {
      baseCityCenter = {lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon)};
      return baseCityCenter;
    }
  } catch(e) {}
  return null;
}

async function useBaseCityAsDepot() {
  var center = await getBaseCityCenter();
  if (!center) { showToast('Configurá una ciudad base en Ajustes', 'info'); return; }
  var inp = document.getElementById('dep-inp');
  var addr = (inp && inp.value.trim()) || CONFIG.baseCity;
  setWizDepot('Punto de salida (aprox.)', addr, center.lat, center.lng);
  var fb = document.getElementById('dep-fallback');
  if (fb) fb.style.display = 'none';
  var st = document.getElementById('dep-status');
  if (st) { st.style.color = '#f59e0b'; st.textContent = '⚠ Coordenadas aproximadas — ajust\xe1 el pin si es necesario'; }
}

function updateCityHint() {
  var hint = document.getElementById('city-hint');
  if (!hint) return;
  hint.textContent = CONFIG.baseCity
    ? '✓ Guardado — se usará en direcciones sin ciudad'
    : '';
}

function resolveAddress(addr) {
  var city = CONFIG.baseCity;
  if (!city || !addr) return addr;
  if (addr.toLowerCase().indexOf(city.toLowerCase()) !== -1) return addr;
  if (addr.indexOf(',') !== -1) return addr;
  return addr.trim() + ', ' + city;
}

// ════════════════════════════════════════
// STATE
// ════════════════════════════════════════
var R = [];
var DEPOT = null;
var wizDepot = null;
var wizPart = 'saved';
var currentMethod = 'pdf';
var manualQueue = [];
var pendingPDF = null;
var detIdx = -1;
var mainMap = null, miniMap = null, routePolys = [], mapMarkers = [];
var distMatrix = [], durMatrix = [];
var pendingImages = [];
var _lastResultKm = 0, _lastResultSaved = 0, _lastResultMin = 0;
function loadFavorites() {
  try { return JSON.parse(localStorage.getItem('routeops_fav') || '[]'); } catch(e) { return []; }
}
function saveFavorites(favs) { localStorage.setItem('routeops_fav', JSON.stringify(favs)); }

var DEMO = [
  {name:'Supermercado Norte',  address:'Rivadavia 600, Venado Tuerto, Santa Fe, Argentina'},
  {name:'Ferretería El Ancla', address:'San Martín 850, Venado Tuerto, Santa Fe, Argentina'},
  {name:'Farmacia Del Pueblo', address:'Belgrano 900, Venado Tuerto, Santa Fe, Argentina'},
  {name:'Panadería La Espiga', address:'Moreno 250, Venado Tuerto, Santa Fe, Argentina'},
  {name:'Heladería Polar',     address:'Urquiza 400, Venado Tuerto, Santa Fe, Argentina'},
  {name:'Almacén Don Carlos',  address:'Mitre 600, Venado Tuerto, Santa Fe, Argentina'},
  {name:'Junín 1880',          address:'Junín 1880, Venado Tuerto, Santa Fe, Argentina'},
];

// ════════════════════════════════════════
// CLOCK + DATE
// ════════════════════════════════════════
function tick() {
  var d = new Date();
  document.getElementById('clk').textContent =
    String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
tick();
setInterval(tick, 30000);
document.getElementById('hdt').textContent =
  new Date().toLocaleDateString('es-AR', {weekday:'long', day:'numeric', month:'long'});

// ════════════════════════════════════════
// SCREEN NAVIGATION
// ════════════════════════════════════════
// Internal: switch active screen without touching history
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  var el = document.getElementById(id);
  if (el) el.classList.add('active');
  if (id === 'scr-home') renderHome();
  if (id === 'scr-stops') renderList();
  if (id === 'scr-map') {
    setTimeout(function() {
      initMap();
      if (mainMap) { mainMap.invalidateSize(); drawMap(); }
    }, 50);
  }
  if (id === 'scr-settings') {
    var inp = document.getElementById('city-inp');
    if (inp) inp.value = CONFIG.baseCity;
    updateCityHint();
    var keyInp = document.getElementById('gmaps-key-inp');
    if (keyInp) keyInp.value = CONFIG.googleMapsKey;
    updateGmapsKeyHint();
  }
}

// Public: navigate and record in browser history so the device back button works
function go(id) {
  history.pushState({screen: id}, '', '');
  showScreen(id);
}

// Device / browser back button — navigate within the app, not to a previous URL
window.addEventListener('popstate', function(e) {
  var id = (e.state && e.state.screen) || 'scr-home';
  showScreen(id);
});

// ════════════════════════════════════════
// WIZARD
// ════════════════════════════════════════
function startWizard() {
  // Reset state
  wizDepot = null;
  wizPart = 'saved';
  currentMethod = 'pdf';
  manualQueue = [];
  pendingPDF = null;
  audioTranscript = '';
  audioConfirmedLines = 0;
  updateAudioCounter();

  // Reset UI fields
  var els = {
    ap: '', mtxt: null, fi: null, 'dep-inp': null,
    'dep-sug': '', 'gps-txt': ''
  };
  ['ap','dep-sug','gps-txt'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = '';
  });
  ['mtxt','dep-inp'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var fi = document.getElementById('fi');
  if (fi) fi.value = '';
  var pdfReady = document.getElementById('pdf-ready');
  if (pdfReady) pdfReady.classList.remove('on');
  pendingImages = [];
  ['fi-cam','fi-gal'].forEach(function(id) { var el=document.getElementById(id); if(el) el.value=''; });
  renderImageList();
  var _ecInp = document.getElementById('extract-city-inp');
  if (_ecInp) { _ecInp.value = ''; _ecInp.style.borderColor = '#1e3a5f'; }
  var depOk = document.getElementById('dep-ok');
  if (depOk) depOk.classList.remove('on');
  var audioRes = document.getElementById('audio-result');
  if (audioRes) audioRes.style.display = 'none';

  // Reset processing steps and results
  resetSteps();
  var pw = document.getElementById('proc-wrap');
  if (pw) pw.style.display = '';
  document.getElementById('wresults').style.display = 'none';
  var sb = document.getElementById('steps-box');
  if (sb) sb.style.display = 'block';
  document.getElementById('ws3-t').textContent = 'Optimizando...';
  document.getElementById('ws3-s').textContent = 'Calculando el recorrido más corto por calles reales';
  if (pinLMap) { pinLMap.remove(); pinLMap = null; pinLMarker = null; }
  document.getElementById('pin-modal').style.display = 'none';

  // Show step 1 and render chips
  showWS(1);
  selPart('saved');
  renderChips();
  switchMethod('pdf');

  go('scr-wizard');
}

function showWS(n) {
  document.getElementById('ws1').style.display = n === 1 ? 'block' : 'none';
  document.getElementById('ws2').style.display = n === 2 ? 'block' : 'none';
  document.getElementById('ws3').style.display = n === 3 ? 'block' : 'none';
}

function wizardBack() {
  var ws3 = document.getElementById('ws3');
  var ws2 = document.getElementById('ws2');
  if (ws3 && ws3.style.display !== 'none') {
    showWS(2);
  } else if (ws2 && ws2.style.display !== 'none') {
    showWS(1);
  } else {
    history.back();
  }
}

// ════════════════════════════════════════
// STEP 1: Punto de partida
// ════════════════════════════════════════
function selPart(t) {
  wizPart = t;
  ['saved','manual','gps'].forEach(function(x) {
    var opt = document.getElementById('opt-' + x);
    var radio = document.getElementById('r-' + x);
    var pan = document.getElementById('pan-' + x);
    if (opt) opt.classList.toggle('sel', x === t);
    if (radio) radio.classList.toggle('on', x === t);
    if (pan) pan.style.display = x === t ? 'block' : 'none';
  });
  if (t === 'saved') {
    // Re-apply the currently highlighted chip, or default to chip 0
    var sel = document.querySelector('.chip.sel');
    if (sel) sel.click(); else { var _f = loadFavorites(); if (_f.length) pickSaved(0); }
  } else {
    // Manual / GPS require explicit geocoding — clear any chip-inherited depot
    wizDepot = null;
    var ok = document.getElementById('dep-ok');
    if (ok) ok.classList.remove('on');
    var st = document.getElementById('dep-status');
    if (st) st.textContent = '';
  }
}

function renderChips() {
  var el = document.getElementById('saved-chips');
  if (!el) return;
  el.innerHTML = '';
  var favs = loadFavorites();
  if (!favs.length) {
    el.innerHTML = '<div style="color:#475569;font-size:12px;padding:4px 0;line-height:1.6">No hay favoritos guardados.<br>Buscá una dirección en "Escribir direcci\xf3n" y toc\xe1 <i class="ti ti-star"></i> Guardar como favorito.</div>';
    return;
  }
  favs.forEach(function(s, i) {
    el.innerHTML += '<div class="chip" id="chip-' + i + '" onclick="pickSaved(' + i + ')">' +
      '<i class="ti ti-map-pin"></i>' + s.name +
      '<span onclick="event.stopPropagation();deleteFavorite(' + i + ')" style="margin-left:6px;opacity:.55;font-size:11px" title="Eliminar">✕</span></div>';
  });
  pickSaved(0);
}

function pickSaved(i) {
  document.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('sel'); });
  var chip = document.getElementById('chip-' + i);
  if (chip) chip.classList.add('sel');
  var s = loadFavorites()[i];
  if (!s) return;
  setWizDepot(s.name, s.address, s.lat, s.lng);
}

function showSaveFavForm() {
  var form = document.getElementById('dep-fav-form');
  var btn = document.getElementById('dep-fav-btn');
  if (form) form.style.display = 'block';
  if (btn) btn.style.display = 'none';
  setTimeout(function() { var n = document.getElementById('dep-fav-name'); if (n) n.focus(); }, 50);
}

function hideSaveFavForm() {
  var form = document.getElementById('dep-fav-form');
  var btn = document.getElementById('dep-fav-btn');
  if (form) { form.style.display = 'none'; var n = document.getElementById('dep-fav-name'); if (n) n.value = ''; }
  if (btn) btn.style.display = '';
}

function doSaveFavorite() {
  if (!wizDepot) return;
  var nameInp = document.getElementById('dep-fav-name');
  var name = nameInp ? nameInp.value.trim() : '';
  if (!name) { showToast('Escrib\xed un nombre para el favorito', 'info'); if (nameInp) nameInp.focus(); return; }
  var favs = loadFavorites();
  favs.push({name: name, address: wizDepot.address, lat: wizDepot.lat, lng: wizDepot.lng});
  saveFavorites(favs);
  hideSaveFavForm();
  renderChips();
  showToast(name + ' guardado como favorito', 'ok');
}

function deleteFavorite(i) {
  var favs = loadFavorites();
  favs.splice(i, 1);
  saveFavorites(favs);
  renderChips();
  showToast('Favorito eliminado', 'ok');
}

function setWizDepot(name, addr, lat, lng) {
  wizDepot = {name: name, address: addr, lat: parseFloat(lat), lng: parseFloat(lng), isDepot: true};
  var ok = document.getElementById('dep-ok');
  if (ok) ok.classList.add('on');
  var n = document.getElementById('dep-ok-name');
  if (n) n.textContent = name;
  var a = document.getElementById('dep-ok-addr');
  if (a) a.textContent = addr;
  var c = document.getElementById('dep-ok-coords');
  if (c) c.textContent = parseFloat(lat).toFixed(5) + ', ' + parseFloat(lng).toFixed(5);
  // Only show toast when user explicitly picks (not on auto-select during renderChips)
  if (document.getElementById('scr-wizard').classList.contains('active')) {
    showToast(name + ' seleccionado como salida', 'ok');
  }
}

async function goStep2() {
  if (wizPart === 'manual') {
    var depOk = document.getElementById('dep-ok');
    var confirmed = depOk && depOk.classList.contains('on') && wizDepot;
    if (!confirmed) {
      var ok = await confirmDepInp();
      if (!ok) return;
    }
  }
  if (!wizDepot) {
    showToast('Primero elegí un punto de partida', 'info');
    return;
  }
  showWS(2);
}

// ════════════════════════════════════════
// NOMINATIM AUTOCOMPLETE (step 1 manual)
// ════════════════════════════════════════
var depTimer = null;

function onDepInput(v) {
  clearTimeout(depTimer);
  var sug = document.getElementById('dep-sug');
  // If user edits after confirming, invalidate the previous geocoding
  if (wizDepot && wizPart === 'manual') {
    wizDepot = null;
    var ok = document.getElementById('dep-ok');
    if (ok) ok.classList.remove('on');
  }
  var st = document.getElementById('dep-status');
  if (st) st.textContent = '';
  var fb = document.getElementById('dep-fallback');
  if (fb) fb.style.display = 'none';
  if (v.length < 4) { if (sug) sug.innerHTML = ''; return; }
  depTimer = setTimeout(function() { fetchDepSug(v); }, 700);
}

function fetchDepSug(q) {
  fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
    '&format=json&limit=5&countrycodes=ar',
    {headers: {'Accept-Language': 'es', 'User-Agent': 'RouteOps/1.0'}})
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var box = document.getElementById('dep-sug');
    if (!box) return;
    box.innerHTML = '';
    data.forEach(function(p) {
      var parts = p.display_name.split(',');
      var main = parts.slice(0,3).join(',');
      var sub = parts.slice(3,6).join(',');
      var div = document.createElement('div');
      div.className = 'sug-item';
      div.innerHTML = '<i class="ti ti-map-pin"></i><div><div class="sug-main">' + main +
        '</div><div class="sug-sub">' + sub + '</div></div>';
      div.onclick = function() { pickSug(p.display_name, p.lat, p.lon); };
      box.appendChild(div);
    });
  })
  .catch(function() {});
}

function pickSug(addr, lat, lng) {
  var short = addr.split(',').slice(0,3).join(',');
  var depInp = document.getElementById('dep-inp');
  if (depInp) depInp.value = short;
  var sug = document.getElementById('dep-sug');
  if (sug) sug.innerHTML = '';
  setWizDepot('Punto de salida', short, parseFloat(lat), parseFloat(lng));
}

function pickFirstSug() {
  var first = document.querySelector('#dep-sug .sug-item');
  if (first) first.click();
}

async function confirmDepInp() {
  // If a suggestion dropdown is already visible, use the first item
  var first = document.querySelector('#dep-sug .sug-item');
  if (first) { first.click(); return true; }

  var inp = document.getElementById('dep-inp');
  var statusEl = document.getElementById('dep-status');
  if (!inp) return false;
  var val = inp.value.trim();
  if (!val) { showToast('Escribí una dirección para buscar', 'info'); return false; }

  if (statusEl) { statusEl.style.color = '#60a5fa'; statusEl.textContent = 'Buscando…'; }

  var g = await geocodeFull(val);

  if (!g.lat) {
    // Geocoding failed and no city center configured — open pin modal as last resort
    var fb = document.getElementById('dep-fallback');
    if (fb) fb.style.display = 'none';
    if (statusEl) { statusEl.style.color = '#f59e0b'; statusEl.textContent = 'No encontrado — marcá la ubicaci\xf3n en el mapa'; }
    await openPinPlacementForDepot();
    return false; // modal handles confirmation separately
  }

  if (statusEl) statusEl.textContent = '';
  if (g.fallbackToCity) {
    if (statusEl) { statusEl.style.color = '#f59e0b'; statusEl.textContent = '⚠ Direcci\xf3n no encontrada — se usar\xe1 el centro de ' + CONFIG.baseCity.split(',')[0] + ' como aproximaci\xf3n'; }
  }
  var label = g.fallbackToCity ? 'Punto de salida (aprox.)' : ('Punto de salida' + (g.approx ? ' (aprox.)' : ''));
  setWizDepot(label, g.resolvedAddress, g.lat, g.lng);
  return true;
}

function getGPS() {
  var txt = document.getElementById('gps-txt');
  if (txt) txt.textContent = 'Detectando...';
  if (!navigator.geolocation) { showToast('GPS no disponible', 'err'); return; }
  navigator.geolocation.getCurrentPosition(
    function(pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      if (txt) txt.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5);
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json',
        {headers: {'Accept-Language': 'es', 'User-Agent': 'RouteOps/1.0'}})
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var addr = d.display_name || (lat + ', ' + lng);
        setWizDepot('Mi ubicación GPS', addr.split(',').slice(0,3).join(','), lat, lng);
        if (txt) txt.textContent = '✓ Ubicación confirmada';
      })
      .catch(function() {
        setWizDepot('Mi ubicación GPS', lat.toFixed(5) + ', ' + lng.toFixed(5), lat, lng);
      });
    },
    function() { showToast('No se pudo obtener GPS', 'err'); }
  );
}

// ════════════════════════════════════════
// STEP 2: Paradas
// ════════════════════════════════════════
function addManual() {
  var addr = document.getElementById('add-addr').value.trim();
  if (!addr) { showToast('Ingresá la dirección', 'info'); return; }
  var name = addr.split(',')[0] || addr;
  manualQueue.push({name: name, address: addr});
  document.getElementById('add-addr').value = '';
  document.getElementById('add-addr').focus();
  document.getElementById('ap').textContent =
    manualQueue.length + ' en cola: ' + manualQueue.map(function(s) { return s.name; }).join(' · ');
  showToast('"' + name + '" agregado', 'ok');
}

function dzOv(e) { e.preventDefault(); document.getElementById('dz').classList.add('ov'); }
function dzLv() { document.getElementById('dz').classList.remove('ov'); }
function dzDp(e) {
  e.preventDefault(); dzLv();
  var f = e.dataTransfer.files[0];
  if (f) setPDF(f);
}
function pdfIn(e) { var f = e.target.files[0]; if (f) setPDF(f); }
function setPDF(f) {
  pendingPDF = f;
  var el = document.getElementById('pdf-ready');
  if (el) el.classList.add('on');
  var nm = document.getElementById('pdf-name');
  if (nm) nm.textContent = f.name;
  showToast('PDF cargado: ' + f.name, 'ok');
}
function clearPDF() {
  pendingPDF = null;
  var el = document.getElementById('pdf-ready');
  if (el) el.classList.remove('on');
  var fi = document.getElementById('fi');
  if (fi) fi.value = '';
}

function addImages(fileList) {
  if (!fileList || !fileList.length) return;
  for (var i = 0; i < fileList.length; i++) pendingImages.push(fileList[i]);
  renderImageList();
  showToast(fileList.length === 1
    ? 'Imagen agregada: ' + fileList[0].name
    : fileList.length + ' imágenes agregadas', 'ok');
}
function removeImage(i) {
  pendingImages.splice(i, 1);
  // Reset inputs so the same file can be re-added if needed
  ['fi-cam','fi-gal'].forEach(function(id) { var el=document.getElementById(id); if(el) el.value=''; });
  renderImageList();
}
function renderImageList() {
  var el = document.getElementById('img-list');
  if (!el) return;
  if (!pendingImages.length) { el.innerHTML = ''; return; }
  el.innerHTML = pendingImages.map(function(f, i) {
    return '<div class="pdf-ready on" style="margin-bottom:4px">' +
      '<i class="ti ti-photo-check" style="font-size:16px;flex-shrink:0"></i>' +
      '<span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">' + f.name + '</span>' +
      '<button onclick="removeImage(' + i + ')" style="background:none;border:none;color:#60a5fa;cursor:pointer;font-size:12px;padding:0 4px;flex-shrink:0">✕</button>' +
      '</div>';
  }).join('');
}
async function callClaudeImage(file) {
  var formData = new FormData();
  formData.append('image', file);
  var resp = await fetch(CONFIG.apiBase + '/api/extract-image', {method: 'POST', body: formData});
  if (!resp.ok) {
    var err = await resp.json().catch(function() { return {}; });
    throw new Error(err.error || 'Error del servidor (' + resp.status + ')');
  }
  var data = await resp.json();
  if (data.stops && data.stops.length > 0) return data.stops;
  throw new Error('Sin direcciones en ' + file.name);
}
async function callClaudeImages(files) {
  var allStops = [], errors = [];
  for (var i = 0; i < files.length; i++) {
    step(1, 'r', 'Procesando imagen ' + (i + 1) + ' de ' + files.length + '...');
    try {
      var s = await callClaudeImage(files[i]);
      allStops = allStops.concat(s);
    } catch(e) { errors.push(files[i].name); }
  }
  if (!allStops.length) throw new Error(
    errors.length ? 'Sin direcciones en: ' + errors.join(', ') : 'No se encontraron direcciones'
  );
  // Deduplicate by normalized address across all images
  var seen = {};
  return allStops.filter(function(s) {
    var key = (s.address || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function goStep3() {
  var txt = '';
  if (currentMethod === 'text' || currentMethod === 'audio') {
    var el = document.getElementById('mtxt');
    txt = el ? el.value.trim() : '';
  }
  if (!txt && !manualQueue.length && !pendingPDF && !pendingImages.length) {
    showToast('Agregá al menos una parada, subí un PDF o una foto', 'info');
    return;
  }
  showWS(3);
  runOptimization(txt, null);
}

function clearCityError() {
  ['extract-city-inp', 'extract-city-inp-img'].forEach(function(id) {
    var inp = document.getElementById(id);
    if (inp) inp.style.borderColor = '#1e3a5f';
  });
}

function runDemo() {
  if (!wizDepot) {
    var _fv = loadFavorites();
    wizDepot = _fv.length
      ? Object.assign({}, _fv[0], {isDepot: true})
      : {name:'Demo', address:'Venado Tuerto, Santa Fe, Argentina', lat:-33.7464, lng:-61.9673, isDepot:true};
  }
  showWS(3);
  runOptimization('', DEMO);
}

// ════════════════════════════════════════
// METHOD TABS (PDF / AUDIO / TEXT)
// ════════════════════════════════════════
function switchMethod(m) {
  currentMethod = m;
  ['pdf','image','audio','text'].forEach(function(x) {
    var tab = document.getElementById('tab-' + x);
    var panel = document.getElementById('mpanel-' + x);
    if (tab) tab.classList.toggle('act', x === m);
    if (panel) panel.style.display = x === m ? 'block' : 'none';
  });
  var cw = document.getElementById('city-extract-wrap');
  if (cw) cw.style.display = (m === 'pdf' || m === 'image') ? 'block' : 'none';
  if (m === 'audio') initAudio();
}

// ════════════════════════════════════════
// AUDIO — Web Speech API + MediaRecorder fallback
// ════════════════════════════════════════
var recognition = null;
var isRecording = false;
var audioTranscript = '';
var processedResultsCount = 0;
var audioConfirmedLines = 0;

var mediaRecorder = null;
var recChunks = [];
var isRecordingAudio = false;

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function initAudio() {
  var noSupport = document.getElementById('audio-no-support');
  var wsDiv    = document.getElementById('ws-audio');
  var iosDiv   = document.getElementById('ios-recorder');

  // iOS Safari: Web Speech unreliable (no continuous mode) → use MediaRecorder
  if (isIOS()) {
    if (wsDiv)  wsDiv.style.display  = 'none';
    if (iosDiv) iosDiv.style.display = 'block';
    return;
  }

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    // Check if MediaRecorder is available as a fallback
    if (window.MediaRecorder) {
      if (wsDiv)  wsDiv.style.display  = 'none';
      if (iosDiv) iosDiv.style.display = 'block';
    } else {
      if (noSupport) noSupport.style.display = 'flex';
      if (wsDiv)  wsDiv.style.display  = 'none';
    }
    return;
  }

  if (recognition) return;

  recognition = new SpeechRecognition();
  recognition.lang = 'es-AR';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = function() {
    isRecording = true;
    var btn = document.getElementById('mic-btn');
    var lbl = document.getElementById('mic-label');
    var ico = document.getElementById('mic-ico');
    if (btn) btn.classList.add('recording');
    if (lbl) { lbl.textContent = 'Grabando... tocá para detener'; lbl.classList.add('rec'); }
    if (ico) ico.className = 'ti ti-player-stop';
  };

  recognition.onend = function() {
    isRecording = false;
    var btn = document.getElementById('mic-btn');
    var lbl = document.getElementById('mic-label');
    var ico = document.getElementById('mic-ico');
    if (btn) btn.classList.remove('recording');
    if (lbl) { lbl.textContent = 'Tocá para hablar'; lbl.classList.remove('rec'); }
    if (ico) ico.className = 'ti ti-microphone';
    document.getElementById('mic-interim').textContent = '';
    if (audioTranscript.trim()) showAudioResult(audioTranscript.trim());
  };

  recognition.onerror = function(e) {
    isRecording = false;
    var btn = document.getElementById('mic-btn');
    if (btn) btn.classList.remove('recording');
    if (e.error === 'not-allowed') {
      showToast('Permiso de micrófono denegado. Habilitalo en Configuración.', 'err');
    } else if (e.error === 'network') {
      showToast('Error de red al reconocer voz. Verificá la conexión.', 'err');
    } else if (e.error !== 'no-speech') {
      showToast('Error de reconocimiento: ' + e.error, 'err');
    }
  };

  recognition.onresult = function(event) {
    var interim = '';
    // Use processedResultsCount instead of event.resultIndex to prevent re-processing
    // when continuous mode restarts and sends resultIndex=0 again
    for (var i = processedResultsCount; i < event.results.length; i++) {
      var t = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) {
        if (t) audioTranscript += (audioTranscript ? '\n' : '') + t;
        processedResultsCount++;
      } else {
        interim += t;
      }
    }
    var interimEl = document.getElementById('mic-interim');
    if (interimEl) interimEl.textContent = interim || audioTranscript;
  };
}

async function requestMicPermission() {
  try {
    var stream = await navigator.mediaDevices.getUserMedia({audio: true});
    stream.getTracks().forEach(function(t) { t.stop(); });
    return true;
  } catch(e) {
    showToast('Permiso de micrófono denegado. Habilitalo en Configuración del sistema.', 'err');
    return false;
  }
}

async function toggleMic() {
  if (!recognition) {
    initAudio();
    if (!recognition) return;
  }
  if (isRecording) {
    recognition.stop();
  } else {
    var ok = await requestMicPermission();
    if (!ok) return;
    audioTranscript = '';
    processedResultsCount = 0;
    document.getElementById('mic-interim').textContent = '';
    var res = document.getElementById('audio-result');
    if (res) res.style.display = 'none';
    try {
      recognition.start();
    } catch(e) {
      recognition.stop();
      setTimeout(function() { recognition.start(); }, 300);
    }
  }
}

// ── MediaRecorder fallback (iOS Safari / Firefox) ──────────────────────────────

async function toggleRecorder() {
  if (isRecordingAudio) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    return;
  }

  var ok = await requestMicPermission();
  if (!ok) return;

  var mimeType = '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
  else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
  else if (MediaRecorder.isTypeSupported('audio/ogg')) mimeType = 'audio/ogg';

  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount:1, sampleRate:16000}});
  } catch(e) {
    showToast('No se pudo acceder al micrófono', 'err');
    return;
  }

  recChunks = [];
  mediaRecorder = new MediaRecorder(stream, mimeType ? {mimeType: mimeType} : {});

  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) recChunks.push(e.data);
  };

  mediaRecorder.onstop = function() {
    stream.getTracks().forEach(function(t) { t.stop(); });
    isRecordingAudio = false;
    var btn = document.getElementById('rec-btn');
    var lbl = document.getElementById('rec-label');
    var ico = document.getElementById('rec-ico');
    var st  = document.getElementById('rec-status');
    if (btn) btn.classList.remove('recording');
    if (lbl) { lbl.textContent = 'Procesando...'; lbl.classList.remove('rec'); }
    if (ico) ico.className = 'ti ti-loader-2';
    if (st)  st.textContent = '';

    var ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    var blob = new Blob(recChunks, {type: mediaRecorder.mimeType || 'audio/webm'});
    sendAudioToServer(blob, 'recording.' + ext).then(function(text) {
      if (lbl) lbl.textContent = 'Tocá para grabar';
      if (ico) ico.className = 'ti ti-microphone';
      if (text) showAudioResult(text);
      else showToast('No se detectó audio con direcciones', 'err');
    }).catch(function(err) {
      if (lbl) lbl.textContent = 'Tocá para grabar';
      if (ico) ico.className = 'ti ti-microphone';
      showToast(err.message || 'Error al transcribir', 'err');
    });
  };

  mediaRecorder.start();
  isRecordingAudio = true;
  var btn = document.getElementById('rec-btn');
  var lbl = document.getElementById('rec-label');
  var ico = document.getElementById('rec-ico');
  if (btn) btn.classList.add('recording');
  if (lbl) { lbl.textContent = 'Grabando... tocá para detener'; lbl.classList.add('rec'); }
  if (ico) ico.className = 'ti ti-player-stop';
}

async function sendAudioToServer(blob, filename) {
  var fd = new FormData();
  fd.append('audio', blob, filename);
  var resp = await fetch('/api/transcribe', {method: 'POST', body: fd});
  var data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Error del servidor');
  return data.text || '';
}

function cleanTranscript(txt) {
  if (!txt) return '';
  var lines = txt.split('\n')
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 4; });

  var seen = [];
  var result = [];
  lines.forEach(function(line) {
    var norm = line.toLowerCase().replace(/\s+/g, ' ');
    // Skip if already seen, or if this line is a prefix of a longer one already kept (partial recognition)
    var isDup = seen.some(function(s) {
      return s === norm || s.startsWith(norm + ' ') || norm.startsWith(s + ' ');
    });
    if (!isDup) { seen.push(norm); result.push(line); }
  });
  return result.join('\n');
}

function updateAudioCounter() {
  var wrap = document.getElementById('audio-counter');
  var badge = document.getElementById('audio-counter-txt');
  if (!wrap || !badge) return;
  if (audioConfirmedLines > 0) {
    wrap.style.display = 'block';
    badge.textContent = audioConfirmedLines + (audioConfirmedLines === 1 ? ' dirección lista' : ' direcciones listas') + ' — seguí grabando o presioná Continuar';
  } else {
    wrap.style.display = 'none';
  }
}

function showAudioResult(txt) {
  var cleaned = cleanTranscript(txt);
  var res = document.getElementById('audio-result');
  var txtEl = document.getElementById('audio-txt');
  if (!cleaned) { if (res) res.style.display = 'none'; return; }
  if (res) res.style.display = 'block';
  if (txtEl) txtEl.value = cleaned;
}

function useAudioText() {
  var txtEl = document.getElementById('audio-txt');
  if (!txtEl || !txtEl.value.trim()) return;
  var raw = txtEl.value.trim();
  var lines = raw.split('\n').filter(function(l) { return l.trim().length > 2; });

  // Accumulate into the shared text buffer (mtxt) — stays hidden
  var mtxt = document.getElementById('mtxt');
  if (mtxt) mtxt.value = (mtxt.value ? mtxt.value + '\n' : '') + raw;

  // Update counter and stay in audio panel
  audioConfirmedLines += lines.length;
  updateAudioCounter();
  showToast(lines.length + (lines.length === 1 ? ' dirección agregada' : ' direcciones agregadas'), 'ok');

  // Clear current transcript, keep audio panel open
  txtEl.value = '';
  var res = document.getElementById('audio-result');
  if (res) res.style.display = 'none';
  audioTranscript = '';
}

function clearAudio() {
  audioTranscript = '';
  var res = document.getElementById('audio-result');
  if (res) res.style.display = 'none';
  var txtEl = document.getElementById('audio-txt');
  if (txtEl) txtEl.value = '';
  var interim = document.getElementById('mic-interim');
  if (interim) interim.textContent = '';
}

// ════════════════════════════════════════
// MAIN OPTIMIZATION PIPELINE
// ════════════════════════════════════════
async function runOptimization(txt, demoStops) {
  resetSteps();

  // Snapshot wizDepot immediately — guard against null/NaN from failed GPS or manual mode
  var snapDepot = wizDepot;
  if (!snapDepot || !snapDepot.lat || !snapDepot.lng || isNaN(snapDepot.lat) || isNaN(snapDepot.lng)) {
    step(0, 'er', 'Punto de partida sin coordenadas — volvé al paso 1');
    showToast('Elegí un punto de partida válido antes de optimizar', 'err');
    return;
  }
  DEPOT = {
    name:    snapDepot.name,
    address: snapDepot.address,
    lat:     snapDepot.lat,
    lng:     snapDepot.lng,
    isDepot: true,
  };

  step(0, 'ok', DEPOT.name + ' (' + DEPOT.lat.toFixed(4) + ', ' + DEPOT.lng.toFixed(4) + ')');

  step(1, 'r', 'Extrayendo direcciones...');
  var stops = [];

  if (demoStops) {
    stops = demoStops;
    step(1, 'ok', stops.length + ' paradas demo listas');
  } else if (pendingPDF) {
    try {
      stops = await extractPDFStops(pendingPDF);
      step(1, 'ok', stops.length + ' paradas extraídas del PDF');
    } catch(e) {
      step(1, 'er', e.message);
      showToast(e.message, 'err');
      return;
    }
  } else if (pendingImages.length) {
    try {
      stops = await callClaudeImages(pendingImages);
      step(1, 'ok', stops.length + ' paradas en ' + pendingImages.length + ' imagen' + (pendingImages.length > 1 ? 'es' : '') + ' (Claude Vision)');
    } catch(e) {
      step(1, 'er', 'Error procesando imágenes');
      showToast(e.message, 'err');
      return;
    }
  } else if (txt) {
    try {
      stops = await callClaudeText(txt);
      step(1, 'ok', stops.length + ' direcciones identificadas');
    } catch(e) {
      step(1, 'er', 'IA no disponible — modo local');
      stops = parseLocal(txt);
      step(1, 'ok', stops.length + ' paradas (modo local)');
    }
  } else {
    step(1, 'ok', 'Usando paradas manuales');
  }

  // Apply city to ALL stops including manual queue
  var _cityFieldId = pendingImages.length ? 'extract-city-inp-img' : 'extract-city-inp';
  var ecInp = document.getElementById(_cityFieldId);
  var ec = ecInp ? ecInp.value.trim() : '';
  stops = stops.concat(manualQueue);
  if (ec && stops.length) {
    stops = stops.map(function(s) {
      if (!s.address) return s;
      var addr = s.address.trim();
      if (addr.toLowerCase().indexOf(ec.toLowerCase()) === -1) {
        addr = addr + ', ' + ec;
      }
      return Object.assign({}, s, {address: addr});
    });
  }
  if (!stops.length) {
    showToast('Sin paradas para procesar', 'err');
    return;
  }

  step(2, 'r', 'Geocodificando ' + stops.length + ' paradas...');
  // Pre-cache city center so geocodeFull can use it as silent fallback
  if (CONFIG.baseCity && !baseCityCenter) await getBaseCityCenter();
  var geocoded = [];
  var geoOk = 0;
  for (var i = 0; i < stops.length; i++) {
    var g = await geocodeOne(stops[i].address);
    if (g.lat) geoOk++;
    geocoded.push(Object.assign({}, stops[i], {lat: g.lat, lng: g.lng, resolvedAddress: g.resolvedAddress, approxGeocode: g.approx, fallbackToCity: !!g.fallbackToCity}));
    await sleep(300);
  }
  step(2, 'ok', geoOk + ' de ' + stops.length + ' geocodificadas');

  var withCoords = geocoded.filter(function(s) { return s.lat && s.lng; });
  var noCoords   = geocoded.filter(function(s) { return !s.lat || !s.lng; });

  if (withCoords.length < 1) {
    step(2, 'er', 'Ninguna parada geocodificada — verificá la ciudad y el formato de direcciones');
    showToast('No se pudo ubicar ninguna parada. Verificá la ciudad ingresada.', 'err');
    return;
  }

  // Sort: deadline stops first (by time ascending), then normal stops
  var _prio = withCoords.filter(function(s) { return !!s.deadline; });
  var _norm = withCoords.filter(function(s) { return !s.deadline; });
  _prio.sort(function(a, b) { return (a.deadline || '').localeCompare(b.deadline || ''); });
  withCoords = _prio.concat(_norm);
  var nPriority = _prio.length;

  var allPts = [DEPOT].concat(withCoords);
  var OSRM_CHUNK = 15;
  var nPts = allPts.length;
  var totalChunks = Math.ceil(nPts / OSRM_CHUNK);
  step(3, 'r', 'Consultando OSRM (' + nPts + ' puntos' + (totalChunks > 1 ? ', ' + totalChunks + ' chunks' : '') + ')...');

  try {
    var mat = await osrmMatrixChunked(allPts, OSRM_CHUNK, function(cur, total) {
      if (total > 1) step(3, 'r', 'OSRM: ' + cur + '/' + total + ' chunks...');
    });
    distMatrix = mat.dists;
    durMatrix  = mat.durs;
    step(3, 'ok', nPts + 'x' + nPts + ' matriz OSRM — distancias reales por calles');

    // ── DEBUG: OSRM distance matrix (meters) ────────────────────────────────
    console.group('RouteOps DEBUG — OSRM distance matrix (m) — rows=FROM, cols=TO');
    var hdr = allPts.map(function(p, i) { return i + ':' + p.name.substring(0, 8); });
    console.log('        ' + hdr.join('  |  '));
    distMatrix.forEach(function(row, i) {
      console.log(i + ':' + allPts[i].name.substring(0, 6).padEnd(8) +
        row.map(function(d) { return String(Math.round(d)).padStart(6); }).join(' | '));
    });
    console.groupEnd();
  } catch(e) {
    step(3, 'er', 'OSRM no disponible — usando distancia geodésica');
    distMatrix = buildHavMatrix(allPts);
    // d in meters → km → hours at 30 km/h → seconds
    durMatrix  = distMatrix.map(function(row) {
      return row.map(function(d) { return d / 1000 / 30 * 3600; });
    });
  }

  // ── Detect multi-city ────────────────────────────────────────────────────────
  // Only group if stops are geographically dispersed (< 70% within 20 km of each other).
  // Addresses without explicit city/CP (e.g. "Castelli 553", "Santa Fe 618") would otherwise
  // create phantom groups — isSingleCity prevents that.
  var groupsMap = {};
  var isMultiCity = false;
  if (!isSingleCity(withCoords)) {
    groupsMap = clusterByPostalCode(withCoords);
    isMultiCity = Object.keys(groupsMap).length > 1;
  }

  var indices = withCoords.map(function(_, i) { return i + 1; });
  var seedRoute, optRoute, kmOpt, minOpt, kmSeed, saved, routeGroups;

  if (isMultiCity) {
    // ── Multi-city path ───────────────────────────────────────────────────────
    var groupKeys = Object.keys(groupsMap);
    step(4, 'r', 'Agrupando ' + groupKeys.length + ' zonas...');
    await sleep(200);

    seedRoute = nnFromMatrix(0, indices, distMatrix);
    kmSeed = routeDistKm(seedRoute, distMatrix);
    step(4, 'ok', groupKeys.length + ' zonas: ' + groupKeys.map(function(k) {
      return k + ' (' + groupsMap[k].indices.length + ')';
    }).join(' · '));

    step(5, 'r', 'Optimizando cada zona por separado...');
    await sleep(200);
    var grpResult = optimizeGroups(groupsMap, withCoords, distMatrix);
    optRoute    = grpResult.route;
    routeGroups = grpResult.groups;
    kmOpt  = routeDistKm(optRoute, distMatrix);
    minOpt = routeDurMin(optRoute, durMatrix);
    saved  = kmSeed - kmOpt;
    step(5, 'ok', 'Multi-zona NN+2-opt: ' + kmOpt.toFixed(1) + ' km · −' + saved.toFixed(1) + ' km');

  } else {
    // ── Single-city path ─────────────────────────────────────────────────────

    if (nPriority > 0) {
      // ── Priority-aware: deadlined stops first, then normal stops ─────────────
      var pIdxs = indices.slice(0, nPriority);
      var nIdxs = indices.slice(nPriority);

      step(4, 'r', nPriority + ' parada' + (nPriority !== 1 ? 's' : '') + ' con horario límite · priorizando...');
      await sleep(200);

      var pRoute;
      if (pIdxs.length === 1) {
        pRoute = pIdxs.slice();
      } else {
        pRoute = nnFromMatrix(0, pIdxs.slice(), distMatrix);
        if (pIdxs.length <= 25) pRoute = twoOptMatrix(pRoute, distMatrix, 0).route;
      }
      kmSeed = routeDistKm(pRoute, distMatrix);
      step(4, 'ok', nPriority + ' prioritaria' + (nPriority !== 1 ? 's' : '') + ' al inicio · ' + kmSeed.toFixed(1) + ' km');

      step(5, 'r', 'Optimizando ' + nIdxs.length + ' parada' + (nIdxs.length !== 1 ? 's' : '') + ' restante' + (nIdxs.length !== 1 ? 's' : '') + '...');
      await sleep(200);

      var fromP = pRoute.length ? pRoute[pRoute.length - 1] : 0;
      var nRoute;
      if (nIdxs.length === 0) {
        nRoute = [];
      } else if (nIdxs.length === 1) {
        nRoute = nIdxs.slice();
      } else if (nIdxs.length > 25) {
        nRoute = nnFromMatrix(fromP, nIdxs.slice(), distMatrix);
      } else {
        nRoute = nnFromMatrix(fromP, nIdxs.slice(), distMatrix);
        nRoute = twoOptMatrix(nRoute, distMatrix, fromP).route;
        nRoute = orOpt1(nRoute, distMatrix).route;
      }

      optRoute = pRoute.concat(nRoute);
      seedRoute = optRoute;
      kmOpt  = routeDistKm(optRoute, distMatrix);
      minOpt = routeDurMin(optRoute, durMatrix);
      saved  = 0;
      step(5, 'ok', 'Horarios respetados · ' + kmOpt.toFixed(1) + ' km total');

    } else {
      // ── Standard: no priority stops ─────────────────────────────────────────
      step(4, 'r', 'Nearest neighbor desde punto de salida...');
      await sleep(200);
      seedRoute = nnFromMatrix(0, indices, distMatrix);
      kmSeed = routeDistKm(seedRoute, distMatrix);
      step(4, 'ok', 'Ruta inicial: ' + kmSeed.toFixed(1) + ' km');

      // ── DEBUG: NN seed route ──────────────────────────────────────────────
      console.group('RouteOps DEBUG — NN seed route');
      console.log('0:' + DEPOT.name + ' (depot)');
      seedRoute.forEach(function(idx, pos) {
        var s = withCoords[idx - 1];
        var d = ((distMatrix[pos === 0 ? 0 : seedRoute[pos - 1]] || [])[idx] || 0);
        console.log((pos + 1) + '. [mat:' + idx + '] ' + s.name + ' — ' + Math.round(d) + 'm from prev');
      });
      console.log('Total NN: ' + kmSeed.toFixed(3) + ' km (round-trip)');
      console.groupEnd();

      if (withCoords.length > 25) {
        optRoute = seedRoute;
        kmOpt  = kmSeed;
        minOpt = routeDurMin(optRoute, durMatrix);
        saved  = 0;
        step(5, 'ok', 'NN (ruta grande): ' + kmOpt.toFixed(1) + ' km');
      } else {
        step(5, 'r', 'Aplicando 2-opt + or-opt...');
        await sleep(200);
        var twoOptResult = twoOptMatrix(seedRoute, distMatrix);
        var orOptResult  = orOpt1(twoOptResult.route, distMatrix);
        optRoute = orOptResult.route;
        kmOpt  = routeDistKm(optRoute, distMatrix);
        minOpt = routeDurMin(optRoute, durMatrix);
        saved  = kmSeed - kmOpt;
        step(5, 'ok', '2-opt+or-opt: ' + kmOpt.toFixed(1) + ' km · −' + saved.toFixed(1) + ' km');
      }
    }
  }

  // ── DEBUG: final optimized route ──────────────────────────────────────────
  console.group('RouteOps DEBUG — final optimized route');
  console.log('0:' + DEPOT.name + ' (depot) | lat ' + DEPOT.lat.toFixed(6) + ' lng ' + DEPOT.lng.toFixed(6));
  optRoute.forEach(function(idx, pos) {
    var s = withCoords[idx - 1];
    var prevIdx = pos === 0 ? 0 : optRoute[pos - 1];
    var d = ((distMatrix[prevIdx] || [])[idx] || 0);
    console.log((pos + 1) + '. [mat:' + idx + '] ' + s.name +
      ' | lat ' + s.lat.toFixed(6) + ' lng ' + s.lng.toFixed(6) +
      ' | ' + Math.round(d) + 'm from prev');
  });
  var retD = ((distMatrix[optRoute[optRoute.length - 1]] || [])[0] || 0);
  console.log('↩ return to depot: ' + Math.round(retD) + 'm');
  console.log('Total: ' + kmOpt.toFixed(3) + ' km round-trip | saved vs NN: ' + saved.toFixed(3) + ' km');
  console.groupEnd();

  step(6, 'r', 'Trazando en mapa...');
  await sleep(300);
  step(6, 'ok', 'Mapa listo');

  var fullRoute = [{
    name: DEPOT.name, address: DEPOT.address, lat: DEPOT.lat, lng: DEPOT.lng,
    isDepot: true, done: false, failed: false, distKm: '0', durMin: 0, cumMin: 0, order: 0,
    eta: 'Punto de salida'
  }];

  var cumMin = 0;

  if (isMultiCity && routeGroups) {
    var flatPos = 0;
    routeGroups.forEach(function(group, gi) {
      var color = CITY_COLORS[gi % CITY_COLORS.length];
      var cityLabel = capitalizeWords(group.name);
      fullRoute.push({isCityHeader: true, cityName: cityLabel, stopCount: group.indices.length, cityIdx: gi, cityColor: color});
      group.indices.forEach(function(idx) {
        var s = withCoords[idx - 1];
        var prevIdx = flatPos === 0 ? 0 : optRoute[flatPos - 1];
        var dM = ((distMatrix[prevIdx] || [])[idx] || 0) / 1000;
        var durS = (durMatrix[prevIdx] || [])[idx] || 0;
        var durM = Math.round(durS / 60);
        cumMin += durM + 2;
        fullRoute.push(Object.assign({}, s, {
          isDepot: false, done: false, failed: false, order: flatPos + 1,
          cityName: cityLabel, cityIdx: gi, cityColor: color,
          distKm: dM.toFixed(2), durMin: durM, cumMin: cumMin, eta: fmtMin(cumMin)
        }));
        flatPos++;
      });
    });
  } else {
    optRoute.forEach(function(idx, i) {
      var s = withCoords[idx - 1];
      var prevIdx = i === 0 ? 0 : optRoute[i - 1];
      var dM = ((distMatrix[prevIdx] || [])[idx] || 0) / 1000;
      var durS = (durMatrix[prevIdx] || [])[idx] || 0;
      var durM = Math.round(durS / 60);
      cumMin += durM + 2;
      fullRoute.push(Object.assign({}, s, {
        isDepot: false, done: false, failed: false, order: i + 1,
        distKm: dM.toFixed(2), durMin: durM, cumMin: cumMin, eta: fmtMin(cumMin)
      }));
    });
  }

  noCoords.forEach(function(s, i) {
    fullRoute.push(Object.assign({}, s, {
      isDepot: false, done: false, failed: false, order: optRoute.length + i + 1,
      distKm: null, durMin: 0, cumMin: 0, eta: '—'
    }));
  });

  // Return-to-depot leg
  var lastIdx = optRoute.length > 0 ? optRoute[optRoute.length - 1] : 0;
  var retM   = ((distMatrix[lastIdx] || [])[0] || 0);
  var retDurM = Math.round(((durMatrix[lastIdx] || [])[0] || 0) / 60);
  cumMin += retDurM;
  fullRoute.push({
    name: DEPOT.name, address: DEPOT.address, lat: DEPOT.lat, lng: DEPOT.lng,
    isDepot: true, isReturn: true, done: false, failed: false, order: 0,
    distKm: (retM / 1000).toFixed(2), durMin: retDurM, cumMin: cumMin, eta: fmtMin(cumMin)
  });

  R = fullRoute;
  saveRouteToStorage();
  showResults(R, kmOpt, saved, Math.round(minOpt));
}

// ════════════════════════════════════════
// PDF EXTRACTION (Flask backend)
// ════════════════════════════════════════
async function extractPDFStops(file) {
  var formData = new FormData();
  formData.append('pdf', file);

  var resp = await fetch(CONFIG.apiBase + '/api/extract-pdf', {
    method: 'POST',
    body: formData,
  });

  if (!resp.ok) {
    var err = await resp.json().catch(function() { return {}; });
    if (err.traceback) {
      console.error('[RouteOps] PDF server error — ' + (err.exception_type || 'Error') + '\n' + err.traceback);
    }
    throw new Error(err.error || 'Error del servidor (' + resp.status + ')');
  }

  var data = await resp.json();

  // If server returned parsed stops (via Claude on backend), use them directly
  if (data.stops && data.stops.length > 0) {
    return data.stops;
  }

  // If server returned raw text, parse locally
  if (data.text) {
    return parseLocal(data.text);
  }

  throw new Error('El PDF no contiene texto legible');
}

// ════════════════════════════════════════
// CLAUDE API (text method, browser-side)
// ════════════════════════════════════════
async function callClaudeText(txt) {
  var resp = await fetch(CONFIG.apiBase + '/api/extract-addresses', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text: txt}),
  });

  if (!resp.ok) throw new Error('api ' + resp.status);

  var data = await resp.json();
  if (data.stops && data.stops.length > 0) return data.stops;
  if (data.text) return parseLocal(data.text);
  throw new Error('Sin resultados');
}

function parseLocal(txt) {
  return txt.split('\n')
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 5; })
    .map(function(l) {
      var clean = l.replace(/^\d+[\.\-\)]\s*/, '');
      return {name: clean.split(',')[0] || clean, address: clean};
    });
}

// ════════════════════════════════════════
// OSRM TABLE SERVICE
// ════════════════════════════════════════
function osrmMatrix(pts) {
  var coords = pts.map(function(p) { return p.lng + ',' + p.lat; }).join(';');
  var url = 'https://router.project-osrm.org/table/v1/driving/' + coords + '?annotations=distance,duration';
  return new Promise(function(resolve, reject) {
    var timeout = setTimeout(function() { reject(new Error('timeout')); }, 12000);
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        clearTimeout(timeout);
        if (d.code !== 'Ok') { reject(new Error('osrm: ' + d.code)); return; }
        resolve({dists: d.distances, durs: d.durations});
      })
      .catch(function(e) { clearTimeout(timeout); reject(e); });
  });
}

// Split into source-chunks of chunkSize; calls onProgress(cur, total) before each chunk.
async function osrmMatrixChunked(pts, chunkSize, onProgress) {
  var n = pts.length;
  var coords = pts.map(function(p) { return p.lng + ',' + p.lat; }).join(';');
  var allDst = pts.map(function(_, i) { return i; }).join(';');
  var dists  = pts.map(function() { return new Array(n).fill(0); });
  var durs   = pts.map(function() { return new Array(n).fill(0); });
  var totalChunks = Math.ceil(n / chunkSize);

  for (var c = 0; c < totalChunks; c++) {
    var start = c * chunkSize;
    var srcArr = [];
    for (var i = start; i < Math.min(start + chunkSize, n); i++) srcArr.push(i);
    if (onProgress) onProgress(c + 1, totalChunks);

    var url = 'https://router.project-osrm.org/table/v1/driving/' + coords +
              '?sources=' + srcArr.join(';') + '&destinations=' + allDst +
              '&annotations=distance,duration';

    var data = await new Promise(function(resolve, reject) {
      var t = setTimeout(function() { reject(new Error('timeout')); }, 18000);
      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(d) { clearTimeout(t); resolve(d); })
        .catch(function(e) { clearTimeout(t); reject(e); });
    });

    if (data.code !== 'Ok') throw new Error('osrm: ' + data.code);
    srcArr.forEach(function(rowIdx, ci) {
      dists[rowIdx] = data.distances[ci];
      durs[rowIdx]  = data.durations[ci];
    });
  }
  return {dists: dists, durs: durs};
}

function buildHavMatrix(pts) {
  return pts.map(function(a) {
    return pts.map(function(b) { return hav(a.lat, a.lng, b.lat, b.lng) * 1000; });
  });
}

function routeDistKm(idxArr, mat) {
  var t = 0, prev = 0;
  idxArr.forEach(function(i) { t += ((mat[prev] || [])[i] || 0); prev = i; });
  t += ((mat[prev] || [])[0] || 0); // return to depot
  return t / 1000;
}

function routeDurMin(idxArr, mat) {
  var t = 0, prev = 0;
  idxArr.forEach(function(i) { t += ((mat[prev] || [])[i] || 0); prev = i; });
  t += ((mat[prev] || [])[0] || 0); // return to depot
  return t / 60;
}

// ════════════════════════════════════════
// ALGORITHMS
// ════════════════════════════════════════
function nnFromMatrix(startIdx, remaining, mat) {
  var rem = remaining.slice();
  var route = [];
  var cur = startIdx;
  while (rem.length) {
    var best = 0, bestCost = Infinity;
    rem.forEach(function(idx, i) {
      var toNext = ((mat[cur] || [])[idx]) || Infinity;
      // Weight return-to-depot cost: full when 1 stop left, diminishing as more remain
      var returnW = 1 / rem.length;
      var toDepot = ((mat[idx] || [])[0]) || 0;
      var cost = toNext + returnW * toDepot;
      if (cost < bestCost) { bestCost = cost; best = i; }
    });
    cur = rem[best];
    route.push(cur);
    rem.splice(best, 1);
  }
  return route;
}

function twoOptMatrix(route, mat, fromIdx) {
  fromIdx = fromIdx !== undefined ? fromIdx : 0;
  var best = route.slice();
  var improved = true, iters = 0, totalImp = 0;
  var n = best.length;
  while (improved && iters < 1000) {
    improved = false;
    iters++;
    for (var i = 0; i < n - 1; i++) {
      for (var j = i + 2; j < n; j++) {
        var pi  = i === 0 ? fromIdx : best[i - 1];
        var nj  = j === n - 1 ? fromIdx : best[j + 1];
        var bi  = best[i];
        var bj  = best[j];
        // Full segment cost forward: pi→best[i]→...→best[j]→nj
        var costFwd = ((mat[pi] || [])[bi] || 0);
        for (var k = i; k < j; k++) costFwd += ((mat[best[k]] || [])[best[k + 1]] || 0);
        costFwd += ((mat[bj] || [])[nj] || 0);
        // Full segment cost reversed: pi→best[j]→...→best[i]→nj
        var costRev = ((mat[pi] || [])[bj] || 0);
        for (var k = j; k > i; k--) costRev += ((mat[best[k]] || [])[best[k - 1]] || 0);
        costRev += ((mat[bi] || [])[nj] || 0);
        if (costRev < costFwd - 1) {
          var lo = i, hi = j;
          while (lo < hi) {
            var tmp = best[lo]; best[lo] = best[hi]; best[hi] = tmp;
            lo++; hi--;
          }
          improved = true;
          totalImp++;
        }
      }
    }
  }
  return {route: best, iters: iters, improved: totalImp};
}

function fullTourCost(route, mat) {
  var t = 0, prev = 0;
  for (var k = 0; k < route.length; k++) {
    t += ((mat[prev] || [])[route[k]] || 0);
    prev = route[k];
  }
  t += ((mat[prev] || [])[0] || 0); // return to depot
  return t;
}

// Or-opt-1: relocate each single stop to every other position.
// Correct for asymmetric (OSRM) distances — no segment reversal.
function orOpt1(route, mat) {
  var best = route.slice();
  var improved = true, iters = 0;
  var n = best.length;
  while (improved && iters < 300) {
    improved = false;
    iters++;
    var bestCost = fullTourCost(best, mat);
    var found = false;
    for (var i = 0; i < n && !found; i++) {
      var stop = best[i];
      var without = best.slice(0, i).concat(best.slice(i + 1));
      for (var j = 0; j <= without.length && !found; j++) {
        if (j === i) continue; // same effective position
        var candidate = without.slice(0, j).concat([stop], without.slice(j));
        var cost = fullTourCost(candidate, mat);
        if (cost < bestCost - 0.5) {
          best = candidate;
          bestCost = cost;
          improved = true;
          found = true;
        }
      }
    }
  }
  return {route: best, iters: iters};
}

function hav(a, b, c, d) {
  var R = 6371;
  var dl = (c - a) * Math.PI / 180;
  var dn = (d - b) * Math.PI / 180;
  var x = Math.sin(dl/2)*Math.sin(dl/2) +
          Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dn/2)*Math.sin(dn/2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function fmtMin(m) {
  var h = Math.floor(m / 60), mn = m % 60;
  return h > 0 ? '~' + h + 'h ' + mn + ' min desde salida' : '~' + mn + ' min desde salida';
}

// ════════════════════════════════════════
// MULTI-CITY GROUPING
// ════════════════════════════════════════

var CITY_COLORS = ['#34d399','#60a5fa','#f59e0b','#f87171','#a78bfa','#38bdf8','#4ade80','#fb923c'];

function capitalizeWords(s) {
  return (s || '').replace(/\b(\w)/g, function(m) { return m.toUpperCase(); });
}

// Argentine provinces — used to skip them when extracting locality
var AR_PROVINCES = /^(buenos aires|santa fe|c[oó]rdoba|mendoza|tucum[aá]n|salta|jujuy|neuqu[eé]n|r[ií]o negro|chubut|santa cruz|tierra del fuego|misiones|corrientes|formosa|chaco|entre r[ií]os|san juan|san luis|la rioja|catamarca|santiago del estero|la pampa|ciudad aut[oó]noma de buenos aires|caba)$/i;

// Returns the 4-digit Argentine postal code from addr, or '' if not found.
// Skips the first comma-segment (street + house number) to avoid matching house numbers.
// Handles both standalone "2627" and "CP2627" / "CP 2627" formats.
function extractPostalCode(addr) {
  if (!addr) return '';
  // 1) Prefijo explícito CP#### en cualquier parte
  var cp = addr.match(/\bCP\s*(\d{4})\b/i);
  if (cp) return cp[1];
  var parts = addr.split(',');
  var first = parts[0].trim();
  // 2) Primer segmento es exactamente 4 dígitos: "2173, CHABAS"
  if (/^\d{4}$/.test(first)) return first;
  // 3) Primer segmento empieza con 4 dígitos seguidos de texto: "2173 CHABAS"
  var lead = first.match(/^(\d{4})\s+\S/);
  if (lead) return lead[1];
  // 4) 4 dígitos en los segmentos siguientes: "Rivadavia 150, 2173 CHABAS"
  var rest = parts.slice(1).join(',');
  var m = rest.match(/\b(\d{4})\b/);
  return m ? m[1] : '';
}

function extractLocality(addr) {
  if (!addr) return '';
  var parts = addr.split(',').map(function(p) { return p.trim(); });
  for (var i = 1; i < parts.length; i++) {
    var p = parts[i];
    if (!p || p.length < 3) continue;
    if (/^\d{4,}$/.test(p)) continue;
    if (/^argentina$/i.test(p)) continue;
    if (AR_PROVINCES.test(p)) continue;
    // Segmento "2173 CHABAS" o "CP2627 Venado Tuerto" → quitar el CP del inicio
    return p.replace(/^CP\s*\d{4}\s+/i, '').replace(/^\d{4}\s+/, '').trim().toLowerCase();
  }
  // parts[0] puede ser "2173 CHABAS" o "CP2627 Venado Tuerto" (CP + ciudad sin coma separada)
  var first = (parts[0] || '').trim();
  var codeCity = first.match(/^\d{4}\s+(.+)$/) || first.match(/^CP\s*\d{4}\s+(.+)$/i);
  if (codeCity) return codeCity[1].trim().toLowerCase();
  return first.toLowerCase();
}

function groupByLocality(withCoords) {
  var groups = {};
  withCoords.forEach(function(s, i) {
    var city = extractLocality(s.resolvedAddress || s.address) || 'sin-ciudad';
    if (!groups[city]) groups[city] = {name: city, indices: []};
    groups[city].indices.push(i + 1); // 1-based matrix index
  });
  return groups;
}

// Returns true when ALL stops are within 20 km of the densest point.
// When true, all stops should be treated as a single city — no grouping.
function isSingleCity(withCoords) {
  if (withCoords.length < 2) return true;
  var RADIUS_KM = 20;
  var n = withCoords.length;
  var best = 0;
  for (var a = 0; a < n; a++) {
    var count = 0;
    for (var b = 0; b < n; b++) {
      if (hav(withCoords[a].lat, withCoords[a].lng,
              withCoords[b].lat, withCoords[b].lng) <= RADIUS_KM) count++;
    }
    if (count > best) best = count;
  }
  return best >= n;
}

// Group stops by postal code (primary) → city name (fallback) → geo proximity (last resort).
// Returns groupsMap: {label: {name: label, indices: [1-based]}}
function clusterByPostalCode(withCoords) {
  var GEO_RADIUS_KM = 5;
  var clusters = []; // {key, name, lat, lng, count, indices}

  function findByKey(key) {
    for (var i = 0; i < clusters.length; i++) {
      if (clusters[i].key === key) return clusters[i];
    }
    return null;
  }

  function updateCentroid(c, lat, lng) {
    if (lat && lng) {
      c.count++;
      c.lat = c.lat !== null ? c.lat + (lat - c.lat) / c.count : lat;
      c.lng = c.lng !== null ? c.lng + (lng - c.lng) / c.count : lng;
    }
  }

  function isValidCity(s) {
    return s && s.length >= 3 && !/^\d/.test(s) && !/\d{3,}/.test(s);
  }

  withCoords.forEach(function(s, i) {
    var idx = i + 1;
    var cp   = extractPostalCode(s.address) || extractPostalCode(s.resolvedAddress || '');
    var city = extractLocality(s.address)   || extractLocality(s.resolvedAddress || '') || '';

    var key, label;
    if (cp) {
      key   = 'cp:' + cp;
      label = 'CP ' + cp + (isValidCity(city) ? ' · ' + capitalizeWords(city) : '');
    } else if (isValidCity(city)) {
      key   = 'city:' + city;
      label = capitalizeWords(city);
    } else {
      key = null;
    }

    if (key) {
      var c = findByKey(key);
      if (c) {
        c.indices.push(idx);
        updateCentroid(c, s.lat, s.lng);
      } else {
        clusters.push({key: key, name: label, lat: s.lat || null, lng: s.lng || null, count: 1, indices: [idx]});
      }
      return;
    }

    // Intento extra: extraer ciudad del resolvedAddress de Nominatim
    var resolvedCity = extractLocality(s.resolvedAddress || '');
    if (isValidCity(resolvedCity)) {
      var rKey = 'city:' + resolvedCity;
      var rc = findByKey(rKey);
      if (rc) {
        rc.indices.push(idx);
        updateCentroid(rc, s.lat, s.lng);
      } else {
        clusters.push({key: rKey, name: capitalizeWords(resolvedCity), lat: s.lat || null, lng: s.lng || null, count: 1, indices: [idx]});
      }
      return;
    }

    // Geo fallback: solo agrupa con cluster MISMO ciudad (radio 1 km) para no mezclar pueblos distintos
    if (s.lat && s.lng) {
      var bestC = null, bestD = Infinity;
      clusters.forEach(function(c) {
        if (c.lat === null) return;
        var d = hav(s.lat, s.lng, c.lat, c.lng);
        if (d < bestD) { bestD = d; bestC = c; }
      });
      if (bestC && bestD < 1.0) {
        bestC.indices.push(idx);
        updateCentroid(bestC, s.lat, s.lng);
      } else {
        var autoLabel = 'Zona ' + (clusters.length + 1);
        clusters.push({key: 'geo:' + clusters.length, name: autoLabel, lat: s.lat, lng: s.lng, count: 1, indices: [idx]});
      }
    } else {
      var none = findByKey('none');
      if (none) { none.indices.push(idx); }
      else { clusters.push({key: 'none', name: 'Sin código', lat: null, lng: null, count: 1, indices: [idx]}); }
    }
  });

  var groupsMap = {};
  clusters.forEach(function(c) {
    var k = c.name, n = 2;
    while (groupsMap[k]) { k = c.name + '-' + n++; }
    groupsMap[k] = {name: k, indices: c.indices};
  });
  return groupsMap;
}

function groupCentroid(indices, withCoords) {
  var lat = 0, lng = 0;
  indices.forEach(function(idx) { lat += withCoords[idx - 1].lat; lng += withCoords[idx - 1].lng; });
  return {lat: lat / indices.length, lng: lng / indices.length};
}

function orderGroupsByProximity(groupsMap, withCoords) {
  var groups = Object.keys(groupsMap).map(function(k) {
    var g = groupsMap[k];
    return {name: k, indices: g.indices, centroid: groupCentroid(g.indices, withCoords)};
  });
  // NN on group centroids starting from depot
  var ordered = [], rem = groups.slice();
  var curLat = DEPOT.lat, curLng = DEPOT.lng;
  while (rem.length) {
    var best = 0, bestDist = Infinity;
    rem.forEach(function(g, i) {
      var d = hav(curLat, curLng, g.centroid.lat, g.centroid.lng);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    ordered.push(rem[best]);
    curLat = rem[best].centroid.lat;
    curLng = rem[best].centroid.lng;
    rem.splice(best, 1);
  }
  return ordered;
}

function optimizeGroups(groupsMap, withCoords, distMatrix) {
  if (Object.keys(groupsMap).length <= 1) return null;

  var ordered = orderGroupsByProximity(groupsMap, withCoords);

  // Groups with deadline stops go first
  ordered.sort(function(a, b) {
    var aHas = a.indices.some(function(idx) { return !!withCoords[idx - 1].deadline; });
    var bHas = b.indices.some(function(idx) { return !!withCoords[idx - 1].deadline; });
    return (aHas ? 0 : 1) - (bHas ? 0 : 1);
  });

  var optRoute = [], fromIdx = 0;
  var routeGroups = [];

  ordered.forEach(function(group) {
    var prio = group.indices.filter(function(idx) { return !!withCoords[idx - 1].deadline; });
    var norm = group.indices.filter(function(idx) { return !withCoords[idx - 1].deadline; });
    prio.sort(function(a, b) {
      return (withCoords[a - 1].deadline || '').localeCompare(withCoords[b - 1].deadline || '');
    });

    var gr = [];
    if (prio.length) {
      var pr = prio.length === 1 ? prio.slice() : nnFromMatrix(fromIdx, prio.slice(), distMatrix);
      if (prio.length > 1 && prio.length <= 25) pr = twoOptMatrix(pr, distMatrix, fromIdx).route;
      gr = gr.concat(pr);
      fromIdx = pr[pr.length - 1];
    }
    if (norm.length) {
      var nr = norm.length === 1 ? norm.slice() : nnFromMatrix(fromIdx, norm.slice(), distMatrix);
      if (norm.length > 1 && norm.length <= 25) nr = twoOptMatrix(nr, distMatrix, fromIdx).route;
      gr = gr.concat(nr);
      fromIdx = nr[nr.length - 1];
    }

    routeGroups.push({name: group.name, indices: gr});
    optRoute = optRoute.concat(gr);
  });

  return {route: optRoute, groups: routeGroups};
}

// ════════════════════════════════════════
// GEOCODE
// ════════════════════════════════════════

async function geocacheGet(addr) {
  try {
    var r = await fetch('/api/geocode/cache?addr=' + encodeURIComponent(addr));
    if (!r.ok) return null;
    var d = await r.json();
    if (d.found) return d;
  } catch(e) {}
  return null;
}

function geocacheSave(addr, lat, lng, resolvedAddress) {
  try {
    fetch('/api/geocode/cache', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({addr: addr, lat: lat, lng: lng, resolvedAddress: resolvedAddress || addr})
    }).catch(function() {});
  } catch(e) {}
}

async function geocodeWithGoogle(addr) {
  if (!CONFIG.googleMapsKey) return null;
  try {
    var url = 'https://maps.googleapis.com/maps/api/geocode/json' +
      '?address=' + encodeURIComponent(addr) +
      '&key=' + CONFIG.googleMapsKey +
      '&language=es&region=ar';
    var data = await fetch(url).then(function(r) { return r.json(); });
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      var res = data.results[0];
      var loc = res.geometry.location;
      var approx = res.geometry.location_type !== 'ROOFTOP' &&
                   res.geometry.location_type !== 'RANGE_INTERPOLATED';
      return {lat: loc.lat, lng: loc.lng, resolvedAddress: res.formatted_address, approx: approx};
    }
    // REQUEST_DENIED / OVER_QUERY_LIMIT → warn once, then fall through to Nominatim
    if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') {
      console.warn('Google Maps Geocoding:', data.status, data.error_message || '');
    }
  } catch(e) {
    console.warn('Google Maps Geocoding error:', e.message);
  }
  return null;
}

async function nominatimSearch(q) {
  try {
    var d = await fetch(
      'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) +
      '&format=json&limit=1',
      {headers: {'Accept-Language': 'es', 'User-Agent': 'RouteOps/1.0'}}
    ).then(function(r) { return r.json(); });
    if (d && d.length) return {lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon)};
  } catch(e) {}
  return null;
}

async function geocodeFull(addr) {
  var r1 = resolveAddress(addr);

  // Attempt 0: SQLite geocache local — respuesta instantánea sin red
  var cached = await geocacheGet(r1);
  if (cached) {
    return {lat: cached.lat, lng: cached.lng, resolvedAddress: cached.resolvedAddress, approx: false, fromCache: true};
  }

  // Attempt 1: Google Maps (when key is set) — best for small Argentine cities
  if (CONFIG.googleMapsKey) {
    var g = await geocodeWithGoogle(r1);
    if (g) {
      if (!g.approx) geocacheSave(r1, g.lat, g.lng, g.resolvedAddress || r1);
      return g;
    }
    await sleep(100);
  }

  // Attempt 2: Nominatim — full resolved address
  var g = await nominatimSearch(r1);
  if (g) {
    geocacheSave(r1, g.lat, g.lng, r1);
    return {lat: g.lat, lng: g.lng, resolvedAddress: r1, approx: false};
  }
  await sleep(250);

  var parts = r1.split(',');
  var street = parts[0] ? parts[0].trim() : '';

  // Attempt 3: Nominatim — street+number + only first city token
  if (parts.length >= 2) {
    var alt2 = street + ', ' + parts[1].trim();
    if (alt2 !== r1) {
      g = await nominatimSearch(alt2);
      if (g) {
        geocacheSave(r1, g.lat, g.lng, alt2);
        return {lat: g.lat, lng: g.lng, resolvedAddress: alt2, approx: true};
      }
      await sleep(250);
    }
  }

  // Attempt 4: Nominatim — street name without house number + city
  var streetNoNum = street.replace(/\s+\d[\d\-\/]*[a-zA-Z]?\s*$/, '').trim();
  if (streetNoNum && streetNoNum !== street && parts.length >= 2) {
    var citySuffix = parts.slice(1).join(',').trim();
    var alt3 = streetNoNum + ', ' + citySuffix;
    g = await nominatimSearch(alt3);
    if (g) {
      geocacheSave(r1, g.lat, g.lng, alt3);
      return {lat: g.lat, lng: g.lng, resolvedAddress: alt3, approx: true};
    }
  }

  // Attempt 5: city center as automatic silent fallback — never block the user
  if (baseCityCenter) {
    return {lat: baseCityCenter.lat, lng: baseCityCenter.lng, resolvedAddress: r1, approx: true, fallbackToCity: true};
  }

  return {lat: null, lng: null, resolvedAddress: r1, approx: false, fallbackToCity: false};
}

function geocodeOne(addr) {
  return geocodeFull(addr);
}

// ── Pin placement modal ───────────────────────────────────────────────────────
var pinLMap = null, pinLMarker = null, pinTargetIdx = -1, pinTargetType = 'stop';

function _initPinMap(startLat, startLng) {
  if (!pinLMap) {
    pinLMap = L.map('pin-lmap', {zoomControl: true, attributionControl: false})
      .setView([startLat, startLng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19}).addTo(pinLMap);
  } else {
    pinLMap.setView([startLat, startLng], 15);
  }
  var pinIcon = L.divIcon({
    html: '<div style="width:28px;height:28px;background:#34d399;border-radius:50% 50% 50% 0;border:3px solid #031a0e;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>',
    iconSize: [28, 28], iconAnchor: [14, 28], className: '',
  });
  if (pinLMarker) { pinLMarker.setLatLng([startLat, startLng]); }
  else { pinLMarker = L.marker([startLat, startLng], {draggable: true, icon: pinIcon}).addTo(pinLMap); }
  pinLMap.invalidateSize();
}

async function _openPinModal(title, startLat, startLng) {
  document.getElementById('pin-modal-title').textContent = title;
  document.getElementById('pin-modal').style.display = 'flex';
  if (!startLat) {
    var c = baseCityCenter || await getBaseCityCenter();
    startLat = c ? c.lat : -33.74;
    startLng = c ? c.lng : -61.55;
  }
  setTimeout(function() { _initPinMap(startLat, startLng); }, 80);
}

async function openPinPlacementForDepot() {
  pinTargetType = 'depot';
  pinTargetIdx = -1;
  var inp = document.getElementById('dep-inp');
  var title = (inp && inp.value.trim()) || 'Punto de salida';
  await _openPinModal(title, null, null);
}

function confirmPinPlacement() {
  if (!pinLMarker) return;
  var ll = pinLMarker.getLatLng();
  document.getElementById('pin-modal').style.display = 'none';

  if (pinTargetType === 'depot') {
    var inp = document.getElementById('dep-inp');
    var addr = (inp && inp.value.trim()) || 'Punto de salida';
    setWizDepot('Punto de salida', addr, ll.lat, ll.lng);
    var st = document.getElementById('dep-status');
    if (st) { st.style.color = '#34d399'; st.textContent = '✓ Ubicaci\xf3n confirmada en el mapa'; }
    pinTargetIdx = -1;
    return;
  }
}

function cancelPinPlacement() {
  document.getElementById('pin-modal').style.display = 'none';
  pinTargetIdx = -1;
}

// ════════════════════════════════════════
// RESULTS UI
// ════════════════════════════════════════
function showResults(stops, km, saved, totalMin) {
  _lastResultKm = km;
  _lastResultSaved = saved;
  _lastResultMin = totalMin || 0;

  var pw = document.getElementById('proc-wrap');
  if (pw) pw.style.display = 'none';
  document.getElementById('wresults').style.display = 'block';
  document.getElementById('ws3-t').textContent = '\xa1Ruta lista!';
  document.getElementById('ws3-s').textContent = 'Distancias calculadas por calles reales';

  var del = stops.filter(function(s) { return !s.isDepot && !s.isCityHeader; });
  document.getElementById('r-sub').textContent =
    del.length + ' paradas \xb7 sale desde ' + DEPOT.name;
  document.getElementById('r-stops').textContent = del.length;
  document.getElementById('r-km').textContent = km.toFixed(1) + ' km';
  document.getElementById('r-min').textContent = (totalMin || '—') + ' min';
  document.getElementById('r-save').textContent = '−' + saved.toFixed(1) + ' km';

  var el = document.getElementById('el');
  el.innerHTML = '';
  stops.forEach(function(s, i) {
    if (s.isCityHeader) {
      el.innerHTML +=
        '<div class="city-hdr">' +
          '<div class="city-hdr-dot" style="background:' + s.cityColor + '"></div>' +
          '<div class="city-hdr-name">' + s.cityName + '</div>' +
          '<div class="city-hdr-badge">' + s.stopCount + ' parada' + (s.stopCount !== 1 ? 's' : '') + '</div>' +
        '</div>';
      return;
    }
    var dk = s.distKm && s.distKm !== '0'
      ? '<div class="edist">' + s.distKm + ' km</div>' : '';
    var dt = s.durMin
      ? '<div class="etime">' + s.durMin + ' min</div>' : '';
    if (s.isReturn) {
      el.innerHTML +=
        '<div class="eitem is-dep">' +
          '<div class="enum dep" style="font-size:10px">↩</div>' +
          '<div class="einf">' +
            '<div class="en">Regreso al dep\xf3sito</div>' +
            '<div class="ea">' + (s.address || '').split(',').slice(0, 2).join(',') + '</div>' +
          '</div>' +
          '<div class="emeta">' + dk + dt + '</div>' +
        '</div>';
      return;
    }
    var dlBorder = (!s.isDepot && s.deadline) ? 'border-left:3px solid #f59e0b;' : '';
    var cityBorder = s.cityColor ? 'border-left:3px solid ' + s.cityColor + ';padding-left:10px;' : '';
    var dotStyle = dlBorder || cityBorder;
    var dlBadge = (!s.isDepot && s.deadline)
      ? '<div style="display:inline-flex;align-items:center;gap:3px;color:#f59e0b;font-size:10px;font-weight:600;margin-top:2px"><i class="ti ti-clock-hour-4"></i> antes de las ' + s.deadline + '</div>'
      : '';
    var dlClearBtn = (!s.isDepot && s.deadline)
      ? '<button onclick="clearResultDeadline(' + i + ')" style="background:#374151;border:none;border-radius:6px;color:#9ca3af;padding:4px 8px;cursor:pointer;font-size:11px;flex-shrink:0">Quitar</button>'
      : '';
    var clockBtn = !s.isDepot
      ? '<button onclick="toggleResultDeadline(' + i + ')" title="Horario l\xedmite" style="background:none;border:none;cursor:pointer;font-size:15px;padding:2px 4px;color:' + (s.deadline ? '#f59e0b' : '#475569') + '"><i class="ti ti-clock"></i></button>'
      : '';
    el.innerHTML +=
      '<div class="eitem ' + (s.isDepot ? 'is-dep' : '') + '" id="ri-' + i + '" style="' + dotStyle + '">' +
        '<div class="enum ' + (s.isDepot ? 'dep' : '') + '">' + (s.isDepot ? '🏠' : (s.order || i)) + '</div>' +
        '<div class="einf">' +
          '<div class="en">' + s.name + '</div>' +
          '<div class="ea">' + (s.address || '').split(',').slice(0, 2).join(',') + '</div>' +
          dlBadge +
        '</div>' +
        '<div class="emeta">' + dk + dt + clockBtn + '</div>' +
      '</div>' +
      '<div id="rdlf-' + i + '" style="display:none;padding:8px 12px 10px;background:#0c1c2e;border-radius:0 0 10px 10px;margin:-4px 0 4px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:11px;color:#94a3b8;flex-shrink:0">Antes de las</span>' +
          '<input type="time" id="rdli-' + i + '" value="' + (s.deadline || '12:00') + '" style="flex:1;background:#162842;border:1px solid #1e3a5f;border-radius:8px;padding:5px 8px;color:#e2e8f0;font-size:13px;outline:none">' +
          '<button onclick="confirmResultDeadline(' + i + ')" style="background:#34d399;border:none;border-radius:8px;color:#000;padding:6px 10px;cursor:pointer;font-size:13px"><i class="ti ti-check"></i></button>' +
          dlClearBtn +
        '</div>' +
      '</div>';
  });

  var hasDl = R.some(function(s) { return !s.isDepot && !s.isCityHeader && !s.isReturn && !!s.deadline; });
  if (hasDl) {
    el.innerHTML +=
      '<button class="bbtn bbtn-g" style="margin-top:8px;font-size:13px;width:100%" onclick="reoptimizeWithDeadlines()">' +
        '<i class="ti ti-refresh"></i> Reoptimizar con horarios' +
      '</button>';
  }

  var ws3 = document.getElementById('ws3');
  if (ws3) setTimeout(function() { ws3.scrollTop = ws3.scrollHeight; }, 80);
}

function toggleResultDeadline(rIdx) {
  var form = document.getElementById('rdlf-' + rIdx);
  if (!form) return;
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  if (form.style.display === 'block') {
    setTimeout(function() { var inp = document.getElementById('rdli-' + rIdx); if (inp) inp.focus(); }, 50);
  }
}

function confirmResultDeadline(rIdx) {
  var inp = document.getElementById('rdli-' + rIdx);
  if (!inp || !inp.value) return;
  R[rIdx].deadline = inp.value;
  saveRouteToStorage();
  showResults(R, _lastResultKm, _lastResultSaved, _lastResultMin);
}

function clearResultDeadline(rIdx) {
  R[rIdx].deadline = null;
  saveRouteToStorage();
  showResults(R, _lastResultKm, _lastResultSaved, _lastResultMin);
}

function reoptimizeWithDeadlines() {
  var stops = R.filter(function(s) { return !s.isDepot && !s.isCityHeader && !s.isReturn; });
  if (!stops.length) return;

  var prio = stops.filter(function(s) { return !!s.deadline; });
  var norm = stops.filter(function(s) { return !s.deadline; });
  prio.sort(function(a, b) { return (a.deadline || '').localeCompare(b.deadline || ''); });

  var prioIdx = prio.map(function(s) { return s.order; });
  var normIdx = norm.map(function(s) { return s.order; });

  var pRoute = prioIdx.length === 0 ? [] :
    prioIdx.length === 1 ? prioIdx.slice() :
    twoOptMatrix(nnFromMatrix(0, prioIdx.slice(), distMatrix), distMatrix, 0).route;

  var fromP = pRoute.length ? pRoute[pRoute.length - 1] : 0;

  var nRoute = normIdx.length === 0 ? [] :
    normIdx.length === 1 ? normIdx.slice() :
    orOpt1(twoOptMatrix(nnFromMatrix(fromP, normIdx.slice(), distMatrix), distMatrix, fromP).route, distMatrix).route;

  var optRoute = pRoute.concat(nRoute);

  var byIdx = {};
  stops.forEach(function(s) { byIdx[s.order] = s; });

  var cumMin = 0;
  var fullRoute = [{
    name: DEPOT.name, address: DEPOT.address, lat: DEPOT.lat, lng: DEPOT.lng,
    isDepot: true, done: false, failed: false, distKm: '0', durMin: 0, cumMin: 0, order: 0,
    eta: 'Punto de salida'
  }];

  optRoute.forEach(function(idx, pos) {
    var s = byIdx[idx];
    var prevIdx = pos === 0 ? 0 : optRoute[pos - 1];
    var dM = ((distMatrix[prevIdx] || [])[idx] || 0) / 1000;
    var durS = (durMatrix[prevIdx] || [])[idx] || 0;
    var durM = Math.round(durS / 60);
    cumMin += durM + 2;
    fullRoute.push(Object.assign({}, s, {
      order: pos + 1, distKm: dM.toFixed(2), durMin: durM, cumMin: cumMin, eta: fmtMin(cumMin)
    }));
  });

  var lastIdx = optRoute.length ? optRoute[optRoute.length - 1] : 0;
  var retM = ((distMatrix[lastIdx] || [])[0] || 0);
  var retDurM = Math.round(((durMatrix[lastIdx] || [])[0] || 0) / 60);
  cumMin += retDurM;
  fullRoute.push({
    name: DEPOT.name, address: DEPOT.address, lat: DEPOT.lat, lng: DEPOT.lng,
    isDepot: true, isReturn: true, done: false, failed: false, order: 0,
    distKm: (retM / 1000).toFixed(2), durMin: retDurM, cumMin: cumMin, eta: fmtMin(cumMin)
  });

  R = fullRoute;
  saveRouteToStorage();
  var km = routeDistKm(optRoute, distMatrix);
  showResults(R, km, _lastResultSaved, Math.round(routeDurMin(optRoute, durMatrix)));
  drawMap();
  renderList();
  showToast('Ruta reoptimizada con horarios', 'ok');
}

function confirmRoute() {
  showToast('\xa1A entregar! 🚚', 'ok');
  document.getElementById('map-sub').textContent = 'Desde ' + DEPOT.name;
  setTimeout(function() { go('scr-map'); }, 1200);
}

// ════════════════════════════════════════
// MAP
// ════════════════════════════════════════
function initMap() {
  if (mainMap) return;
  var c = DEPOT ? [DEPOT.lat, DEPOT.lng] : [-33.74, -61.55];
  mainMap = L.map('lmap', {zoomControl: true, attributionControl: false}).setView(c, 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(mainMap);
}

function mkIcon(isDep, isNxt, isDone) {
  if (isDep) return L.divIcon({
    html: '<div style="width:24px;height:24px;border-radius:50%;background:#f59e0b;border:3px solid #1a1500;box-shadow:0 0 0 3px rgba(245,158,11,.3);display:flex;align-items:center;justify-content:center;font-size:12px">🏠</div>',
    iconSize: [24,24], iconAnchor: [12,12], className: ''
  });
  var c = isDone ? '#1f2937' : isNxt ? '#34d399' : '#60a5fa';
  var sz = isNxt ? 18 : 12;
  return L.divIcon({
    html: '<div style="width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;background:' + c + ';border:2px solid ' + (isNxt ? '#031a0e' : '#0d2040') + ';box-shadow:' + (isNxt ? '0 0 0 4px rgba(52,211,153,.2)' : 'none') + '"></div>',
    iconSize: [sz,sz], iconAnchor: [sz/2,sz/2], className: ''
  });
}

function drawMap() {
  if (!mainMap) return;
  mapMarkers.forEach(function(m) { mainMap.removeLayer(m); });
  mapMarkers = [];
  routePolys.forEach(function(p) { mainMap.removeLayer(p); });
  routePolys = [];

  var deliveries = R.filter(function(s) { return !s.isDepot && !s.isCityHeader; });
  var ni = deliveries.findIndex(function(s) { return !s.done; });
  var nextStop = ni >= 0 ? deliveries[ni] : null;

  R.forEach(function(s) {
    if (!s.lat || !s.lng || s.isCityHeader) return;
    if (s.isReturn) return;
    var m = L.marker([s.lat, s.lng], {icon: mkIcon(s.isDepot, s === nextStop, s.done)})
      .bindPopup('<b>' + (s.isDepot ? '🏠 ' : '') + (s.order ? s.order + '. ' : '') + s.name + '</b><br><small>' + s.address + '</small>' +
        (s.distKm && !s.isDepot ? '<br><small>📍 ' + s.distKm + ' km · ⏱ ' + (s.durMin||0) + ' min</small>' : ''))
      .addTo(mainMap);
    mapMarkers.push(m);
  });

  var hasMultiCity = R.some(function(s) { return s.cityIdx !== undefined && !s.isDepot; });
  if (hasMultiCity) {
    // Draw one colored polyline segment per city (entry point from previous stop included)
    var orderedPts = R.filter(function(s) { return s.lat && s.lng && !s.isCityHeader; });
    var curCityIdx = null, curColor = null, curPts = [], prevPt = null;
    orderedPts.forEach(function(s) {
      if (s.isDepot && !s.isReturn) { prevPt = [s.lat, s.lng]; return; }
      var ci = s.isReturn ? '__return__' : String(s.cityIdx !== undefined ? s.cityIdx : '_');
      var color = s.isReturn ? '#3a3a3a' : (s.cityColor || '#34d399');
      if (ci !== curCityIdx) {
        if (curPts.length > 1) routePolys.push(L.polyline(curPts, {color: curColor, weight:3, dashArray:'8,5', opacity:.9}).addTo(mainMap));
        curCityIdx = ci;
        curColor = color;
        curPts = prevPt ? [prevPt] : [];
      }
      curPts.push([s.lat, s.lng]);
      prevPt = [s.lat, s.lng];
    });
    if (curPts.length > 1) routePolys.push(L.polyline(curPts, {color: curColor, weight:3, dashArray:'8,5', opacity:.9}).addTo(mainMap));
  } else {
    var pts = R.filter(function(s) { return s.lat && s.lng; }).map(function(s) { return [s.lat, s.lng]; });
    if (pts.length > 1) routePolys.push(L.polyline(pts, {color:'#34d399', weight:3, dashArray:'8,5', opacity:.85}).addTo(mainMap));
  }

  updateMapCard();
  if (mapMarkers.length > 0) {
    mainMap.fitBounds(L.featureGroup(mapMarkers).getBounds(), {padding: [50, 50]});
  }
}

function fitRoute() {
  if (!mainMap) return;
  var pts = R.filter(function(s) { return s.lat && s.lng; }).map(function(s) { return [s.lat, s.lng]; });
  if (pts.length > 1) mainMap.fitBounds(L.latLngBounds(pts), {padding:[50,50]});
}

function updateMapCard() {
  var nxt = R.filter(function(s) { return !s.isDepot && !s.isCityHeader; }).find(function(s) { return !s.done; });
  document.getElementById('mn-name').textContent = nxt ? nxt.name : 'Ruta completada 🎉';
  document.getElementById('mn-addr').textContent = nxt
    ? (nxt.address || '').split(',').slice(0,2).join(',') : 'Todas las entregas realizadas';
  var meta = document.getElementById('mn-meta');
  if (nxt && nxt.distKm && nxt.distKm !== '0') {
    meta.innerHTML = '<span class="tag tgr">' + nxt.distKm + ' km</span>' +
      '<span class="tag tblu">' + (nxt.durMin||0) + ' min</span>' +
      (nxt.eta ? '<span class="tag tgray">' + nxt.eta + '</span>' : '');
  } else {
    meta.innerHTML = '';
  }
}

function navNext() {
  var n = R.filter(function(s) { return !s.isDepot && !s.isCityHeader; }).find(function(s) { return !s.done; });
  if (n) navTo(n);
}
function doneNext() {
  var n = R.filter(function(s) { return !s.isDepot && !s.isCityHeader; }).find(function(s) { return !s.done; });
  if (!n) return;
  n.done = true; drawMap(); renderHome(); saveRouteToStorage();
  showToast(n.name + ' — entregado', 'ok');
}

// Mini map (stop detail)
function initMini(lat, lng) {
  if (miniMap) { miniMap.setView([lat, lng], 15); return; }
  miniMap = L.map('mmaplf', {zoomControl:false, attributionControl:false, dragging:false, scrollWheelZoom:false})
    .setView([lat, lng], 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(miniMap);
}

// ════════════════════════════════════════
// HOME / LIST / DETAIL
// ════════════════════════════════════════
function renderHome() {
  var del = R.filter(function(s) { return !s.isDepot && !s.isCityHeader; });
  var done = del.filter(function(s) { return s.done; }).length;
  var tot = del.length;
  var pct = tot ? Math.round(done / tot * 100) : 0;
  var km = del.reduce(function(a, s) { return a + (parseFloat(s.distKm) || 0); }, 0).toFixed(1);
  var totalMin = del.reduce(function(a, s) { return a + (s.durMin || 0); }, 0);

  document.getElementById('htitle').textContent = tot ? 'Ruta activa' : 'Sin ruta cargada';
  document.getElementById('hsub').textContent = tot && DEPOT
    ? 'Desde ' + DEPOT.name : 'Creá una nueva ruta para comenzar';
  document.getElementById('hd').textContent = done;
  document.getElementById('ht').textContent = tot;
  document.getElementById('hkm').textContent = tot ? km : '—';
  document.getElementById('hmin').textContent = tot ? totalMin : '—';
  document.getElementById('hbar').style.width = pct + '%';
  document.getElementById('hbarl').textContent = done + ' de ' + tot + ' paradas';
  document.getElementById('hpct').textContent = pct + '%';

  var ni = del.findIndex(function(s) { return !s.done; });
  var nxtIdx = ni >= 0 ? R.indexOf(del[ni]) : -1;
  document.getElementById('hnext').innerHTML =
    nxtIdx >= 0 ? scHTML(nxtIdx, true) : '<div style="color:#333;font-size:13px;padding:8px 0">Sin paradas pendientes</div>';

  var q = document.getElementById('hqueue');
  q.innerHTML = '';
  del.filter(function(s) { return !s.done; }).slice(1, 5).forEach(function(s, i) {
    q.innerHTML += (i ? '<div class="cxn"></div>' : '') + scHTML(R.indexOf(s), false);
  });
}

function scHTML(i, nxt) {
  var s = R[i];
  if (s.isCityHeader) {
    return '<div class="city-hdr">' +
      '<div class="city-hdr-dot" style="background:' + s.cityColor + '"></div>' +
      '<div class="city-hdr-name">' + s.cityName + '</div>' +
      '<div class="city-hdr-badge">' + s.stopCount + ' parada' + (s.stopCount !== 1 ? 's' : '') + '</div>' +
    '</div>';
  }
  if (s.isReturn) {
    var dk = s.distKm && s.distKm !== '0' ? '<span class="tag tgr">' + s.distKm + ' km</span>' : '';
    var dt = s.durMin ? '<span class="tag tblu">' + s.durMin + 'm</span>' : '';
    return '<div class="sc dep-card">' +
      '<div class="bnum bn-dep" style="font-size:11px">↩</div>' +
      '<div class="sinfo">' +
        '<div class="sinfo-n">Regreso al dep\xf3sito</div>' +
        '<div class="sinfo-a">' + (s.address || '').split(',').slice(0, 2).join(',') + '</div>' +
        '<div class="sinfo-m">' + dk + dt + '<span class="tag tamt">Vuelta</span></div>' +
      '</div>' +
    '</div>';
  }
  var dep = s.isDepot;
  var nc = dep ? 'bn-dep' : s.done ? 'bn-d' : nxt ? 'bn-n' : 'bn-p';
  var cc = dep ? 'dep-card' : s.done ? 'done' : nxt ? 'nxt' : '';
  var ni = dep ? '🏠' : s.done ? '<i class="ti ti-check" style="font-size:10px"></i>' : (s.order || i);
  var dk = s.distKm && s.distKm !== '0' ? '<span class="tag tgr">' + s.distKm + ' km</span>' : '';
  var dt = s.durMin ? '<span class="tag tblu">' + s.durMin + 'm</span>' : '';
  var st = dep ? '<span class="tag tamt">Salida</span>'
    : s.done ? '<span class="tag tgr">✓ Entregado</span>'
    : '<span class="tag tgray">Pendiente</span>';
  var dlTag = (!dep && s.deadline)
    ? '<span class="tag" style="background:rgba(245,158,11,.2);color:#f59e0b;font-weight:600"><i class="ti ti-clock-hour-4" style="font-size:9px"></i> ' + s.deadline + '</span>'
    : '';
  var addr = (s.address || '').split(',').slice(0,2).join(',');
  var cityBorder = s.cityColor && !dep ? ' border-left:3px solid ' + s.cityColor + ';' : '';
  var dlBorder = !dep && s.deadline && !s.cityColor ? ' border-left:3px solid #f59e0b;' : '';
  return '<div class="sc ' + cc + '" style="' + cityBorder + dlBorder + '" onclick="openStop(' + i + ')">' +
    '<div class="bnum ' + nc + '">' + ni + '</div>' +
    '<div class="sinfo">' +
      '<div class="sinfo-n">' + s.name + '</div>' +
      '<div class="sinfo-a">' + addr + '</div>' +
      '<div class="sinfo-m">' + dk + dt + st + dlTag + '</div>' +
    '</div>' +
    '<i class="ti ti-chevron-right" style="color:#2a2a2a;font-size:17px;margin-top:4px"></i>' +
  '</div>';
}

function renderList() {
  var del = R.filter(function(s) { return !s.isDepot && !s.isCityHeader; });
  var done = del.filter(function(s) { return s.done; }).length;
  document.getElementById('st-title').textContent = 'Recorrido completo';
  document.getElementById('st-sub').textContent = R.length
    ? done + ' de ' + del.length + ' entregas' : 'Sin ruta cargada';
  var el = document.getElementById('sl');
  el.innerHTML = '';
  if (!R.length) {
    el.innerHTML = '<div style="color:#333;font-size:13px;padding:24px;text-align:center">Creá una ruta para ver las paradas</div>';
    return;
  }
  var ni = R.findIndex(function(s) { return !s.isDepot && !s.isCityHeader && !s.done; });
  var prevWasHeader = false;
  R.forEach(function(s, i) {
    var showCxn = i > 0 && !s.isCityHeader && !prevWasHeader;
    el.innerHTML += (showCxn ? '<div class="cxn"></div>' : '') + scHTML(i, i === ni);
    prevWasHeader = !!s.isCityHeader;
  });
}

function openStop(i) {
  var s = R[i];
  if (s.isReturn || s.isCityHeader) return;
  detIdx = i;
  document.getElementById('d-name').textContent = s.name;
  document.getElementById('d-num').textContent = s.isDepot
    ? 'Punto de salida' : 'Parada ' + s.order + ' de ' + R.filter(function(x) { return !x.isDepot && !x.isCityHeader; }).length;
  document.getElementById('d-addr').textContent = s.address || '—';
  document.getElementById('d-coords').textContent = s.lat
    ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) : 'Sin GPS';
  document.getElementById('d-dist').textContent = s.distKm && s.distKm !== '0'
    ? s.distKm + ' km por ruta real' : 'Punto de inicio';
  document.getElementById('d-dur').textContent = s.durMin ? s.durMin + ' minutos' : '—';
  document.getElementById('d-eta').textContent = s.eta || '—';
  var dlRow = document.getElementById('d-deadline-row');
  var dlEl = document.getElementById('d-deadline');
  if (dlRow && dlEl) {
    if (s.deadline) {
      dlRow.style.display = '';
      dlEl.textContent = 'Antes de las ' + s.deadline;
    } else {
      dlRow.style.display = 'none';
    }
  }
  document.getElementById('d-ord').textContent = s.isDepot
    ? 'Punto de salida fijo' : 'Posición ' + s.order + ' · OSRM + 2-opt';
  document.getElementById('b-ok').className = 'stb' + (s.done ? ' ok' : '');
  document.getElementById('b-fail').className = 'stb' + (s.failed ? ' fl' : '');
  if (s.lat && s.lng) {
    setTimeout(function() {
      initMini(s.lat, s.lng);
      L.marker([s.lat, s.lng], {icon: mkIcon(s.isDepot, true, false)}).addTo(miniMap);
      setTimeout(function() { miniMap.invalidateSize(); }, 200);
    }, 100);
  }
  go('scr-detail');
}

function detOk() {
  if (detIdx < 0) return;
  R[detIdx].done = true; R[detIdx].failed = false;
  document.getElementById('b-ok').className = 'stb ok';
  document.getElementById('b-fail').className = 'stb';
  showToast('Entrega registrada ✓', 'ok');
  drawMap(); saveRouteToStorage();
  setTimeout(function() { go('scr-stops'); }, 1200);
}
function detFail() {
  if (detIdx < 0) return;
  R[detIdx].failed = true;
  document.getElementById('b-fail').className = 'stb fl';
  showToast('Marcado: no entregado', 'err');
  saveRouteToStorage();
}
function navDetail() { if (detIdx >= 0) navTo(R[detIdx]); }
function navTo(s) {
  window.open(s.lat
    ? 'https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lng + '&travelmode=driving'
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(s.address),
    '_blank');
}

// ════════════════════════════════════════
// STEP INDICATORS
// ════════════════════════════════════════
var STEP_ICONS = ['ti-home-2','ti-file-text','ti-world','ti-calculator','ti-route','ti-cpu','ti-map'];

function step(n, st, msg) {
  var ico = document.getElementById('i' + n);
  var sub = document.getElementById('s' + n);
  if (!ico || !sub) return;
  sub.textContent = msg;
  sub.style.color = '';
  if (st === 'r') {
    ico.className = 'psico ico-r';
    ico.innerHTML = '<i class="ti ti-loader spin"></i>';
    sub.className = 'pssub pulse';
    document.getElementById('p-ttl').textContent = msg;
  } else if (st === 'ok') {
    ico.className = 'psico ico-ok';
    ico.innerHTML = '<i class="ti ti-check"></i>';
    sub.className = 'pssub';
  } else {
    ico.className = 'psico ico-er';
    ico.innerHTML = '<i class="ti ti-x"></i>';
    sub.className = 'pssub';
    sub.style.color = '#f87171';
  }
}

function resetSteps() {
  STEP_ICONS.forEach(function(ic, n) {
    var el = document.getElementById('i' + n);
    if (el) { el.className = 'psico ico-w'; el.innerHTML = '<i class="ti ' + ic + '"></i>'; }
    var s = document.getElementById('s' + n);
    if (s) { s.textContent = 'Pendiente'; s.className = 'pssub'; s.style.color = ''; }
  });
  var pttl = document.getElementById('p-ttl');
  if (pttl) pttl.textContent = 'Iniciando...';
}

// ════════════════════════════════════════
// ROUTE PERSISTENCE
// ════════════════════════════════════════
var ROUTE_STORAGE_KEY = 'routeops_route_v1';

function saveRouteToStorage() {
  if (!R.length) return;
  try {
    localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({route: R, depot: DEPOT}));
  } catch(e) {}
}

function loadRouteFromStorage() {
  try {
    var raw = localStorage.getItem(ROUTE_STORAGE_KEY);
    if (!raw) return false;
    var data = JSON.parse(raw);
    if (!data.route || !data.route.length) return false;
    R = data.route;
    DEPOT = data.depot || null;
    return true;
  } catch(e) { return false; }
}

// ════════════════════════════════════════
// UTILS
// ════════════════════════════════════════
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function showToast(msg, type) {
  type = type || 'ok';
  var t = document.getElementById('toast');
  var ico = document.getElementById('t-ico');
  t.className = 'toast t' + type;
  ico.className = type === 'ok' ? 'ti ti-check'
    : type === 'err' ? 'ti ti-alert-circle' : 'ti ti-info-circle';
  document.getElementById('t-msg').textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 3200);
}

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════

// Seed history so the device back button navigates within the app
// (e.g. after returning from Google Maps navigation)
history.replaceState({screen: 'scr-home'}, '', '');

// Restore last active route from localStorage
(function() {
  if (loadRouteFromStorage() && R.length) {
    renderHome();
    setTimeout(function() { showToast('Ruta anterior restaurada', 'ok'); }, 600);
  }
})();
