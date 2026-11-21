// Criptografia simétrica AES-256-GCM para os valores guardados no banco.
// GCM, além de esconder o valor, detecta adulteração (auth tag): se alguém alterar
// o texto cifrado no banco, a descriptografia falha em vez de devolver lixo.
//
// Formato armazenado: "iv:authTag:cifrado", cada parte em base64.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // tamanho recomendado de IV para GCM

function getKey() {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY inválida no .env: precisa ter 64 caracteres hexadecimais (32 bytes). ' +
      "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, 'hex');
}

const KEY = getKey(); // falha logo ao iniciar o servidor se a chave estiver errada

export function encrypt(plainText) {
  const iv = crypto.randomBytes(IV_BYTES); // IV novo a cada valor
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join(':');
}

export function decrypt(stored) {
  const [iv, tag, encrypted] = stored.split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
