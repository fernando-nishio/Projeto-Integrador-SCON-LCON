// Prepara a configuração do projeto. Roda sozinho a cada "docker compose up"
// (serviço "setup"), mas também pode ser rodado fora do Docker: npm run setup
//
// 1. Cria o .env da raiz a partir do .env.example (ou completa o .env existente):
//    onde houver "troque_..." / "cole_aqui..." / vazio, gera um valor aleatório.
//    Valores que você já definiu NUNCA são trocados.
// 2. Dentro do Docker (CONFIG_DIR definido), copia a configuração para o volume
//    "config", de onde os outros containers leem:
//      app.env                   -> .env do backend
//      db_password               -> senha inicial do Postgres
//      influx-admin-token.json   -> token de admin inicial do InfluxDB
//
// Nenhum segredo é impresso na tela.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = process.env.REPO_DIR ?? path.resolve(import.meta.dirname, '..', '..');
const CONFIG = process.env.CONFIG_DIR; // só existe dentro do Docker
const ENV = path.join(REPO, '.env');
const EXAMPLE = path.join(REPO, '.env.example');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const GERADORES = {
  DB_PASSWORD: () => hex(16),
  ENCRYPTION_KEY: () => hex(32), // 32 bytes = AES-256
  DEVICE_KEY: () => hex(16),
  JWT_SECRET: () => hex(48),
  // O InfluxDB exige o prefixo "apiv3_" e ao menos 16 bytes aleatórios
  INFLUX_TOKEN: () => 'apiv3_' + crypto.randomBytes(32).toString('base64url'),
};
const PLACEHOLDER = /^(|troque_.*|cole_aqui.*)$/;

// Lê um arquivo KEY=VALOR (ignora comentários e linhas vazias)
function lerEnv(arquivo) {
  const valores = new Map();
  if (!fs.existsSync(arquivo)) return valores;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) valores.set(m[1], m[2].trim());
  }
  return valores;
}

// ---------- 1. Monta o .env seguindo a ordem/comentários do .env.example ----------
if (!fs.existsSync(EXAMPLE)) {
  console.error(`[setup] não encontrei ${EXAMPLE}`);
  process.exit(1);
}
const atual = lerEnv(ENV);
const linhas = [];
const usadas = new Set();
const gerados = [];

for (const linha of fs.readFileSync(EXAMPLE, 'utf8').split('\n')) {
  const m = linha.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) { linhas.push(linha); continue; }           // comentário ou linha vazia
  const [, chave, padrao] = m;
  usadas.add(chave);
  let valor = atual.has(chave) ? atual.get(chave) : padrao;
  if (chave in GERADORES && PLACEHOLDER.test(valor)) {
    valor = GERADORES[chave]();
    gerados.push(chave);
  }
  linhas.push(`${chave}=${valor}`);
}

// Variáveis que você tenha acrescentado ao .env e que não estão no modelo são mantidas
const extras = [...atual].filter(([k]) => !usadas.has(k));
if (extras.length) linhas.push('', '# Outras variáveis', ...extras.map(([k, v]) => `${k}=${v}`));

const conteudo = linhas.join('\n').replace(/\n*$/, '\n');
const anterior = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : null;

if (conteudo !== anterior) {
  fs.writeFileSync(ENV, conteudo, { mode: 0o600 });
  fs.chmodSync(ENV, 0o600); // só o dono lê/escreve
  // Rodando como root no Docker: devolve o arquivo ao dono da pasta do projeto
  if (process.getuid?.() === 0) {
    const { uid, gid } = fs.statSync(REPO);
    fs.chownSync(ENV, uid, gid);
  }
  console.log(anterior === null ? '[setup] .env criado' : '[setup] .env atualizado');
  if (gerados.length) console.log(`[setup] valores gerados: ${gerados.join(', ')}`);
} else {
  console.log('[setup] .env já estava completo');
}

// ---------- 2. Arquivos para os containers ----------
if (CONFIG) {
  const env = lerEnv(ENV);
  fs.mkdirSync(CONFIG, { recursive: true });
  // 0644: legíveis pelos usuários internos do Postgres/InfluxDB/backend.
  // O volume fica em /var/lib/docker, acessível só ao root do computador.
  fs.writeFileSync(path.join(CONFIG, 'app.env'), conteudo, { mode: 0o644 });
  fs.writeFileSync(path.join(CONFIG, 'db_password'), env.get('DB_PASSWORD'), { mode: 0o644 });
  fs.writeFileSync(
    path.join(CONFIG, 'influx-admin-token.json'),
    JSON.stringify({ token: env.get('INFLUX_TOKEN'), name: '_admin', description: 'Token do backend (gerado pelo setup)' }),
    { mode: 0o644 }
  );
  console.log('[setup] configuração copiada para o volume dos containers');
}
