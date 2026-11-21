// Rotas das leituras da planta.
//
// POST /api/data         -> MATLAB envia um lote de amostras (exige X-Device-Key).
//                           A resposta já traz os comandos atuais, então uma única
//                           requisição por segundo faz as duas coisas.
// GET  /api/data/latest  -> últimas amostras descriptografadas
//                           (TESTE: será protegida por login no passo 4)
import { Router } from 'express';
import { decrypt } from '../services/crypto.js';
import { requireDeviceKey } from '../middleware/deviceKey.js';
import { logEvent } from '../services/logger.js';
import { writeLines, querySql } from '../services/influx.js';
import { validarLote, amostraParaLinha, MEASUREMENT } from '../services/samples.js';
import { getCommandState } from '../services/commands.js';

export const dataRouter = Router();

dataRouter.post('/', requireDeviceKey, async (req, res) => {
  const erro = validarLote(req.body);
  if (erro) {
    await logEvent({ eventType: 'data_invalid', description: erro, ip: req.ip, status: 400 });
    return res.status(400).json({ status: 'error', message: erro });
  }

  const { device_id, samples } = req.body;
  try {
    // Todas as amostras do lote numa única escrita
    await writeLines(samples.map((s) => amostraParaLinha(device_id, s)));
  } catch (err) {
    console.error('[data] erro ao gravar no InfluxDB:', err.message);
    await logEvent({ eventType: 'influx_error', description: err.message, ip: req.ip, status: 503 });
    return res.status(503).json({ status: 'error', message: 'Banco de séries temporais indisponível' });
  }

  await logEvent({
    eventType: 'data_received',
    description: `${device_id}: ${samples.length} amostras`,
    ip: req.ip,
    status: 201,
  });

  res.status(201).json({
    status: 'ok',
    received: samples.length,
    server_time: new Date().toISOString(),
    commands: await getCommandState(), // { enabled, setpoint }
  });
});

// TODO (passo 4): proteger com JWT — dados só podem ser descriptografados para usuários autenticados
dataRouter.get('/latest', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 500); // inteiro 1..500

  let rows;
  try {
    rows = await querySql(`SELECT * FROM ${MEASUREMENT} ORDER BY time DESC LIMIT ${limit}`);
  } catch (err) {
    // Antes da primeira escrita o banco/tabela ainda não existem: devolve lista vazia
    if (/not found|does not exist/i.test(err.message)) return res.json([]);
    throw err;
  }

  res.json(
    rows.map((row) => {
      const out = { time: row.time, device: row.device };
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'time' && k !== 'device' && v != null) out[k] = Number(decrypt(v));
      }
      return out;
    })
  );
});
