// Envia um comando para o MATLAB pela linha de comando, gravando direto no banco
// (equivalente ao usuario.py do professor). Serve para testar antes de existir o
// formulário do site, que vem no passo 4.
//
// Uso (dentro de backend/):
//   npm run comando -- enabled 1
//   npm run comando -- setpoint 40
import { addCommand } from '../src/services/commands.js';
import { logEvent } from '../src/services/logger.js';
import { pool } from '../src/db/pool.js';

const [name, value] = process.argv.slice(2);

try {
  const { id } = await addCommand(name, Number(value));
  await logEvent({ eventType: 'command_sent', description: `${name}=${value} (via terminal)` });
  console.log(`Comando #${id} gravado: ${name} = ${value}`);
} catch (err) {
  console.error('Erro:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end(); // fecha a conexão para o script terminar
}
