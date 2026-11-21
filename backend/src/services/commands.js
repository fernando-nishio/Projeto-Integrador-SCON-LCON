// Comandos do site para o MATLAB. Conforme o PDF de LCON-I, o MATLAB recebe apenas:
//   enabled  -> 1 liga o controle; 0 desliga e zera a parcela integral
//   setpoint -> temperatura desejada em °C
// (os ganhos Kp e Ki NÃO são enviados ao MATLAB; ficam no próprio script)
import { pool } from '../db/pool.js';
import { encrypt, decrypt } from './crypto.js';

const DEFAULTS = { enabled: 0, setpoint: 25 }; // estado inicial seguro: controle desligado

// Regras de cada comando: devolve mensagem de erro ou null
const REGRAS = {
  enabled: (v) => (v === 0 || v === 1 ? null : 'enabled deve ser 0 ou 1'),
  setpoint: (v) => (v > 0 && v < 100 ? null : 'setpoint deve estar entre 0 e 100 °C'),
};

export function validarComando(name, value) {
  if (!(name in REGRAS)) return `comando desconhecido "${name}" (use: ${Object.keys(REGRAS).join(', ')})`;
  if (!Number.isFinite(value)) return 'o valor precisa ser um número';
  return REGRAS[name](value);
}

export async function addCommand(name, value, userId = null) {
  const erro = validarComando(name, value);
  if (erro) throw new Error(erro);
  const { rows } = await pool.query(
    `INSERT INTO commands (command_name, value, user_id) VALUES ($1, $2, $3)
     RETURNING id, timestamp`,
    [name, encrypt(value), userId]
  );
  return rows[0];
}

// Estado atual = último valor de cada comando. O MATLAB recebe o estado completo
// a cada consulta (e não só "o que mudou"), então se um pacote se perder, o
// próximo já corrige.
export async function getCommandState() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (command_name) command_name, value
       FROM commands
      WHERE command_name = ANY($1)
      ORDER BY command_name, id DESC`,
    [Object.keys(DEFAULTS)]
  );
  const state = { ...DEFAULTS };
  for (const r of rows) state[r.command_name] = Number(decrypt(r.value));

  // Os comandos pendentes acabaram de ser entregues ao dispositivo
  await pool.query(`UPDATE commands SET status = 'delivered' WHERE status = 'pending'`);
  return state;
}
