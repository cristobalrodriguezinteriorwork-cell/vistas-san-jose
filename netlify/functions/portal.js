// ════════════════════════════════════════════════════════════════
//  PORTAL DEL CONTRATISTA — Palacios del Este
//
//  Lo usan el contratista y el desarrollador desde su teléfono para
//  levantar garantías y piezas faltantes. Entran con un código; el
//  token de Monday NUNCA sale de aquí, así que su teléfono no lleva
//  ninguna llave de Monday.
//
//  Variables de entorno en Netlify:
//    MONDAY_TOKEN                 → token de Monday
//    PORTAL_CONTRATISTA_CODE      → código del contratista
//    PORTAL_DESARROLLADOR_CODE    → código del desarrollador
//    SUPABASE_URL                 → https://xxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY    → llave secreta (las fotos)
// ════════════════════════════════════════════════════════════════

const BOARD_ID = 18417025952;
const MONDAY   = 'https://api.monday.com/v2';
const BUCKET   = 'fotos';
const PROYECTO = 'palacios';
const FIRMA_H  = 3600 * 6;      // los enlaces de foto duran 6 horas

const COL = {
  fabricacion: 'color_mm45sq7w',      // ✅ Fabricación (app)
  cocina:      'color_mm46atp1',      // ✅ Cocina Instalada (app)
  tope:        'color_mm45qby6',      // ✅ Topes Instalados (app)
  inspContrat: 'color_mm456st1',      // ✅ Insp. Contratista (app)
  garantias:   'long_text_mm6rh7tf',  // Garantías (lista JSON)
  marquesina:  'color_mm8rmkv5',
};

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

// ── Quién entra ──────────────────────────────────────────────────
function quienEs(codigo) {
  const c = String(codigo || '').trim().toLowerCase();
  if (!c) return null;
  const con = (process.env.PORTAL_CONTRATISTA_CODE   || '').trim().toLowerCase();
  const des = (process.env.PORTAL_DESARROLLADOR_CODE || '').trim().toLowerCase();
  if (con && c === con) return 'contratista';
  if (des && c === des) return 'desarrollador';
  return null;
}

// ── Monday ───────────────────────────────────────────────────────
async function monday(query, variables) {
  const res = await fetch(MONDAY, {
    method: 'POST',
    headers: {
      Authorization: process.env.MONDAY_TOKEN,
      'Content-Type': 'application/json',
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(j.errors[0].message || 'Error de Monday');
  return j.data;
}

const colText = (item, id) => {
  const cv = (item.column_values || []).find(c => c.id === id);
  return (cv && cv.text) || '';
};
const estado = (item, id) => {
  const t = colText(item, id).toLowerCase();
  if (['done', 'terminado', 'satisfecho'].includes(t)) return 'done';
  if (!t) return 'pending';
  if (['sin comenzar', 'sin realizar'].includes(t)) return 'pending';
  return 'progress';
};
function leerGarantias(item) {
  const raw = colText(item, COL.garantias).trim();
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

// ── Supabase (fotos) ─────────────────────────────────────────────
const sbUrl = () => process.env.SUPABASE_URL;
const sbHead = extra => Object.assign({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
}, extra || {});

async function sbSubir(ruta, buffer, mime) {
  const r = await fetch(`${sbUrl()}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: 'POST', headers: sbHead({ 'Content-Type': mime, 'x-upsert': 'true' }), body: buffer,
  });
  if (!r.ok) throw new Error('Storage: ' + (await r.text()).slice(0, 180));
}
async function sbEnlace(ruta) {
  const r = await fetch(`${sbUrl()}/storage/v1/object/sign/${BUCKET}/${ruta}`, {
    method: 'POST', headers: sbHead({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: FIRMA_H }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.signedURL ? sbUrl() + '/storage/v1' + d.signedURL : null;
}
async function sbInsertar(fila) {
  const r = await fetch(`${sbUrl()}/rest/v1/fotos`, {
    method: 'POST', headers: sbHead({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(fila),
  });
  if (!r.ok) throw new Error('BD: ' + (await r.text()).slice(0, 180));
  return (await r.json())[0];
}
async function sbListar(unidad, issueId) {
  const q = `proyecto=eq.${PROYECTO}&unidad=eq.${encodeURIComponent(unidad)}` +
            `&tipo=eq.garantia&issue_id=eq.${encodeURIComponent(issueId)}` +
            `&order=created_at.asc&select=id,ruta,created_at`;
  const r = await fetch(`${sbUrl()}/rest/v1/fotos?${q}`, { headers: sbHead() });
  if (!r.ok) throw new Error('BD: ' + (await r.text()).slice(0, 180));
  return r.json();
}

// ── Handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });
  if (!process.env.MONDAY_TOKEN) return json(500, { error: 'Falta MONDAY_TOKEN en Netlify' });

  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Petición inválida' }); }

  const quien = quienEs(b.codigo);
  if (!quien) return json(401, { error: 'Código incorrecto' });

  try {
    if (b.action === 'login') {
      return json(200, { ok: true, quien, proyecto: 'Palacios del Este' });
    }

    // ── Las casas con su avance y sus garantías ───────────────────
    if (b.action === 'casas') {
      const ids = [COL.fabricacion, COL.cocina, COL.tope, COL.inspContrat, COL.garantias, COL.marquesina];
      const q = `query($bid:ID!,$cols:[String!]){ boards(ids:[$bid]){ items_page(limit:500){
        items { id name column_values(ids:$cols){ id text } } } } }`;
      const d = await monday(q, { bid: String(BOARD_ID), cols: ids });
      const items = (d.boards?.[0]?.items_page?.items) || [];
      const casas = items.map(it => ({
        id: it.id,
        num: parseInt(String(it.name).replace(/\D/g, ''), 10) || 0,
        nombre: it.name,
        marquesina: colText(it, COL.marquesina),
        etapas: {
          fabricacion: estado(it, COL.fabricacion),
          cocina:      estado(it, COL.cocina),
          tope:        estado(it, COL.tope),
          inspContrat: estado(it, COL.inspContrat),
        },
        garantias: leerGarantias(it),
      })).sort((a, c) => a.num - c.num);
      return json(200, { casas });
    }

    // ── Levantar una garantía ─────────────────────────────────────
    if (b.action === 'nueva') {
      const itemId = String(b.itemId || '');
      const desc   = String(b.desc || '').trim();
      if (!itemId || !desc) return json(400, { error: 'Falta la casa o la descripción' });

      const q = `query($id:ID!,$cols:[String!]){ items(ids:[$id]){ id name column_values(ids:$cols){ id text } } }`;
      const d = await monday(q, { id: itemId, cols: [COL.garantias] });
      const it = d.items?.[0];
      if (!it) return json(404, { error: 'No encontré esa casa' });

      const arr = leerGarantias(it);
      const id  = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      arr.push({
        id,
        origen: quien,                                   // quién entró con su código
        tipo:   String(b.tipo || 'Otro').slice(0, 40),
        area:   String(b.area || '').slice(0, 30),
        desc:   desc.slice(0, 1000),
        d:      new Date().toISOString().slice(0, 10),
        fixed:  false,
        fd:     '',
      });

      await monday(
        `mutation($bid:ID!,$iid:ID!,$cid:String!,$val:JSON!){ change_column_value(board_id:$bid,item_id:$iid,column_id:$cid,value:$val){ id } }`,
        { bid: String(BOARD_ID), iid: itemId, cid: COL.garantias, val: JSON.stringify({ text: JSON.stringify(arr) }) }
      );
      await monday(
        `mutation($iid:ID!,$body:String!){ create_update(item_id:$iid,body:$body){ id } }`,
        { iid: itemId, body: `🛠️ GARANTÍA desde el portal — ${it.name}\nLa pidió: ${quien}\n${b.tipo || ''} · ${b.area || ''}\n\n${desc}` }
      ).catch(() => {});

      return json(200, { ok: true, id });
    }

    // ── Fotos de una garantía ─────────────────────────────────────
    if (b.action === 'fotos') {
      if (!sbUrl()) return json(500, { error: 'Faltan las variables de Supabase en Netlify' });
      const unidad  = String(b.unidad || '').replace(/\D/g, '');
      const issueId = String(b.issueId || '');
      if (!unidad || !issueId) return json(400, { error: 'Falta la casa o la garantía' });
      const filas = await sbListar(unidad, issueId);
      const fotos = [];
      for (const f of filas) {
        const url = await sbEnlace(f.ruta);
        if (url) fotos.push({ id: f.id, url });
      }
      return json(200, { fotos });
    }

    if (b.action === 'subir') {
      if (!sbUrl()) return json(500, { error: 'Faltan las variables de Supabase en Netlify' });
      const unidad  = String(b.unidad || '').replace(/\D/g, '');
      const issueId = String(b.issueId || '');
      if (!unidad || !issueId) return json(400, { error: 'Falta la casa o la garantía' });

      const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(b.dataUrl || ''));
      if (!m) return json(400, { error: 'La foto no llegó en el formato esperado' });
      const buffer = Buffer.from(m[2], 'base64');
      if (buffer.length > 8 * 1024 * 1024) return json(413, { error: 'La foto pesa demasiado' });

      const ext  = m[1] === 'image/png' ? 'png' : 'jpg';
      const ruta = `${PROYECTO}/unidad-${unidad.padStart(3, '0')}/garantias/` +
                   `${issueId.replace(/[^A-Za-z0-9_-]/g, '_')}/` +
                   `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

      await sbSubir(ruta, buffer, m[1]);
      await sbInsertar({
        proyecto: PROYECTO, unidad, unidad_nombre: 'Unidad ' + unidad,
        monday_item_id: b.itemId ? String(b.itemId) : null,
        ruta, rol: 'Portal ' + quien, autor: quien,
        tipo: 'garantia', issue_id: issueId, mime: m[1], bytes: buffer.length,
      });
      return json(200, { ok: true, url: await sbEnlace(ruta) });
    }

    return json(400, { error: 'Acción desconocida' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
