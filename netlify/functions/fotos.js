// ════════════════════════════════════════════════════════════════
//  Fotos de instalación — Palacios del Este
//  Guarda las fotos en Supabase Storage para que las vea CUALQUIER
//  celular, no solo el que las tomó.
//
//  Variables de entorno que hay que poner en Netlify:
//    SUPABASE_URL               → https://xxxxxxxx.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY  → llave "service_role" (SECRETA)
//
//  Seguridad: el que llama tiene que mandar un token válido de Monday
//  (el mismo que los instaladores ya pegan en ⚙️ Configuración de la
//  app). Así un desconocido no puede subir ni listar fotos.
// ════════════════════════════════════════════════════════════════

// Se leen en cada llamada (no al cargar el archivo) para que un cambio de
// variable en Netlify aplique sin depender de cuándo arrancó la función.
const env = () => ({
  SUPABASE_URL: process.env.SUPABASE_URL,
  SERVICE_KEY:  process.env.SUPABASE_SERVICE_ROLE_KEY
});
let SUPABASE_URL, SERVICE_KEY;
const BUCKET       = 'fotos';
const PROYECTO     = 'palacios';
const FIRMA_URL    = 3600 * 6;   // los enlaces de foto duran 6 horas

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

// ── ¿El token de Monday es de verdad? ────────────────────────────
async function mondayOk(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return false;
  try {
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query: '{ me { id } }' })
    });
    const d = await r.json();
    return !!(d && d.data && d.data.me && d.data.me.id);
  } catch (e) { return false; }
}

// ── Helpers de Supabase (REST, sin librerías) ────────────────────
const sbHeaders = extra => Object.assign({
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY
}, extra || {});

async function sbUpload(ruta, buffer, mime) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${ruta}`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }),
    body: buffer
  });
  if (!r.ok) throw new Error('Storage: ' + (await r.text()).slice(0, 200));
}

async function sbSignedUrl(ruta) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${ruta}`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: FIRMA_URL })
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.signedURL ? SUPABASE_URL + '/storage/v1' + d.signedURL : null;
}

async function sbInsert(fila) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fotos`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(fila)
  });
  if (!r.ok) throw new Error('BD: ' + (await r.text()).slice(0, 200));
  return (await r.json())[0];
}

async function sbSelect(unidad) {
  const q = `proyecto=eq.${PROYECTO}&unidad=eq.${encodeURIComponent(unidad)}` +
            `&order=created_at.asc&select=id,ruta,rol,autor,created_at`;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/fotos?${q}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error('BD: ' + (await r.text()).slice(0, 200));
  return r.json();
}

// ── Handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });
  ({ SUPABASE_URL, SERVICE_KEY } = env());
  if (!SUPABASE_URL || !SERVICE_KEY)
    return json(500, { error: 'Faltan las variables SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en Netlify' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: 'Petición inválida' }); }

  if (!(await mondayOk(body.token))) return json(401, { error: 'Token de Monday inválido' });

  try {
    // ── Listar las fotos de una unidad ────────────────────────────
    if (body.action === 'list') {
      const unidad = String(body.unidad || '').replace(/\D/g, '');
      if (!unidad) return json(400, { error: 'Falta la unidad' });
      const filas = await sbSelect(unidad);
      const fotos = [];
      for (const f of filas) {
        const url = await sbSignedUrl(f.ruta);
        if (url) fotos.push({ id: f.id, url, rol: f.rol, autor: f.autor, fecha: f.created_at });
      }
      return json(200, { fotos });
    }

    // ── Subir una foto ────────────────────────────────────────────
    if (body.action === 'upload') {
      const unidad = String(body.unidad || '').replace(/\D/g, '');
      if (!unidad) return json(400, { error: 'Falta la unidad' });

      const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(body.dataUrl || ''));
      if (!m) return json(400, { error: 'La foto no llegó en el formato esperado' });
      const mime   = m[1];
      const buffer = Buffer.from(m[2], 'base64');
      if (buffer.length > 8 * 1024 * 1024) return json(413, { error: 'La foto pesa demasiado' });

      const ext  = mime === 'image/png' ? 'png' : 'jpg';
      const ruta = `${PROYECTO}/unidad-${unidad.padStart(3, '0')}/` +
                   `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

      await sbUpload(ruta, buffer, mime);
      const fila = await sbInsert({
        proyecto:        PROYECTO,
        unidad:          unidad,
        unidad_nombre:   String(body.unidadNombre || ('Unidad ' + unidad)).slice(0, 80),
        monday_item_id:  body.unitId ? String(body.unitId) : null,
        ruta:            ruta,
        rol:             String(body.rol || '').slice(0, 60),
        autor:           String(body.autor || '').slice(0, 80),
        mime:            mime,
        bytes:           buffer.length
      });

      return json(200, { ok: true, id: fila.id, url: await sbSignedUrl(ruta) });
    }

    return json(400, { error: 'Acción desconocida' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
