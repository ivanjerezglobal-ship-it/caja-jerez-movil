/* Comercializadora Jerez · app del celular por internet (M-71)
   Atiende las mismas rutas que el servidor del PC («api/productos», «api/movimientos», «api/conteos»…),
   pero contra Supabase, con usuario y clave por persona.

   Sin conexión:
   - El catálogo queda guardado en el teléfono: buscar, escanear y ver stock funcionan sin internet.
   - Cada movimiento (sumar, restar, conteo exacto) recibe un id único (uuid) y queda en una cola en el
     teléfono; se envía solo al volver internet. Un reenvío nunca se cuenta dos veces.
   - Las lecturas del inventario por zonas usan la cola propia de la app (inv_cola).
   - Crear o editar productos y cerrar un inventario necesitan internet. */
"use strict";
(function () {
  const URL_SB = "https://insqmprzkrgqswucvchq.supabase.co";
  // clave publicable: es pública por diseño; los permisos los controla la base (RLS + perfiles)
  const CLAVE = "sb_publishable_yBr8uhWIvFYmVpfieonfpQ_G3wG1iDi";

  const ls = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    },
  };

  const N = {
    sesion: ls.get("nube_sesion", null),       // {access_token, refresh_token, expires_at, email, uid}
    perfil: ls.get("nube_perfil", null),       // {nombre, rol}
    prods: ls.get("nube_productos", []),       // catálogo (tal como está en la nube)
    desde: ls.get("nube_prod_desde", ""),      // último «actualizado» recibido
    cola: ls.get("nube_cola", []),             // movimientos que aún no llegan a la nube
    movs: ls.get("nube_movs", []),             // últimos movimientos (para Escanear e Historial)
    resumenPc: ls.get("nube_resumen_pc", null),
    conteo: ls.get("nube_conteo", null),       // último inventario abierto que se vio
    movHoy: ls.get("nube_mov_hoy", 0),
    ultimaSync: ls.get("nube_ultima", ""),
    version: 0,
    conteoVer: "",
    enLinea: true,
    ultimoIntento: 0,
    ultimoConteo: 0,
    ultimoExtra: 0,
    sincronizando: null,
    rechazados: [],
  };

  /* ---------------- utilidades ---------------- */
  const norm = s => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const dos = n => String(n).padStart(2, "0");
  function fechaLocal(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
  }
  function hoyLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function falla(msg, status) {
    const e = new Error(msg);
    if (status) e.status = status;
    return e;
  }
  function entero(v) {
    const n = parseInt(String(v == null ? "" : v).replace(/[^\d-]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  function traducir(msg) {
    const m = String(msg || "");
    if (/productos_codigo_key|duplicate key/i.test(m)) return "Ya existe un producto con ese código";
    if (/Invalid login credentials/i.test(m)) return "Correo o clave incorrectos";
    if (/Email not confirmed/i.test(m)) return "Falta confirmar el correo de este usuario";
    if (/JWT expired|invalid JWT/i.test(m)) return "La sesión venció: vuelve a entrar";
    if (/permission denied|row-level security/i.test(m)) return "Tu usuario no tiene permiso para esto";
    return m;
  }
  function guardarTodo() {
    ls.set("nube_productos", N.prods);
    ls.set("nube_prod_desde", N.desde);
    ls.set("nube_movs", N.movs);
    ls.set("nube_mov_hoy", N.movHoy);
    ls.set("nube_ultima", N.ultimaSync);
  }
  const guardarCola = () => ls.set("nube_cola", N.cola);

  /* ---------------- sesión ---------------- */
  let avisarListo;
  const listo = new Promise(ok => (avisarListo = ok));

  function guardarSesion(d) {
    N.sesion = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
      email: (d.user && d.user.email) || (N.sesion && N.sesion.email) || "",
      uid: (d.user && d.user.id) || (N.sesion && N.sesion.uid) || "",
    };
    ls.set("nube_sesion", N.sesion);
  }

  async function auth(tipo, cuerpo) {
    let r;
    try {
      r = await fetch(`${URL_SB}/auth/v1/token?grant_type=${tipo}`, {
        method: "POST",
        headers: { apikey: CLAVE, "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
    } catch (e) {
      N.enLinea = false;
      throw falla("Sin conexión a internet");
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw falla(traducir(d.msg || d.error_description || d.message || "Error " + r.status), 401);
    return d;
  }

  let renovando = null;
  async function token() {
    if (!N.sesion) throw falla("Falta entrar con tu usuario", 401);
    if (N.sesion.expires_at - 90 > Date.now() / 1000) return N.sesion.access_token;
    if (!renovando) {
      renovando = auth("refresh_token", { refresh_token: N.sesion.refresh_token })
        .then(d => guardarSesion(d))
        .catch(e => {
          if (e.status === 401) cerrarSesion("La sesión venció: vuelve a entrar");
          throw e;
        })
        .finally(() => (renovando = null));
    }
    await renovando;
    return N.sesion.access_token;
  }

  async function sb(ruta, { method = "GET", body, prefer, conteo } = {}) {
    const h = { apikey: CLAVE, "Content-Type": "application/json", Authorization: "Bearer " + (await token()) };
    if (prefer) h.Prefer = prefer;
    if (conteo) {
      h.Prefer = "count=exact";
      h.Range = "0-0";
    }
    let r;
    try {
      r = await fetch(URL_SB + "/rest/v1/" + ruta, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      N.enLinea = false;
      throw falla("Sin conexión a internet");
    }
    N.enLinea = true;
    if (conteo) {
      const cr = r.headers.get("content-range") || "";
      return parseInt(cr.split("/")[1], 10) || 0;
    }
    const txt = await r.text();
    let d = null;
    try {
      d = txt ? JSON.parse(txt) : null;
    } catch (e) {}
    if (!r.ok) {
      const code = d && d.code;
      const msg = traducir((d && (d.message || d.msg || d.error)) || "Error " + r.status);
      if (r.status === 401 && /JWT/i.test(msg + (d && d.message))) cerrarSesion("La sesión venció: vuelve a entrar");
      const st = code === "P0002" ? 404 : code === "42501" ? 403 : code === "23505" ? 409 : r.status >= 500 ? r.status : r.status === 401 ? 401 : 400;
      throw falla(msg, st);
    }
    return d;
  }
  const rpc = (fn, args) => sb("rpc/" + fn, { method: "POST", body: args || {} });

  async function entrar(email, clave) {
    const d = await auth("password", { email: email.trim(), password: clave });
    guardarSesion(d);
    const p = await sb(`perfiles?id=eq.${N.sesion.uid}&select=nombre,rol`);
    if (!p || !p.length) {
      cerrarSesion("Tu usuario todavía no tiene permiso. Pide al administrador que te asigne un rol.");
      throw falla("Tu usuario todavía no tiene permiso. Pide al administrador que te asigne un rol.", 403);
    }
    N.perfil = p[0];
    ls.set("nube_perfil", N.perfil);
  }

  function cerrarSesion(motivo) {
    N.sesion = null;
    N.perfil = null;
    ls.del("nube_sesion");
    ls.del("nube_perfil");
    mostrarLogin(motivo);
  }

  /* ---------------- pantalla de entrada ---------------- */
  function mostrarLogin(motivo) {
    const el = document.getElementById("login");
    if (!el) return;
    el.hidden = false;
    document.getElementById("login-msg").textContent = motivo || "";
    const pend = N.cola.length;
    document.getElementById("login-cola").textContent = pend
      ? `Hay ${pend} movimiento${pend === 1 ? "" : "s"} guardado${pend === 1 ? "" : "s"} en este teléfono: se enviarán al entrar.`
      : "";
    setTimeout(() => document.getElementById("login-email").focus(), 50);
  }

  function prepararLogin() {
    const f = document.getElementById("login-form");
    if (!f) return;
    const email = ls.get("nube_ultimo_email", "");
    if (email) document.getElementById("login-email").value = email;
    f.onsubmit = async e => {
      e.preventDefault();
      const b = f.querySelector("button");
      b.disabled = true;
      document.getElementById("login-msg").textContent = "Entrando…";
      try {
        const correo = document.getElementById("login-email").value;
        await entrar(correo, document.getElementById("login-clave").value);
        ls.set("nube_ultimo_email", correo.trim());
        document.getElementById("login-clave").value = "";
        document.getElementById("login").hidden = true;
        avisarListo();
        N.ultimoIntento = 0;
        sincronizar().catch(() => {});
      } catch (err) {
        document.getElementById("login-msg").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  }

  /* ---------------- catálogo y cola ---------------- */
  function pendienteDe(id) {
    return N.cola.reduce((a, m) => a + (m.producto_id === id ? m.cantidad : 0), 0);
  }
  // producto como lo ve la app: stock de la nube + lo que este teléfono aún no envía
  function ver(p) {
    return { ...p, existencia: (p.existencia || 0) + pendienteDe(p.id) };
  }
  // M-72 · fotos públicas de la carpeta «productos» de Supabase Storage (mismo nombre que en el PC)
  const urlFoto = n => `${URL_SB}/storage/v1/object/public/productos/${encodeURIComponent(n)}`;

  async function subirFoto(id, dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || "");
    if (!m) throw falla("Imagen inválida", 400);
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length > 5000000) throw falla("Imagen demasiado grande (máx. 5 MB)", 400);
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const nombre = `nube_${id}_${Date.now()}.${ext}`;
    let r;
    try {
      r = await fetch(`${URL_SB}/storage/v1/object/productos/${nombre}`, {
        method: "POST",
        headers: { apikey: CLAVE, Authorization: "Bearer " + (await token()), "Content-Type": "image/" + m[1], "x-upsert": "false" },
        body: bytes,
      });
    } catch (e) {
      N.enLinea = false;
      throw falla("Sin conexión a internet: la foto se sube cuando vuelva");
    }
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw falla("No se pudo subir la foto: " + traducir(d.message || d.error || r.status), r.status >= 500 ? r.status : 400);
    }
    const t = await sb(`productos?id=eq.${Number(id)}`, { method: "PATCH", body: { imagen: nombre }, prefer: "return=representation" });
    if (!t || !t.length) throw falla("Producto no encontrado", 404);
    mezclar(t);
    N.version++;
    guardarTodo();
    return ver(t[0]);
  }
  const buscarId = id => N.prods.find(p => p.id === Number(id));

  function mezclar(filas) {
    if (!filas || !filas.length) return 0;
    const idx = new Map(N.prods.map((p, i) => [p.id, i]));
    for (const r of filas) {
      if (idx.has(r.id)) N.prods[idx.get(r.id)] = r;
      else {
        idx.set(r.id, N.prods.length);
        N.prods.push(r);
      }
      if (!N.desde || r.actualizado > N.desde) N.desde = r.actualizado;
    }
    return filas.length;
  }

  async function bajarProductos() {
    let cambios = 0;
    if (!N.prods.length || !N.desde) {
      // primera vez: catálogo completo, de a 1000 (límite de Supabase por consulta)
      const todos = [];
      for (let desde = 0; ; desde += 1000) {
        const t = await sb(`productos?select=*&order=id.asc&limit=1000&offset=${desde}`);
        todos.push(...t);
        if (t.length < 1000) break;
      }
      N.prods = [];
      N.desde = "";
      cambios = mezclar(todos);
    } else {
      for (;;) {
        const t = await sb(`productos?select=*&actualizado=gt.${encodeURIComponent(N.desde)}&order=actualizado.asc&limit=1000`);
        cambios += mezclar(t);
        if (t.length < 1000) break;
      }
    }
    return cambios;
  }

  async function enviarCola() {
    while (N.cola.length) {
      const m = N.cola[0];
      try {
        const p = await rpc("registrar_movimiento", {
          p_id: m.id,
          p_producto: m.producto_id,
          p_cantidad: m.cantidad,
          p_tipo: m.tipo || null,
          p_dispositivo: m.dispositivo || "",
          p_nota: m.nota || "",
          p_origen: "app",
          p_fecha: m.fecha,
        });
        N.cola.shift();
        guardarCola();
        if (p) mezclar([p]);
        N.version++;
      } catch (e) {
        if (e.status && e.status < 500 && e.status !== 401) {
          // la nube lo rechazó (por ejemplo, producto inexistente): se aparta para no trabar la cola
          N.rechazados.push({ ...m, error: e.message });
          ls.set("nube_rechazados", N.rechazados);
          N.cola.shift();
          guardarCola();
          if (typeof toast === "function") toast("No se pudo registrar un movimiento: " + e.message, "error");
          continue;
        }
        throw e;
      }
    }
  }

  async function bajarMovimientos() {
    const t = await sb("movimientos?select=id,fecha,producto_id,tipo,cantidad,stock_nuevo,dispositivo,nota,origen&order=fecha.desc&limit=200");
    N.movs = t || [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    N.movHoy = await sb(`movimientos?select=id&fecha=gte.${encodeURIComponent(d.toISOString())}`, { conteo: true });
  }

  async function bajarResumenPc() {
    const t = await sb("ajustes?clave=eq.resumen_pc&select=valor,actualizado");
    if (t && t[0]) {
      N.resumenPc = t[0].valor;
      ls.set("nube_resumen_pc", N.resumenPc);
    }
  }

  async function versionConteo() {
    const k = await sb("conteos?select=id,estado&order=id.desc&limit=1");
    const i = await sb("conteo_items?select=actualizado&order=actualizado.desc&limit=1");
    N.conteoVer = JSON.stringify([k && k[0], i && i[0] && i[0].actualizado]);
  }

  // una sincronización a la vez; si no hay internet, todo sigue funcionando con lo guardado
  function sincronizar() {
    if (N.sincronizando) return N.sincronizando;
    N.sincronizando = (async () => {
      N.ultimoIntento = Date.now();
      try {
        await enviarCola();
        const cambios = await bajarProductos();
        const extra = Date.now() - N.ultimoExtra > 30000;
        if (cambios || extra) await bajarMovimientos();
        if (extra) {
          await bajarResumenPc();
          N.ultimoExtra = Date.now();
        }
        if (cambios) N.version++;
        N.ultimaSync = new Date().toISOString();
        guardarTodo();
      } finally {
        N.sincronizando = null;
      }
    })();
    return N.sincronizando;
  }

  async function asegurarCatalogo() {
    if (!N.prods.length) await sincronizar();
  }

  /* ---------------- vistas que arma la app ---------------- */
  function listarProductos(q) {
    const texto = norm(q.get("q") || "").trim();
    const depto = q.get("departamento") || "";
    let l = N.prods.filter(p => p.activo).map(ver);
    if (texto) {
      for (const w of texto.split(/\s+/)) l = l.filter(p => norm(p.nombre).includes(w) || norm(p.codigo).includes(w) || norm(p.departamento).includes(w));
    }
    if (depto) l = l.filter(p => p.departamento === depto);
    if (q.get("bajo") === "1") l = l.filter(p => p.existencia <= p.minimo);
    if (q.get("sin_codigo") === "1") l = l.filter(p => !p.codigo);
    const col = new Intl.Collator("es", { sensitivity: "base" });
    return l.sort((a, b) => col.compare(a.departamento, b.departamento) || col.compare(a.nombre, b.nombre));
  }

  function movParaApp(m, pendiente) {
    const p = buscarId(m.producto_id);
    return {
      producto_id: m.producto_id,
      nombre: p ? p.nombre : "Producto " + m.producto_id,
      codigo: p ? p.codigo : "",
      fecha: fechaLocal(m.fecha),
      tipo: m.tipo || (m.cantidad >= 0 ? "entrada" : "salida"),
      cantidad: m.cantidad,
      stock_nuevo: pendiente ? "⏳ sin enviar" : m.stock_nuevo,
      dispositivo: m.dispositivo,
      nota: pendiente ? (m.nota ? m.nota + " · " : "") + "pendiente" : m.nota,
    };
  }

  async function listarMovimientos(q) {
    const lim = Math.min(parseInt(q.get("limite") || "100", 10) || 100, 500);
    const pid = q.get("producto_id") ? Number(q.get("producto_id")) : null;
    let lista = N.movs;
    if (pid) {
      try {
        lista = await sb(`movimientos?select=id,fecha,producto_id,tipo,cantidad,stock_nuevo,dispositivo,nota&producto_id=eq.${pid}&order=fecha.desc&limit=${lim}`);
      } catch (e) {
        lista = N.movs.filter(m => m.producto_id === pid);
      }
    }
    const pend = N.cola.filter(m => !pid || m.producto_id === pid).slice().reverse().map(m => movParaApp(m, true));
    return pend.concat(lista.map(m => movParaApp(m, false))).slice(0, lim);
  }

  function resumen() {
    const rp = N.resumenPc || {};
    const cf = rp.cfg || { modo: 2, iva: 19, obj: 20, pctAdq: 0 };
    const IVA = 1 + (Number(cf.iva) || 19) / 100;
    const cef = x => (Number(cf.modo) === 2 ? x / IVA : x);
    const prods = N.prods.filter(p => p.activo).map(ver);
    const pos = p => Math.max(p.existencia, 0);
    const vc = prods.reduce((a, p) => a + pos(p) * p.costo, 0);
    const neto = prods.reduce((a, p) => a + pos(p) * cef(p.costo), 0);
    const vv = prods.reduce((a, p) => a + pos(p) * p.venta, 0);
    const deHoy = rp.fecha === hoyLocal();
    return {
      productos: prods.length,
      unidades: prods.reduce((a, p) => a + pos(p), 0),
      valor_costo: Math.round(vc),
      valor_costo_neto: Math.round(neto * (1 + (Number(cf.pctAdq) || 0) / 100)),
      valor_venta: Math.round(vv),
      margen_potencial: vv ? (vv / IVA - neto) / (vv / IVA) : null,
      sin_stock: prods.filter(p => p.existencia <= 0).length,
      sin_stock_con_minimo: prods.filter(p => p.existencia <= 0 && p.minimo > 0).length,
      bajo_minimo: prods.filter(p => p.minimo > 0 && p.existencia > 0 && p.existencia <= p.minimo).length,
      sin_codigo: prods.filter(p => !p.codigo).length,
      ventas_hoy: deHoy && rp.ventas_hoy != null ? rp.ventas_hoy : null,
      utilidad_hoy: deHoy ? rp.utilidad_hoy : null,
      movimientos_hoy: N.movHoy + N.cola.length,
      departamentos: [...new Set(prods.map(p => p.departamento))].sort(),
      cfg: cf,
    };
  }

  function conteoParaApp(k) {
    if (!k) return null;
    return {
      ...k,
      creado: fechaLocal(k.creado),
      cerrado: k.cerrado ? fechaLocal(k.cerrado) : null,
      items: k.items || [],
      por_dispositivo: k.por_dispositivo || [],
    };
  }

  function camposProducto(d) {
    const f = {};
    if ("codigo" in d) f.codigo = String(d.codigo || "").trim() || null;
    if ("nombre" in d) {
      f.nombre = String(d.nombre || "").trim();
      if (!f.nombre) throw falla("El nombre es obligatorio", 400);
    }
    if ("departamento" in d) f.departamento = String(d.departamento || "").trim() || "- Sin Departamento -";
    for (const k of ["costo", "venta", "mayoreo", "minimo", "maximo"]) if (k in d) f[k] = entero(d[k]);
    if ("activo" in d) f.activo = !!d.activo;
    return f;
  }

  function dispositivo() {
    return (typeof S !== "undefined" && S.dispositivo) || (N.perfil && N.perfil.nombre) || "Celular";
  }

  /* ---------------- rutas (las mismas del servidor del PC) ---------------- */
  async function api(ruta, opts = {}) {
    await listo;
    const metodo = (opts.method || "GET").toUpperCase();
    const body = opts.body || {};
    const [camino, qs] = ruta.split("?");
    const q = new URLSearchParams(qs || "");
    const partes = camino.split("/").filter(Boolean);
    let m;

    if (camino === "estado") {
      // el latido de la app llega cada 3 s: la nube se consulta cada 10 s
      if (Date.now() - N.ultimoIntento > 10000) await sincronizar();
      else if (N.sincronizando) await N.sincronizando;
      else if (!N.enLinea) throw falla("Sin conexión a internet");
      if (typeof S !== "undefined" && S.vista === "inventario" && Date.now() - N.ultimoConteo > 4000) {
        N.ultimoConteo = Date.now();
        await versionConteo();
      }
      return { version: N.version, conteo: N.conteoVer };
    }

    if (camino === "resumen") {
      await asegurarCatalogo();
      return resumen();
    }

    if (camino === "respaldo") {
      return { archivo: "todo queda en Supabase y el PC guarda copias cada 10 minutos" };
    }

    if (partes[0] === "productos") {
      if (partes[1] === "codigo" && metodo === "GET") {
        await asegurarCatalogo();
        const cod = decodeURIComponent(partes[2] || "").trim();
        let p = N.prods.find(x => x.activo && x.codigo === cod);
        if (!p && N.enLinea) {
          await sincronizar().catch(() => {});
          p = N.prods.find(x => x.activo && x.codigo === cod);
        }
        if (!p) throw falla("Producto no encontrado", 404);
        return ver(p);
      }
      if (partes.length === 1 && metodo === "GET") {
        await asegurarCatalogo();
        return listarProductos(q);
      }
      if (partes.length === 1 && metodo === "POST") {
        const f = camposProducto(body);
        const p = await rpc("crear_producto", {
          p_codigo: f.codigo || "",
          p_nombre: f.nombre || "",
          p_departamento: f.departamento || "- Sin Departamento -",
          p_costo: f.costo || 0,
          p_venta: f.venta || 0,
          p_mayoreo: f.mayoreo || 0,
          p_existencia: entero(body.existencia),
          p_minimo: f.minimo || 0,
          p_maximo: f.maximo || 0,
          p_dispositivo: dispositivo(),
        });
        mezclar([p]);
        N.version++;
        guardarTodo();
        return ver(p);
      }
      if (partes[2] === "imagen" && metodo === "POST") {
        return subirFoto(partes[1], body.imagen);
      }
      if (partes.length === 2 && metodo === "GET") {
        await asegurarCatalogo();
        const p = buscarId(partes[1]);
        if (!p) throw falla("Producto no encontrado", 404);
        return ver(p);
      }
      if (partes.length === 2 && metodo === "PUT") {
        const t = await sb(`productos?id=eq.${Number(partes[1])}`, { method: "PATCH", body: camposProducto(body), prefer: "return=representation" });
        if (!t || !t.length) throw falla("Producto no encontrado", 404);
        mezclar(t);
        N.version++;
        guardarTodo();
        return ver(t[0]);
      }
    }

    if (camino === "movimientos" && metodo === "GET") {
      return listarMovimientos(q);
    }

    if (camino === "movimientos" && metodo === "POST") {
      await asegurarCatalogo();
      const p = buscarId(body.producto_id);
      if (!p) throw falla("Producto no encontrado", 404);
      const ajuste = body.tipo === "ajuste";
      const cantidad = ajuste ? entero(body.existencia) - ver(p).existencia : entero(body.cantidad);
      if (!ajuste && !cantidad) throw falla("La cantidad no puede ser 0", 400);
      N.cola.push({
        id: uuid(),
        producto_id: p.id,
        cantidad,
        tipo: ajuste ? "ajuste" : null,
        dispositivo: body.dispositivo || dispositivo(),
        nota: String(body.nota || "").slice(0, 200),
        fecha: new Date().toISOString(),
      });
      guardarCola();
      N.version++;
      // se intenta enviar al tiro; si no hay internet, queda en la cola
      sincronizar().catch(() => {});
      return { producto: ver(p) };
    }

    if (partes[0] === "conteos") {
      const id = partes[1] && partes[1] !== "abierto" ? Number(partes[1]) : null;
      const accion = partes[2] || "";
      if (partes[1] === "abierto") {
        try {
          N.conteo = await rpc("conteo_detalle", { p_id: null });
          ls.set("nube_conteo", N.conteo);
        } catch (e) {
          if (e.status) throw e;
          // sin internet: se sigue contando con el último inventario visto (las lecturas van a la cola)
        }
        return conteoParaApp(N.conteo);
      }
      if (!id && metodo === "GET") {
        const t = await sb("conteos?select=id,nombre,estado,creado,cerrado,resultado&order=id.desc&limit=30");
        return (t || []).map(k => ({
          ...k,
          creado: fechaLocal(k.creado),
          cerrado: k.cerrado ? fechaLocal(k.cerrado) : null,
          productos: k.resultado ? k.resultado.contados : "—",
        }));
      }
      if (!id && metodo === "POST") {
        N.conteo = await rpc("conteo_abrir", { p_nombre: body.nombre || "", p_dispositivo: dispositivo() });
        ls.set("nube_conteo", N.conteo);
        return conteoParaApp(N.conteo);
      }
      if (id && !accion && metodo === "GET") {
        return conteoParaApp(await rpc("conteo_detalle", { p_id: id }));
      }
      if (accion === "leer" || accion === "fijar") {
        const r = await rpc("conteo_contar", {
          p_conteo: id,
          p_producto: accion === "fijar" ? Number(body.producto_id) : null,
          p_codigo: accion === "leer" ? String(body.codigo || "") : null,
          p_zona: body.zona || "Local",
          p_dispositivo: dispositivo(),
          p_cantidad: accion === "fijar" ? entero(body.cantidad) : entero(body.cantidad || 1),
          p_fijar: accion === "fijar",
        });
        if (r && r.producto) r.producto = ver(r.producto);
        return r;
      }
      if (accion === "no_contados") {
        return ((await rpc("conteo_no_contados", { p_conteo: id })) || []).map(ver);
      }
      if (accion === "cerrar") {
        // primero los movimientos pendientes, para que el stock del cierre esté al día
        await enviarCola();
        if (N.cola.length) throw falla("Hay movimientos sin enviar: espera a tener internet", 409);
        const iva = (N.resumenPc && N.resumenPc.cfg && N.resumenPc.cfg.iva) || 19;
        const k = await rpc("conteo_cerrar", { p_conteo: id, p_cero: (body.cero || []).map(Number), p_dispositivo: dispositivo(), p_iva: iva });
        N.conteo = null;
        ls.del("nube_conteo");
        N.ultimoIntento = 0;
        sincronizar().catch(() => {});
        return conteoParaApp(k);
      }
      if (accion === "anular") {
        await rpc("conteo_anular", { p_conteo: id });
        N.conteo = null;
        ls.del("nube_conteo");
        return { ok: true };
      }
    }

    throw falla("Ruta no disponible en la versión por internet: " + ruta, 404);
  }

  /* ---------------- Excel (CSV) desde el catálogo guardado ---------------- */
  function exportarCsv(e) {
    e.preventDefault();
    const col = ["codigo", "nombre", "departamento", "costo", "venta", "mayoreo", "existencia", "minimo", "maximo"];
    const celda = v => {
      const s = String(v == null ? "" : v);
      return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const filas = listarProductos(new URLSearchParams()).map(p => col.map(c => celda(p[c])).join(";"));
    const blob = new Blob(["﻿" + [col.join(";")].concat(filas).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `inventario-${hoyLocal()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function infoConexion() {
    const quien = N.perfil ? `${N.perfil.nombre || (N.sesion && N.sesion.email) || ""} (${N.perfil.rol})` : "";
    const cuando = N.ultimaSync ? fechaLocal(N.ultimaSync).slice(11, 16) : "—";
    return `Conectado a la nube (Supabase) como <b>${quien.replace(/[<>&]/g, "")}</b> · al día a las ${cuando}` +
      (N.cola.length ? ` · <b>${N.cola.length}</b> movimiento(s) esperando internet` : "");
  }

  window.NUBE = { api, infoConexion, sincronizar, urlFoto, estado: () => N };

  /* ---------------- arranque ---------------- */
  prepararLogin();
  const bx = document.getElementById("btn-exportar");
  if (bx) bx.onclick = exportarCsv;
  const bs = document.getElementById("btn-salir");
  if (bs) {
    bs.onclick = () => {
      if (N.cola.length && !confirm(`Hay ${N.cola.length} movimiento(s) sin enviar. Se enviarán cuando vuelvas a entrar. ¿Salir igual?`)) return;
      cerrarSesion("");
    };
  }
  window.addEventListener("online", () => {
    N.ultimoIntento = 0;
  });
  if (N.sesion && N.perfil) avisarListo();
  else mostrarLogin("");
})();
