// ───────────────────────────────────────────────────────────────
//  PORTAL PALACIOS DEL ESTE — capa segura (serverless)
//  El TOKEN de Monday vive AQUÍ (variable de entorno), nunca en el navegador.
//  El cliente entra con un código; el admin con otro.
//  Variables de entorno a configurar en Netlify:
//    MONDAY_TOKEN        → tu token de Monday
//    PORTAL_CLIENT_CODE  → código que le das al cliente/desarrollador
//    PORTAL_ADMIN_CODE   → código para ustedes (Wood Studio)
// ───────────────────────────────────────────────────────────────

const BOARD_ID = 18417025952;                 // Palacios del Este (Vistas San José)
const MONDAY   = 'https://api.monday.com/v2';

// IDs de columnas del tablero de Palacios del Este
const COL = {
  fabricacion: 'color_mm45sq7w',      // Fabricacion Cocina
  cocina:      'color_mm46atp1',      // Instalación Cocina/Vanity
  tope:        'color_mm45qby6',      // Instalación Tope
  inspContrat: 'color_mm456st1',      // Inspección Contratista
  inspCliente: 'color_mm45m3b1',      // Insp. Cliente
  factura:     'color_mm45z3b8',      // Factura — solo admin. Confirmado por Cristóbal:
                                      //   la oficina usa SOLO esta. La otra columna
                                      //   parecida ("Vistas San José Facturada",
                                      //   color_mm4541b2) NO se usa.
  monto:       'numeric_mm6r2q8b',    // Monto por Casa — solo admin
  garantias:   'long_text_mm6rh7tf',  // Garantías (lista JSON)
  fotos:       'file_mm6r65pj',       // Fotos Garantía (archivos que sube el cliente)
};

async function mondayGQL(query, variables) {
  const res = await fetch(MONDAY, {
    method: 'POST',
    headers: {
      'Authorization': process.env.MONDAY_TOKEN,
      'Content-Type': 'application/json',
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message || 'Error Monday');
  return json.data;
}

// Sube un archivo a Monday (multipart al endpoint /v2/file). Formato documentado por Monday.
async function uploadToMonday(mutation, buffer, filename, mime) {
  const boundary = '----portal' + Date.now();
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="query"${CRLF}${CRLF}${mutation}${CRLF}` +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="variables[file]"; filename="${filename}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`,
    'utf8'
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
  const body = Buffer.concat([head, buffer, tail]);
  const res = await fetch('https://api.monday.com/v2/file', {
    method: 'POST',
    headers: { 'Authorization': process.env.MONDAY_TOKEN, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message || 'Error subiendo archivo');
  return json.data;
}

function roleOf(code) {
  if (code && code === process.env.PORTAL_ADMIN_CODE)  return 'admin';
  if (code && code === process.env.PORTAL_CLIENT_CODE) return 'client';
  return null;
}

const colText = (item, id) => {
  const cv = (item.column_values || []).find(c => c.id === id);
  return cv ? (cv.text || '') : '';
};

function parseGarantias(txt) {
  if (!txt || !txt.trim()) return [];
  try { const a = JSON.parse(txt); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

async function saveGarantias(unitId, arr) {
  await mondayGQL(
    `mutation($b:ID!,$i:ID!,$c:String!,$v:JSON!){ change_column_value(board_id:$b,item_id:$i,column_id:$c,value:$v){ id } }`,
    { b: String(BOARD_ID), i: String(unitId), c: COL.garantias, v: JSON.stringify({ text: arr.length ? JSON.stringify(arr) : '' }) }
  );
}

async function readGarantias(unitId) {
  const d = await mondayGQL(`{ items(ids: [${Number(unitId)}]) { column_values(ids: ["${COL.garantias}"]) { text } } }`);
  return parseGarantias(d.items[0].column_values[0].text);
}

exports.handler = async (event) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'Método no permitido' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'JSON inválido' }) }; }

  const role = roleOf(body.code);
  if (!role) return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'Código incorrecto' }) };

  try {
    // ── LOGIN ──
    if (body.action === 'login') {
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true, role }) };
    }

    // ── DATA: unidades + estados + garantías ──
    if (body.action === 'data') {
      const q = `{ boards(ids: [${BOARD_ID}]) { name items_page(limit: 500) { items { id name group { title } column_values(ids: ["${COL.fabricacion}","${COL.cocina}","${COL.tope}","${COL.inspContrat}","${COL.inspCliente}","${COL.factura}","${COL.monto}","${COL.garantias}"]) { id text } } } } }`;
      const data  = await mondayGQL(q);
      const board = data.boards[0];
      const units = board.items_page.items.map(it => ({
        id:          it.id,
        name:        it.name,
        grupo:       it.group ? it.group.title : '',
        fabricacion: colText(it, COL.fabricacion),
        cocina:      colText(it, COL.cocina),
        tope:        colText(it, COL.tope),
        inspContrat: colText(it, COL.inspContrat),
        inspCliente: colText(it, COL.inspCliente),
        garantias:   parseGarantias(colText(it, COL.garantias)),
        ...(role === 'admin' ? { factura: colText(it, COL.factura), monto: colText(it, COL.monto) } : {}),
      }));
      return { statusCode: 200, headers: H, body: JSON.stringify({ project: 'Palacios del Este', role, units }) };
    }

    // ── AGREGAR GARANTÍA (cliente o admin) ──
    if (body.action === 'addGarantia') {
      const { unitId, desc, recibe, tel, repairDate, repairTime } = body;
      if (!unitId || !desc || !String(desc).trim()) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Falta la descripción' }) };
      const arr = await readGarantias(unitId);
      arr.push({
        id:        Date.now(),
        desc:      String(desc).slice(0, 600).trim(),
        recibe:    String(recibe || '').slice(0, 120).trim(),
        tel:       String(tel || '').slice(0, 40).trim(),
        d:         new Date().toISOString(),
        visitDate: '', visitTime: '',
        repairDate: String(repairDate || '').slice(0, 10),
        repairTime: String(repairTime || '').slice(0, 5),
        fixed: false, fixedDate: '',
      });
      await saveGarantias(unitId, arr);
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }

    // ── ACTUALIZAR GARANTÍA (solo admin: visita + arreglado) ──
    if (body.action === 'updateGarantia') {
      if (role !== 'admin') return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Solo administración' }) };
      const { unitId, garantiaId, visitDate, visitTime, repairDate, repairTime, fixed } = body;
      const arr = await readGarantias(unitId);
      const g = arr.find(x => String(x.id) === String(garantiaId));
      if (!g) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Garantía no encontrada' }) };
      if (visitDate  !== undefined) g.visitDate  = visitDate;
      if (visitTime  !== undefined) g.visitTime  = visitTime;
      if (repairDate !== undefined) g.repairDate = repairDate;
      if (repairTime !== undefined) g.repairTime = repairTime;
      if (fixed     !== undefined) {
        g.fixed = !!fixed; g.fixedDate = fixed ? new Date().toISOString() : '';
        if (!fixed) { g.clientInitials = ''; g.initialsDate = ''; }   // si se reabre, se borra la confirmación
      }
      await saveGarantias(unitId, arr);
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }

    // ── CONFIRMAR SATISFACCIÓN (cliente o admin): iniciales del cliente ──
    if (body.action === 'confirmGarantia') {
      const { unitId, garantiaId, initials } = body;
      const ini = String(initials || '').trim().toUpperCase().slice(0, 5);
      if (!ini)  return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Faltan las iniciales' }) };
      const arr = await readGarantias(unitId);
      const g = arr.find(x => String(x.id) === String(garantiaId));
      if (!g)           return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Garantía no encontrada' }) };
      if (!g.fixed)     return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'La garantía aún no está marcada como arreglada' }) };
      if (g.clientInitials) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Esta garantía ya fue confirmada por el cliente' }) };
      g.clientInitials = ini;
      g.initialsDate   = new Date().toISOString();
      await saveGarantias(unitId, arr);
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }

    // ── FOTOS de garantía: LISTAR (cliente o admin) ──
    if (body.action === 'fotos') {
      const d = await mondayGQL(`{ items(ids: [${Number(body.unitId)}]) { column_values(ids: ["${COL.fotos}"]) { value } } }`);
      let files = [];
      try { files = (JSON.parse(d.items[0].column_values[0].value) || {}).files || []; } catch (e) {}
      const ids = files.map(f => f.assetId).filter(Boolean);
      if (!ids.length) return { statusCode: 200, headers: H, body: JSON.stringify({ photos: [] }) };
      const a = await mondayGQL(`{ assets(ids: [${ids.join(',')}]) { id name public_url } }`);
      const photos = (a.assets || []).map(x => ({ url: x.public_url, name: x.name }));
      return { statusCode: 200, headers: H, body: JSON.stringify({ photos }) };
    }

    // ── SUBIR foto/archivo de garantía (cliente o admin) ──
    if (body.action === 'uploadFoto') {
      const { unitId, filename, dataBase64 } = body;
      if (!unitId || !dataBase64) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Falta el archivo' }) };
      const buffer = Buffer.from(dataBase64, 'base64');
      const name = String(filename || 'archivo').replace(/[^\w.\-]/g, '_').slice(0, 80);
      const ext = (name.split('.').pop() || '').toLowerCase();
      const MIMES = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt:'text/plain' };
      const mime = MIMES[ext] || 'application/octet-stream';
      const mutation = `mutation add_file($file: File!) { add_file_to_column (item_id: ${Number(unitId)}, column_id: "${COL.fotos}", file: $file) { id } }`;
      await uploadToMonday(mutation, buffer, name, mime);
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }

    // ── FIJAR MONTO POR CASA (solo admin) ──
    if (body.action === 'setMonto') {
      if (role !== 'admin') return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Solo administración' }) };
      const val = String(body.monto == null ? '' : body.monto).replace(/[^0-9.]/g, '');
      await mondayGQL(
        `mutation($b:ID!,$i:ID!,$c:String!,$v:String!){ change_simple_column_value(board_id:$b,item_id:$i,column_id:$c,value:$v){ id } }`,
        { b: String(BOARD_ID), i: String(body.unitId), c: COL.monto, v: val }
      );
      return { statusCode: 200, headers: H, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Acción desconocida' }) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: e.message }) };
  }
};
