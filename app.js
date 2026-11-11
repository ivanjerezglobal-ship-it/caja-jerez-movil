/* App de inventario - celular y PC */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clp = n => "$" + Number(n || 0).toLocaleString("es-CL");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const leer = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };

const S = {
  dispositivo: leer("inv_dispositivo", ""),
  vista: "escanear",
  filtro: "", depto: "", texto: "",
  version: -1,
  productoAbierto: null,
  resumen: null,
  // M-69 · inventario por zonas
  conteo: null,
  zona: leer("inv_zona", "Local"),
  cola: (() => { try { return JSON.parse(leer("inv_cola", "[]")) || []; } catch (e) { return []; } })(),
  versionConteo: -1,
};

/* Cálculos iguales a los del PC (Caja Jerez): costo neto según el modo y el IVA de Configuración */
const IVAF = () => 1 + ((S.resumen && S.resumen.cfg && S.resumen.cfg.iva) || 19) / 100;
const costoNeto = c => (S.resumen && S.resumen.cfg && S.resumen.cfg.modo !== 2) ? c : c / IVAF();
const margenDe = p => p.venta > 0 ? (p.venta / IVAF() - costoNeto(p.costo)) / (p.venta / IVAF()) : null;
const pct = x => x === null || x === undefined || !isFinite(x) ? "—" : (x * 100).toFixed(1).replace(".", ",") + " %";

/* ---------------- API ---------------- */
async function api(ruta, opts = {}) {
  // M-71 · en la versión por internet (GitHub Pages) las mismas rutas las atiende Supabase (nube.js)
  if (window.NUBE) return window.NUBE.api(ruta, opts);
  const r = await fetch("api/" + ruta, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", "X-App": "inventario-movil", "X-Dispositivo": S.dispositivo },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error((data && data.error) || "Error " + r.status); err.status = r.status; throw err; }
  return data;
}

/* ---------------- UI básicos ---------------- */
let tToast;
function toast(msg, tipo = "") {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast ver " + tipo;
  clearTimeout(tToast); tToast = setTimeout(() => t.className = "toast", 2600);
}
function vibrar(ms = 60) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }
let audioCtx;
function bip(ok = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = ok ? 1250 : 320; o.type = "square"; g.gain.value = 0.05;
    o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + (ok ? 0.09 : 0.25));
  } catch (e) {}
}

function abrirHoja(html) {
  $("#hoja-cont").innerHTML = html;
  $("#hoja").hidden = false; $("#velo").hidden = false;
  $("#hoja").scrollTop = 0;
}
function cerrarHoja() {
  $("#hoja").hidden = true; $("#velo").hidden = true;
  S.productoAbierto = null;
  reanudarEscaneo();
}
$("#cerrar-hoja").onclick = cerrarHoja;
$("#velo").onclick = cerrarHoja;

function irA(v) {
  const antes = S.vista;
  S.vista = v;
  $$(".vista").forEach(s => s.classList.toggle("activa", s.id === "v-" + v));
  $$(".tabs button").forEach(b => b.classList.toggle("activo", b.dataset.v === v));
  if (antes !== v) detenerCamara();
  // el mismo escáner sirve en «Escanear» y en «Inventario»: se mueve a la vista activa
  const lugar = $(v === "inventario" ? "#lugar-escaner-inventario" : "#lugar-escaner-escanear");
  if (lugar && (v === "inventario" || v === "escanear")) lugar.appendChild($("#bloque-escaner"));
  $("#form-manual button").textContent = v === "inventario" ? "Contar" : "Buscar";
  refrescarVista();
  window.scrollTo(0, 0);
}
$$(".tabs button").forEach(b => b.onclick = () => irA(b.dataset.v));

function miniatura(p) {
  return p.imagen ? `<img class="mini" src="imagenes/${encodeURIComponent(p.imagen)}" loading="lazy" alt="">` : `<div class="mini">🧴</div>`;
}
function hora(f) { return (f || "").slice(11, 16); }
function fechaCorta(f) {
  const hoy = new Date().toISOString().slice(0, 10);
  return f.slice(0, 10) === hoy ? "Hoy " + hora(f) : f.slice(8, 10) + "/" + f.slice(5, 7) + " " + hora(f);
}
function itemMov(m) {
  const cls = m.tipo === "ajuste" || m.tipo === "inicial" ? "aj" : m.cantidad > 0 ? "mas" : "menos";
  const signo = m.cantidad > 0 ? "+" : "";
  return `<li class="item" data-pid="${m.producto_id}">
    <div class="info"><div class="nom">${esc(m.nombre)}</div>
    <div class="det">${fechaCorta(m.fecha)} · ${esc(m.dispositivo || "")} · ${m.tipo}${m.nota ? " · " + esc(m.nota) : ""} → quedan ${m.stock_nuevo}</div></div>
    <div class="mov ${cls}">${signo}${m.cantidad}</div></li>`;
}

/* ---------------- Dispositivo ---------------- */
function pintarDispositivo() {
  $("#nombre-disp").textContent = S.dispositivo || "Sin nombre";
  $("#input-disp").value = S.dispositivo;
}
function pedirNombre() {
  abrirHoja(`<h2>¿Cómo se llama este teléfono?</h2>
    <p class="nota">Así sabrás en el historial quién hizo cada movimiento.</p>
    <form id="f-nombre"><input id="n-disp" maxlength="30" value="${esc(S.dispositivo || "Teléfono 1")}" autofocus>
    <div class="dos" style="margin-top:12px"><button type="button" class="btn" data-n="Teléfono 1">Teléfono 1</button><button type="button" class="btn" data-n="Teléfono 2">Teléfono 2</button></div>
    <button class="btn primario ancho" style="margin-top:12px">Guardar</button></form>`);
  $$("[data-n]").forEach(b => b.onclick = () => $("#n-disp").value = b.dataset.n);
  $("#f-nombre").onsubmit = e => {
    e.preventDefault();
    S.dispositivo = $("#n-disp").value.trim() || "Teléfono"; guardar("inv_dispositivo", S.dispositivo);
    pintarDispositivo(); cerrarHoja();
  };
}
$("#chip-disp").onclick = pedirNombre;
$("#input-disp").onchange = e => { S.dispositivo = e.target.value.trim() || "Teléfono"; guardar("inv_dispositivo", S.dispositivo); pintarDispositivo(); toast("Nombre guardado", "ok"); };

/* ---------------- Escáner ---------------- */
const CAM = { stream: null, activo: false, pausado: false, detector: null, zxing: null, ultimo: "", repet: 0, track: null, linterna: false };

async function cargarZXing() {
  if (window.ZXing) return;
  await new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
    s.onload = ok; s.onerror = () => mal(new Error("No se pudo cargar el lector (sin internet)"));
    document.head.appendChild(s);
  });
}

async function iniciarCamara() {
  if (!window.isSecureContext) {
    $("#cam-msg").innerHTML = "La cámara necesita la dirección <b>https://</b> que aparece en la ventana del PC.";
    toast("Abre la app con https://", "error"); return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("Este navegador no permite usar la cámara", "error"); return; }
  $("#cam-msg").textContent = "Abriendo cámara…";
  try {
    CAM.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    $("#cam-msg").textContent = "No se pudo abrir la cámara: " + (e.name === "NotAllowedError" ? "permiso denegado. Actívalo en el candado de la barra de dirección." : e.message);
    return;
  }
  const v = $("#video"); v.srcObject = CAM.stream; await v.play().catch(() => {});
  CAM.track = CAM.stream.getVideoTracks()[0];
  CAM.activo = true; CAM.pausado = false;
  $("#btn-cam").textContent = "⏹ Detener cámara";
  try { const cap = CAM.track.getCapabilities && CAM.track.getCapabilities(); $("#btn-linterna").hidden = !(cap && cap.torch); } catch (e) {}

  let usarNativo = false;
  if ("BarcodeDetector" in window) {
    try {
      const f = await BarcodeDetector.getSupportedFormats();
      const quiero = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"].filter(x => f.includes(x));
      if (quiero.includes("ean_13")) { CAM.detector = new BarcodeDetector({ formats: quiero }); usarNativo = true; }
    } catch (e) {}
  }
  $("#cam-msg").textContent = "Apunta al código de barras";
  if (usarNativo) bucleNativo();
  else {
    try {
      await cargarZXing();
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.ITF]);
      CAM.zxing = new ZXing.BrowserMultiFormatReader(hints, 250);
      CAM.zxing.decodeFromStream(CAM.stream, v, (res) => { if (res) candidato(res.getText()); });
    } catch (e) { $("#cam-msg").textContent = e.message + ". Puedes escribir el código abajo."; }
  }
}

async function bucleNativo() {
  const v = $("#video");
  while (CAM.activo) {
    if (!CAM.pausado && v.readyState >= 2) {
      try {
        const r = await CAM.detector.detect(v);
        if (r.length) candidato(r[0].rawValue);
      } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 120));
  }
}

function candidato(codigo) {
  if (CAM.pausado || !codigo) return;
  codigo = codigo.trim();
  // exigir 2 lecturas iguales seguidas para evitar errores
  if (codigo === CAM.ultimo) CAM.repet++; else { CAM.ultimo = codigo; CAM.repet = 1; }
  if (CAM.repet < 2) return;
  CAM.pausado = true; CAM.ultimo = ""; CAM.repet = 0;
  $("#camara").classList.add("leido"); setTimeout(() => $("#camara").classList.remove("leido"), 500);
  vibrar(); bip(true);
  if (S.vista === "inventario") contarCodigo(codigo);
  else buscarCodigo(codigo);
}

function detenerCamara() {
  CAM.activo = false;
  try { CAM.zxing && CAM.zxing.reset(); } catch (e) {}
  CAM.zxing = null;
  if (CAM.stream) CAM.stream.getTracks().forEach(t => t.stop());
  CAM.stream = null; CAM.linterna = false;
  $("#video").srcObject = null;
  $("#btn-cam").textContent = "📷 Iniciar cámara";
  $("#btn-linterna").hidden = true;
  $("#cam-msg").innerHTML = "Toca <b>Iniciar cámara</b> para escanear";
}
function reanudarEscaneo() { setTimeout(() => { CAM.pausado = false; }, 700); }

$("#btn-cam").onclick = () => CAM.activo ? detenerCamara() : iniciarCamara();
$("#btn-linterna").onclick = async () => {
  try { CAM.linterna = !CAM.linterna; await CAM.track.applyConstraints({ advanced: [{ torch: CAM.linterna }] }); } catch (e) { toast("Linterna no disponible"); }
};
$("#form-manual").onsubmit = e => {
  e.preventDefault();
  const c = $("#codigo-manual").value.trim();
  if (c) {
    if (S.vista === "inventario") contarCodigo(c);
    else buscarCodigo(c);
    $("#codigo-manual").value = "";
  }
};

/* ---------------- Producto ---------------- */
async function buscarCodigo(codigo) {
  try {
    const p = await api("productos/codigo/" + encodeURIComponent(codigo));
    mostrarProducto(p);
  } catch (e) {
    if (e.status === 404) { bip(false); noEncontrado(codigo); }
    else { toast(e.message, "error"); reanudarEscaneo(); }
  }
}

async function abrirProductoId(id) {
  try { mostrarProducto(await api("productos/" + id)); } catch (e) { toast(e.message, "error"); }
}

function mostrarProducto(p) {
  S.productoAbierto = p;
  const bajo = p.existencia <= p.minimo;
  abrirHoja(`
    <div class="prod-cab">
      ${p.imagen ? `<img class="foto" id="foto-p" src="imagenes/${encodeURIComponent(p.imagen)}" alt="">` : `<button class="foto" id="foto-p" title="Agregar foto">📷</button>`}
      <div><h3>${esc(p.nombre)}</h3>
      <div class="det">${p.codigo ? esc(p.codigo) : "<b style='color:var(--ambar)'>Sin código</b>"} · ${esc(p.departamento)}</div>
      <div class="det">Venta ${clp(p.venta)} · Costo ${clp(p.costo)}</div>
      <div class="det">Margen ${pct(margenDe(p))} · Stock a costo neto ${clp(Math.round(Math.max(p.existencia, 0) * costoNeto(p.costo)))}</div></div>
    </div>
    <div class="gran-stock"><div class="num ${bajo ? "bajo" : ""}" id="p-stock">${p.existencia}</div>
      <div class="lbl">en stock${p.minimo ? " · mínimo " + p.minimo : ""}${bajo ? " · ⚠️ reponer" : ""}</div></div>
    <div class="stepper">
      <button type="button" id="st-menos">−</button>
      <input id="cant" type="number" inputmode="numeric" min="1" value="1">
      <button type="button" id="st-mas">+</button>
    </div>
    <input id="nota-mov" placeholder="Nota (opcional): venta, proveedor, merma…" maxlength="200">
    <div class="acciones" style="margin-top:12px">
      <button class="btn restar" id="b-restar">− Restar</button>
      <button class="btn sumar" id="b-sumar">+ Sumar</button>
    </div>
    <div class="enlaces">
      <button class="btn" id="b-ajuste">🔢 Conteo exacto</button>
      <button class="btn" id="b-editar">✏️ Editar</button>
      <button class="btn" id="b-foto">🖼️ Foto</button>
      <button class="btn" id="b-hist">🕘 Movimientos</button>
    </div>`);
  const cant = () => Math.max(1, parseInt($("#cant").value, 10) || 1);
  $("#st-menos").onclick = () => $("#cant").value = Math.max(1, cant() - 1);
  $("#st-mas").onclick = () => $("#cant").value = cant() + 1;
  $("#b-restar").onclick = () => mover(p, -cant());
  $("#b-sumar").onclick = () => mover(p, cant());
  $("#b-ajuste").onclick = () => formAjuste(p);
  $("#b-editar").onclick = () => formProducto(p);
  $("#b-foto").onclick = $("#foto-p").onclick = () => pedirFoto(p);
  $("#b-hist").onclick = () => historialProducto(p);
}

let enviando = false;
async function mover(p, cantidad) {
  if (enviando) return; enviando = true;
  $$("#hoja .acciones .btn").forEach(b => b.disabled = true);
  try {
    const r = await api("movimientos", { method: "POST", body: { producto_id: p.id, cantidad, dispositivo: S.dispositivo, nota: $("#nota-mov").value } });
    vibrar(40);
    toast(`${cantidad > 0 ? "+" : ""}${cantidad} ${r.producto.nombre.slice(0, 28)} → quedan ${r.producto.existencia}`, "ok");
    cerrarHoja(); refrescarVista();
  } catch (e) {
    toast(e.message, "error"); bip(false);
    $$("#hoja .acciones .btn").forEach(b => b.disabled = false);
  } finally { enviando = false; }
}

function formAjuste(p) {
  abrirHoja(`<h2>Conteo exacto</h2><p class="nota">${esc(p.nombre)}<br>El sistema dice <b>${p.existencia}</b>. Escribe cuántas unidades contaste en la bodega o el estante.</p>
    <form id="f-aj"><input id="aj-n" type="number" inputmode="numeric" min="0" value="${p.existencia}">
    <button class="btn primario ancho" style="margin-top:12px">Guardar conteo</button></form>`);
  $("#aj-n").select();
  $("#f-aj").onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api("movimientos", { method: "POST", body: { producto_id: p.id, tipo: "ajuste", existencia: parseInt($("#aj-n").value, 10), dispositivo: S.dispositivo, nota: "Conteo físico" } });
      toast(`Conteo guardado: ${r.producto.existencia}`, "ok"); cerrarHoja(); refrescarVista();
    } catch (err) { toast(err.message, "error"); }
  };
}

async function historialProducto(p) {
  const movs = await api("movimientos?limite=50&producto_id=" + p.id);
  abrirHoja(`<h2>${esc(p.nombre)}</h2><ul class="lista compacta">${movs.map(itemMov).join("") || '<li class="vacio">Sin movimientos</li>'}</ul>
    <button class="btn ancho" style="margin-top:12px" id="volver">← Volver</button>`);
  $("#volver").onclick = () => abrirProductoId(p.id);
}

function opcionesDepto(sel) {
  const ds = (S.resumen && S.resumen.departamentos) || [];
  return ds.map(d => `<option ${d === sel ? "selected" : ""}>${esc(d)}</option>`).join("");
}

function formProducto(p, codigoNuevo) {
  const nuevo = !p;
  p = p || { codigo: codigoNuevo || "", nombre: "", departamento: "- Sin Departamento -", costo: 0, venta: 0, mayoreo: 0, existencia: 0, minimo: 2, maximo: 0 };
  abrirHoja(`<h2>${nuevo ? "Nuevo producto" : "Editar producto"}</h2>
    <form id="f-prod">
      <label class="campo">Código de barras<input name="codigo" value="${esc(p.codigo || "")}" inputmode="numeric"></label>
      <label class="campo">Nombre *<input name="nombre" value="${esc(p.nombre)}" required></label>
      <label class="campo">Departamento
        <input name="departamento" list="deptos" value="${esc(p.departamento)}"><datalist id="deptos">${opcionesDepto()}</datalist></label>
      <div class="dos">
        <label class="campo">Precio costo<input name="costo" type="number" inputmode="numeric" value="${p.costo}"></label>
        <label class="campo">Precio venta<input name="venta" type="number" inputmode="numeric" value="${p.venta}"></label>
        <label class="campo">Precio mayoreo<input name="mayoreo" type="number" inputmode="numeric" value="${p.mayoreo}"></label>
        ${nuevo ? `<label class="campo">Stock inicial<input name="existencia" type="number" inputmode="numeric" value="0"></label>` : `<div></div>`}
        <label class="campo">Inv. mínimo<input name="minimo" type="number" inputmode="numeric" value="${p.minimo}"></label>
        <label class="campo">Inv. máximo<input name="maximo" type="number" inputmode="numeric" value="${p.maximo}"></label>
      </div>
      <button class="btn primario ancho">${nuevo ? "Crear producto" : "Guardar cambios"}</button>
      ${nuevo ? "" : `<button type="button" class="btn ancho peligro" id="b-desact">Ocultar producto (descontinuado)</button>`}
    </form>`);
  $("#f-prod").onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = nuevo ? await api("productos", { method: "POST", body: d }) : await api("productos/" + p.id, { method: "PUT", body: d });
      toast(nuevo ? "Producto creado" : "Cambios guardados", "ok");
      await cargarResumen(); mostrarProducto(r); refrescarVista();
    } catch (err) { toast(err.message, "error"); }
  };
  const bd = $("#b-desact");
  if (bd) bd.onclick = async () => {
    if (!confirm("¿Ocultar este producto? No se borra su historial.")) return;
    await api("productos/" + p.id, { method: "PUT", body: { activo: false } });
    toast("Producto ocultado"); cerrarHoja(); refrescarVista();
  };
}

async function noEncontrado(codigo) {
  let sinCod = [];
  try { sinCod = await api("productos?sin_codigo=1"); } catch (e) {}
  abrirHoja(`<h2>Código no registrado</h2>
    <p class="nota">El código <b>${esc(codigo)}</b> no está en el inventario.</p>
    <button class="btn primario ancho" id="b-crear">＋ Crear producto nuevo con este código</button>
    ${sinCod.length ? `<h3 class="sub">…o asignarlo a un producto que aún no tiene código</h3>
      <ul class="lista compacta">${sinCod.map(p => `<li class="item" data-asig="${p.id}">${miniatura(p)}<div class="info"><div class="nom">${esc(p.nombre)}</div><div class="det">${esc(p.departamento)}</div></div><div class="stock">${p.existencia}</div></li>`).join("")}</ul>` : ""}`);
  $("#b-crear").onclick = () => formProducto(null, codigo);
  $$("[data-asig]").forEach(li => li.onclick = async () => {
    try {
      const r = await api("productos/" + li.dataset.asig, { method: "PUT", body: { codigo } });
      toast("Código asignado", "ok"); mostrarProducto(r); refrescarVista();
    } catch (e) { toast(e.message, "error"); }
  });
}

/* ---------------- Fotos ---------------- */
let fotoPara = null;
function pedirFoto(p) { fotoPara = p; $("#input-foto").value = ""; $("#input-foto").click(); }
$("#input-foto").onchange = async e => {
  const f = e.target.files[0]; if (!f || !fotoPara) return;
  toast("Subiendo foto…");
  try {
    const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = URL.createObjectURL(f); });
    const max = 900, k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const r = await api("productos/" + fotoPara.id + "/imagen", { method: "POST", body: { imagen: c.toDataURL("image/jpeg", 0.82) } });
    toast("Foto guardada", "ok"); mostrarProducto(r); refrescarVista();
  } catch (err) { toast("No se pudo subir la foto: " + err.message, "error"); }
};

/* ---------------- Vistas ---------------- */
async function cargarResumen() {
  S.resumen = await api("resumen");
  const sel = $("#filtro-depto"), actual = sel.value;
  sel.innerHTML = `<option value="">Departamento…</option>` + opcionesDepto(actual);
}

async function pintarUltimos() {
  const movs = await api("movimientos?limite=8");
  $("#ultimos").innerHTML = movs.map(itemMov).join("") || '<li class="vacio">Aún no hay movimientos</li>';
}

async function pintarProductos() {
  const q = new URLSearchParams();
  if (S.texto) q.set("q", S.texto);
  if (S.filtro) q.set(S.filtro, "1");
  if (S.depto) q.set("departamento", S.depto);
  const lista = await api("productos?" + q);
  $("#conteo").textContent = `${lista.length} producto${lista.length === 1 ? "" : "s"} · ${lista.reduce((a, p) => a + p.existencia, 0)} unidades`;
  const cuenta = {};
  lista.forEach(p => cuenta[p.departamento] = (cuenta[p.departamento] || 0) + 1);
  let actual = null, html = "";
  for (const p of lista) {
    if (p.departamento !== actual) {
      actual = p.departamento;
      html += `<li class="depto" data-depto="${esc(actual)}">${esc(actual)} <span>${cuenta[actual]}</span></li>`;
    }
    html += `<li class="item" data-pid="${p.id}">${miniatura(p)}
    <div class="info"><div class="nom">${esc(p.nombre)}</div><div class="det">${p.codigo ? esc(p.codigo) : "<b style='color:var(--ambar)'>sin código</b>"} · venta ${clp(p.venta)} · costo ${clp(p.costo)} · margen ${pct(margenDe(p))}</div></div>
    <div class="stock ${p.existencia <= p.minimo ? "bajo" : ""}">${p.existencia}</div></li>`;
  }
  $("#lista-prod").innerHTML = html || '<li class="vacio">No hay productos con ese filtro</li>';
  $$("#lista-prod .depto").forEach(li => li.onclick = () => {
    const d = li.dataset.depto; S.depto = S.depto === d ? "" : d; $("#filtro-depto").value = S.depto; pintarProductos();
  });
}

async function pintarHistorial() {
  const movs = await api("movimientos?limite=150");
  $("#lista-hist").innerHTML = movs.map(itemMov).join("") || '<li class="vacio">Sin movimientos</li>';
}

function pintarAjustes() {
  const r = S.resumen; if (!r) return;
  // M-69 · los mismos indicadores que «Inicio» de Caja Jerez
  const modo2 = r.cfg && r.cfg.modo === 2;
  $("#kpis").innerHTML = `
    <div class="kpi ancho"><span>Stock a costo (neto)</span><b>${clp(r.valor_costo_neto)}</b>
      <small>${r.productos} productos${modo2 ? " · " + clp(r.valor_costo) + " con IVA" : ""}${r.cfg && r.cfg.pctAdq ? " · incluye " + pct(r.cfg.pctAdq / 100) + " de flete y embalaje" : ""}</small></div>
    <div class="kpi"><span>Sin stock</span><b style="color:var(--rojo)">${r.sin_stock}</b><small>${r.sin_stock_con_minimo} con mínimo definido</small></div>
    <div class="kpi"><span>Bajo el mínimo</span><b style="color:var(--ambar)">${r.bajo_minimo}</b><small>con stock, por reponer</small></div>
    <div class="kpi"><span>Margen potencial</span><b>${pct(r.margen_potencial)}</b><small>sin IVA · stock a precio venta ${clp(r.valor_venta)}</small></div>
    <div class="kpi"><span>Ventas de hoy</span><b>${r.ventas_hoy === null ? "—" : clp(r.ventas_hoy)}</b><small>${r.ventas_hoy === null ? "sin ventas registradas hoy" : "utilidad neta " + clp(r.utilidad_hoy)}</small></div>
    <div class="kpi"><span>Unidades en stock</span><b>${Number(r.unidades).toLocaleString("es-CL")}</b><small>${r.sin_codigo} productos sin código</small></div>
    <div class="kpi"><span>Movimientos hoy</span><b>${r.movimientos_hoy}</b><small>caja, celulares e inventarios</small></div>`;
  $("#info-servidor").innerHTML = window.NUBE ? window.NUBE.infoConexion() : `Conectado a <b>${esc(location.host)}</b>`;
}

/* ---------------- M-69 · Inventario por zonas ----------------
   Un inventario abierto a la vez; cada teléfono cuenta en su zona (Local o Bodega) y varios teléfonos pueden
   contar al mismo tiempo. Cada lectura suma 1 en la zona elegida. Si se corta el Wi-Fi, las lecturas quedan
   guardadas en el teléfono y se envían solas al volver. Al cerrar: stock = Local + Bodega, y los productos no
   contados se revisan uno por uno (dejar en 0 o mantener). */
function guardarCola() { guardar("inv_cola", JSON.stringify(S.cola)); }

async function cargarConteo() {
  S.conteo = await api("conteos/abierto");
}

function pintarCola() {
  const el = $("#inv-cola");
  if (!el) return;
  el.innerHTML = S.cola.length ? `<div class="cola">📶 Sin conexión: ${S.cola.length} ${S.cola.length === 1 ? "lectura guardada" : "lecturas guardadas"} en este teléfono. Se enviarán solas al volver la conexión.</div>` : "";
}

async function enviarCola() {
  while (S.cola.length) {
    const x = S.cola[0];
    try {
      await api(`conteos/${x.conteo}/leer`, { method: "POST", body: { codigo: x.codigo, zona: x.zona, cantidad: x.cantidad } });
    } catch (e) {
      if (e.status && e.status < 500) { toast(`No se pudo contar ${x.codigo}: ${e.message}`, "error"); }
      else { pintarCola(); return false; }   // sigue sin conexión: se reintenta en el próximo latido
    }
    S.cola.shift(); guardarCola();
  }
  pintarCola();
  return true;
}

async function contarCodigo(codigo) {
  if (!S.conteo) { toast("Primero toca «Empezar inventario»", "error"); reanudarEscaneo(); return; }
  const lectura = { conteo: S.conteo.id, codigo, zona: S.zona, cantidad: 1 };
  if (S.cola.length) {                       // hay lecturas esperando: se mantiene el orden
    S.cola.push(lectura); guardarCola(); pintarCola(); toast(`Guardado en el teléfono (${S.zona})`); reanudarEscaneo(); return;
  }
  try {
    const r = await api(`conteos/${S.conteo.id}/leer`, { method: "POST", body: lectura });
    const p = r.producto;
    toast(`${p.nombre.slice(0, 26)} · ${r.zona} ${r.mio} · total ${r.total} (sistema ${p.existencia})`, "ok");
    pintarInventario();
  } catch (e) {
    if (e.status === 404 && /Producto/.test(e.message)) { bip(false); noEncontrado(codigo); return; }
    if (e.status && e.status < 500) { toast(e.message, "error"); }
    else { S.cola.push(lectura); guardarCola(); pintarCola(); toast(`Sin conexión: guardado en el teléfono (${S.zona})`); }
  }
  reanudarEscaneo();
}

function fmtDif(d) {
  return `<div class="dif ${d === 0 ? "cero" : d > 0 ? "mas" : "menos"}">${d > 0 ? "+" : ""}${d}</div>`;
}

async function pintarInventario() {
  try { await cargarConteo(); } catch (e) { pintarCola(); return; }
  const k = S.conteo, cab = $("#inv-cab"), cuerpo = $("#inv-cuerpo");
  pintarCola();
  $("#bloque-escaner").hidden = !k;
  if (!k) {
    let hist = [];
    try { hist = await api("conteos"); } catch (e) {}
    cab.innerHTML = `<div class="inv-tarjeta"><h2>Inventario</h2>
      <p class="nota">Cuenta los productos escaneándolos, por zona: <b>Local</b> y <b>Bodega</b>. Varios teléfonos pueden contar a la vez.
      Al cerrar, el stock de cada producto queda como Local + Bodega.</p>
      <label class="campo">Nombre del inventario<input id="inv-nombre" value="Inventario ${new Date().toLocaleDateString("es-CL")}"></label>
      <button class="btn primario ancho" id="inv-empezar">▶ Empezar inventario</button></div>`;
    cuerpo.innerHTML = hist.length ? `<h3 class="sub">Inventarios anteriores</h3><ul class="lista compacta">${hist.map(h => `<li class="item" data-inf="${h.id}">
      <div class="info"><div class="nom">${esc(h.nombre)}</div><div class="det">${h.estado === "cerrado" ? "Cerrado " + fechaCorta(h.cerrado || "") : h.estado}
      · ${h.productos} productos${h.resultado ? " · " + h.resultado.con_diferencia + " con diferencia" : ""}</div></div></li>`).join("")}</ul>` : "";
    $("#inv-empezar").onclick = async () => {
      try { S.conteo = await api("conteos", { method: "POST", body: { nombre: $("#inv-nombre").value } }); toast("Inventario abierto", "ok"); pintarInventario(); }
      catch (e) { toast(e.message, "error"); }
    };
    $$("[data-inf]").forEach(li => li.onclick = async () => verInforme(await api("conteos/" + li.dataset.inf)));
    return;
  }
  const loc = k.items.reduce((a, i) => a + i.local, 0), bod = k.items.reduce((a, i) => a + i.bodega, 0);
  cab.innerHTML = `<div class="inv-tarjeta"><h2>${esc(k.nombre)}</h2>
    <div class="det">Abierto ${fechaCorta(k.creado)} · ${k.items.length} de ${k.productos_activos} productos contados</div>
    <div class="zonas">${["Local", "Bodega"].map(z => `<button data-zona="${z}" class="${S.zona === z ? "activo" : ""}">${z === "Local" ? "🏪" : "📦"} ${z}</button>`).join("")}</div>
    <div class="nota">Este teléfono cuenta en: <b>${S.zona}</b>. Cada lectura suma 1.</div>
    <div class="inv-stats"><div><b>${loc}</b><span>Local</span></div><div><b>${bod}</b><span>Bodega</span></div><div><b>${loc + bod}</b><span>Total contado</span></div></div>
    ${k.por_dispositivo.length ? `<div class="nota" style="margin-top:8px">${k.por_dispositivo.map(d => `${esc(d.dispositivo)} (${d.zona}): ${d.unidades} un.`).join(" · ")}</div>` : ""}
    <div class="dos" style="margin-top:10px"><button class="btn primario" id="inv-cerrar">✔ Cerrar inventario</button><button class="btn peligro" id="inv-anular">Anular</button></div></div>`;
  cuerpo.innerHTML = `<h3 class="sub">Contado (lo último arriba)</h3><ul class="lista compacta">${k.items.map(i => `<li class="item" data-cnt="${i.id}">
      <div class="info"><div class="nom">${esc(i.nombre)}</div><div class="det">Local ${i.local} · Bodega ${i.bodega} · total <b>${i.total}</b> · sistema ${i.existencia}</div></div>
      ${fmtDif(i.diferencia)}</li>`).join("") || '<li class="vacio">Escanea el primer producto</li>'}</ul>`;
  $$("[data-zona]").forEach(b => b.onclick = () => { S.zona = b.dataset.zona; guardar("inv_zona", S.zona); pintarInventario(); });
  $("#inv-cerrar").onclick = prepararCierre;
  $("#inv-anular").onclick = async () => {
    if (!confirm("¿Anular este inventario? No se cambia ningún stock.")) return;
    try { await api(`conteos/${k.id}/anular`, { method: "POST" }); toast("Inventario anulado"); pintarInventario(); } catch (e) { toast(e.message, "error"); }
  };
  $$("[data-cnt]").forEach(li => li.onclick = () => corregirConteo(k.items.find(i => String(i.id) === li.dataset.cnt)));
}

// Corregir lo que contó ESTE teléfono en su zona (por ejemplo, si escaneó de más)
function corregirConteo(i) {
  abrirHoja(`<h2>${esc(i.nombre)}</h2>
    <p class="nota">Local ${i.local} · Bodega ${i.bodega} · sistema ${i.existencia}.<br>Escribe cuántas unidades contó <b>este teléfono</b> en <b>${S.zona}</b>.</p>
    <form id="f-cnt"><input id="cnt-n" type="number" inputmode="numeric" min="0" value="">
    <button class="btn primario ancho" style="margin-top:12px">Guardar</button></form>`);
  $("#cnt-n").focus();
  $("#f-cnt").onsubmit = async e => {
    e.preventDefault();
    try {
      await api(`conteos/${S.conteo.id}/fijar`, { method: "POST", body: { producto_id: i.id, zona: S.zona, cantidad: parseInt($("#cnt-n").value, 10) || 0 } });
      toast("Conteo corregido", "ok"); cerrarHoja(); pintarInventario();
    } catch (err) { toast(err.message, "error"); }
  };
}

// Paso 1 del cierre: revisar los productos que nadie escaneó
async function prepararCierre() {
  if (S.cola.length && !(await enviarCola())) { toast(window.NUBE ? "Hay lecturas sin enviar: espera a tener internet antes de cerrar" : "Hay lecturas sin enviar: conéctate al Wi-Fi del local antes de cerrar", "error"); return; }
  const nc = await api(`conteos/${S.conteo.id}/no_contados`);
  const marcados = new Set();
  const pinta = () => {
    abrirHoja(`<h2>Cerrar inventario</h2>
      <p class="nota">${S.conteo.items.length} productos contados: su stock quedará igual a Local + Bodega.<br>
      <b>${nc.length}</b> productos no se escanearon. Elige qué hacer con cada uno:</p>
      ${nc.length ? `<div class="dos"><button class="btn" id="nc-todos0">Todos en 0</button><button class="btn" id="nc-mantener">Mantener todos</button></div>
      <div style="max-height:45vh;overflow:auto;margin:10px 0">${nc.map(p => `<div class="nc-item"><div class="info"><div class="nom">${esc(p.nombre)}</div>
        <div class="det">${esc(p.departamento)} · sistema ${p.existencia}</div></div>
        <label><input type="checkbox" data-nc="${p.id}" ${marcados.has(p.id) ? "checked" : ""}> dejar en 0</label></div>`).join("")}</div>` : ""}
      <p class="nota">${marcados.size} quedarán en 0 · ${nc.length - marcados.size} mantienen su stock.</p>
      <button class="btn primario ancho" id="nc-confirmar">Confirmar y cerrar</button>`);
    $$("[data-nc]").forEach(ch => ch.onchange = () => { const id = +ch.dataset.nc; ch.checked ? marcados.add(id) : marcados.delete(id); pinta(); });
    const t0 = $("#nc-todos0"), tm = $("#nc-mantener");
    if (t0) t0.onclick = () => { nc.forEach(p => marcados.add(p.id)); pinta(); };
    if (tm) tm.onclick = () => { marcados.clear(); pinta(); };
    $("#nc-confirmar").onclick = async () => {
      if (!confirm(`¿Cerrar «${S.conteo.nombre}»? Se ajustará el stock de ${S.conteo.items.length + marcados.size} productos.`)) return;
      try {
        const r = await api(`conteos/${S.conteo.id}/cerrar`, { method: "POST", body: { cero: [...marcados] } });
        toast("Inventario cerrado", "ok"); verInforme(r); pintarInventario(); cargarResumen();
      } catch (e) { toast(e.message, "error"); }
    };
  };
  pinta();
}

// Informe del inventario cerrado: qué existe, diferencias valorizadas y qué comprar
function verInforme(k) {
  const r = k.resultado;
  if (!r) { abrirHoja(`<h2>${esc(k.nombre)}</h2><p class="nota">Estado: ${esc(k.estado)}</p>`); return; }
  abrirHoja(`<h2>${esc(k.nombre)}</h2><p class="nota">Cerrado ${fechaCorta(k.cerrado || "")}</p>
    <div class="kpis">
      <div class="kpi"><span>Contados</span><b>${r.contados}</b><small>${r.sin_diferencia} sin diferencia</small></div>
      <div class="kpi"><span>Con diferencia</span><b style="color:var(--ambar)">${r.con_diferencia}</b><small>ajustados al conteo</small></div>
      <div class="kpi"><span>Sobrante</span><b>${r.sobrante_un} un.</b><small>${clp(r.sobrante_valor)} a costo neto</small></div>
      <div class="kpi"><span>Faltante</span><b style="color:var(--rojo)">${r.faltante_un} un.</b><small>${clp(r.faltante_valor)} a costo neto</small></div>
      <div class="kpi ancho"><span>No contados</span><b>${r.no_contados}</b><small>${r.no_contados_en_cero} quedaron en 0 (${clp(r.no_contados_valor_cero)} a costo neto) · el resto mantuvo su stock</small></div>
    </div>
    ${r.diferencias.length ? `<h3 class="sub">Diferencias</h3><table class="informe"><tr><th>Producto</th><th class="n">Sist.</th><th class="n">Contado</th><th class="n">Dif.</th></tr>
      ${r.diferencias.map(d => `<tr><td>${esc(d.nombre)}</td><td class="n">${d.sistema}</td><td class="n">${d.contado}</td><td class="n">${d.diferencia > 0 ? "+" : ""}${d.diferencia}</td></tr>`).join("")}</table>` : ""}
    ${r.comprar && r.comprar.length ? `<h3 class="sub">Qué comprar (en o bajo el mínimo)</h3><table class="informe"><tr><th>Producto</th><th class="n">Stock</th><th class="n">Mín.</th></tr>
      ${r.comprar.map(p => `<tr><td>${esc(p.nombre)}</td><td class="n">${p.existencia}</td><td class="n">${p.minimo}</td></tr>`).join("")}</table>` : ""}`);
}

async function refrescarVista() {
  try {
    if (S.vista === "escanear") await pintarUltimos();
    if (S.vista === "productos") await pintarProductos();
    if (S.vista === "inventario") await pintarInventario();
    if (S.vista === "historial") await pintarHistorial();
    if (S.vista === "ajustes") { await cargarResumen(); pintarAjustes(); }
  } catch (e) { console.warn(e); }
}

// clicks en listas
document.addEventListener("click", e => {
  const li = e.target.closest("[data-pid]");
  if (li && !li.closest("#hoja")) abrirProductoId(li.dataset.pid);
});
let tBuscar;
$("#buscar").oninput = e => { clearTimeout(tBuscar); tBuscar = setTimeout(() => { S.texto = e.target.value.trim(); pintarProductos(); }, 220); };
$$(".chip-f").forEach(b => b.onclick = () => {
  $$(".chip-f").forEach(x => x.classList.toggle("activo", x === b));
  S.filtro = b.dataset.f; pintarProductos();
});
$("#filtro-depto").onchange = e => { S.depto = e.target.value; pintarProductos(); };
$("#btn-nuevo").onclick = () => formProducto(null);
$("#btn-respaldo").onclick = async () => {
  try { const r = await api("respaldo", { method: "POST" }); toast("Respaldo creado: " + r.archivo, "ok"); } catch (e) { toast(e.message, "error"); }
};

/* ---------------- Sincronización entre teléfonos ---------------- */
async function latido() {
  try {
    const r = await api("estado");
    $("#punto").className = "punto ok";
    // M-69: al volver la conexión se envían las lecturas guardadas; si otro teléfono contó, se actualiza la lista
    if (S.cola.length) { await enviarCola(); if (S.vista === "inventario") pintarInventario(); }
    if (S.versionConteo !== -1 && r.conteo !== S.versionConteo && S.vista === "inventario" && $("#hoja").hidden) pintarInventario();
    S.versionConteo = r.conteo;
    if (S.version !== -1 && r.version !== S.version) {
      refrescarVista();
      // actualizar stock en pantalla si otro teléfono lo cambió
      if (S.productoAbierto && $("#p-stock")) {
        const p = await api("productos/" + S.productoAbierto.id);
        if (p.existencia !== S.productoAbierto.existencia) { S.productoAbierto = p; $("#p-stock").textContent = p.existencia; toast("Stock actualizado por otro dispositivo"); }
      }
    }
    S.version = r.version;
  } catch (e) { $("#punto").className = "punto mal"; }
}

/* ---------------- Inicio ---------------- */
(async function inicio() {
  pintarDispositivo();
  pintarCola();
  try { await cargarResumen(); } catch (e) { toast(window.NUBE ? "Sin conexión: se usan los datos guardados en el teléfono" : "No hay conexión con el PC", "error"); }
  refrescarVista();
  latido(); setInterval(latido, 3000);
  if (!S.dispositivo) pedirNombre();
  // En PC: el campo manual queda listo para lectores USB
  if (matchMedia("(pointer:fine)").matches) $("#codigo-manual").focus();
})();
