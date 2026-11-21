// Registra TODA requisição na tabela logs (timestamp, IP, método, rota, status, duração).
// Atende ao requisito "cada requisição deve ser registrada em log, com timestamp, IP e status".
import { logEvent } from '../services/logger.js';

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  // 'finish' dispara depois que a resposta foi enviada, quando o status já é conhecido
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const description = `${req.method} ${req.originalUrl} (${ms.toFixed(1)} ms)`;
    console.log(`[${res.statusCode}] ${description} de ${req.ip}`);
    logEvent({
      eventType: res.statusCode >= 400 ? 'http_error' : 'http_request',
      description,
      ip: req.ip,
      status: res.statusCode,
      userId: req.user?.id ?? null, // preenchido depois, quando houver login (JWT)
    });
  });

  next();
}
