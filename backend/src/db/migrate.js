// Cria as tabelas do PostgreSQL ao iniciar o backend.
// O schema.sql só usa "CREATE ... IF NOT EXISTS", então rodar de novo não altera nada.
// Assim o banco fica pronto mesmo partindo do zero, sem passo manual.
import fs from 'node:fs/promises';
import { pool } from './pool.js';

export async function aplicarSchema() {
  const sql = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
