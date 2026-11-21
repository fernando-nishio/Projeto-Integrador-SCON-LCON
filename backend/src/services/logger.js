// Grava eventos na tabela logs. A descrição e o IP são criptografados antes de gravar
// (o PDF exige que logs também sejam armazenados cifrados).
// Uma falha ao logar nunca derruba a requisição.
import { pool } from '../db/pool.js';
import { encrypt } from './crypto.js';

export async function logEvent({ eventType, description = null, ip = null, status = null, userId = null }) {
  try {
    await pool.query(
      `INSERT INTO logs (event_type, description, ip, status, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        eventType,
        description == null ? null : encrypt(description),
        ip == null ? null : encrypt(ip),
        status,
        userId,
      ]
    );
  } catch (err) {
    console.error('[log] falha ao gravar log:', err.message);
  }
}
