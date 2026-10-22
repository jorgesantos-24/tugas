'use strict';
/* Cliente mínimo da API BravoPay (https://bravopay.club/docs).
   Só usa fetch e crypto do Node — sem dependências. */

const crypto = require('node:crypto');

const BASE = (process.env.BRAVOPAY_API_URL || 'https://bravopay.club/api/v1').replace(/\/+$/, '');
// NO_EXTERNAL=1 (testes locais): nunca fala com a BravoPay real
const KEY = process.env.NO_EXTERNAL === '1' ? '' : process.env.BRAVOPAY_API_KEY || '';
const WH_SECRET = process.env.BRAVOPAY_WEBHOOK_SECRET || '';

class BravoError extends Error {
  constructor(status, code, message, details) {
    super(message || code || `HTTP ${status}`);
    this.status = status;   // 0 = falha de rede/timeout
    this.code = code || null;
    this.details = details;
  }
  // true quando a BravoPay recusou de vez (não adianta repetir)
  get definitive() { return this.status >= 400 && this.status < 500 && this.status !== 429 && this.status !== 408; }
}

async function call(method, path, body, idempotencyKey) {
  const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let r;
  try {
    r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new BravoError(0, 'network_error', 'Sem resposta da BravoPay: ' + e.message);
  }
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo JSON */ }
  if (!r.ok) {
    const err = data && data.error;
    throw new BravoError(r.status, err && err.code, err && err.message, err && err.details);
  }
  return data;
}

const enc = encodeURIComponent;
module.exports = {
  enabled: !!KEY,
  webhookEnabled: !!WH_SECRET,
  BravoError,
  createPix: (p, idem) => call('POST', '/transactions', { method: 'pix', ...p }, idem),
  getTransaction: (id) => call('GET', `/transactions/${enc(id)}`),
  createWithdrawal: (p, idem) => call('POST', '/withdrawals', { method: 'pix', ...p }, idem),
  getWithdrawal: (id) => call('GET', `/withdrawals/${enc(id)}`),
  balance: () => call('GET', '/balance'),

  /* Assinatura: header "BravoPay-Signature: t=<unix>,v1=<hex>",
     HMAC-SHA256(secret, `${t}.${corpoBruto}`). Rejeita fora de ±5 min. */
  verifySignature(header, rawBody, toleranceSec = 300) {
    if (!WH_SECRET || !header) return false;
    const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
    const t = Number(parts.t), v1 = String(parts.v1 || '');
    if (!t || !/^[0-9a-f]+$/i.test(v1)) return false;
    if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
    const expected = crypto.createHmac('sha256', WH_SECRET).update(`${t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected, 'hex'), b = Buffer.from(v1, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },
};
