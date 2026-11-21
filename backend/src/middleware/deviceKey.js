// Valida a origem das requisições do ESP32: ele precisa mandar a chave no header X-Device-Key.
// timingSafeEqual compara em tempo constante, evitando ataques que medem o tempo da comparação.
import crypto from 'node:crypto';

export function requireDeviceKey(req, res, next) {
  const expected = Buffer.from(process.env.DEVICE_KEY ?? '');
  const received = Buffer.from(req.get('X-Device-Key') ?? '');

  const ok =
    expected.length > 0 &&
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);

  if (!ok) {
    return res.status(401).json({ status: 'error', message: 'Chave do dispositivo ausente ou inválida' });
  }
  next();
}
