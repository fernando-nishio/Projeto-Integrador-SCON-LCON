// Ponto de entrada do backend.
// Rodar fora do Docker (dentro de backend/):  npm run dev
import express from 'express';
import { pool } from './db/pool.js';
import { aplicarSchema } from './db/migrate.js';
import { influxHealthy } from './services/influx.js';
import { requestLogger } from './middleware/requestLogger.js';
import { dataRouter } from './routes/data.js';
import { commandsRouter } from './routes/commands.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Fora do Docker: só localhost (o MATLAB roda no mesmo computador).
// No Docker, HOST=0.0.0.0 (definido no docker-compose.yml), senão o container
// não aceitaria as conexões que chegam pela porta publicada.
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '200kb' })); // um lote de 1 s a 100 Hz cabe com folga
app.use(requestLogger);

// Verificação rápida de que o servidor e os dois bancos estão no ar
app.get('/api/health', async (req, res) => {
  const postgres = await pool.query('SELECT 1').then(() => 'ok', () => 'indisponível');
  const influxdb = (await influxHealthy()) ? 'ok' : 'indisponível';
  const ok = postgres === 'ok' && influxdb === 'ok';
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error', postgres, influxdb, time: new Date().toISOString() });
});

app.use('/api/data', dataRouter);
app.use('/api/commands', commandsRouter);

// Rota inexistente
app.use((req, res) => res.status(404).json({ status: 'error', message: 'Rota não encontrada' }));

// Erros não tratados (inclui JSON malformado no corpo)
app.use((err, req, res, next) => {
  console.error('[erro]', err.message);
  res.status(err.status || 500).json({ status: 'error', message: err.expose ? err.message : 'Erro interno' });
});

// Garante as tabelas antes de aceitar requisições
try {
  await aplicarSchema();
} catch (err) {
  console.error('[inicio] não foi possível preparar o PostgreSQL:', err.message);
  console.error('         Os bancos estão no ar? (docker compose up -d)');
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  console.log(`Backend rodando em http://localhost:${PORT}`);
});
