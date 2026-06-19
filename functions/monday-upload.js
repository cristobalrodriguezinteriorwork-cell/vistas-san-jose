// netlify/functions/monday-upload.js
// Proxy para subir archivos a Monday (evita restricciones CORS del navegador)

exports.handler = async function (event) {
  // Responder al preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'x-monday-token, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = event.headers['x-monday-token'];
  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({ errors: [{ message: 'Falta el token de Monday' }] }),
    };
  }

  const contentType = event.headers['content-type'];
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');

  try {
    const resp = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': contentType,
      },
      body: rawBody,
    });

    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors: [{ message: e.message }] }),
    };
  }
};
