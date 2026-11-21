// GET /api/commands -> estado atual dos comandos para o MATLAB (exige X-Device-Key).
// Resposta: { "enabled": 0 ou 1, "setpoint": 35 }
//
// O POST /api/data já devolve esse mesmo estado; esta rota existe separada para o
// dispositivo poder consultar comandos sem enviar dados (e porque a atividade a sugere).
// A rota POST /api/send (site → comando) entra no passo 4, junto com o login.
import { Router } from 'express';
import { requireDeviceKey } from '../middleware/deviceKey.js';
import { getCommandState } from '../services/commands.js';

export const commandsRouter = Router();

commandsRouter.get('/', requireDeviceKey, async (req, res) => {
  res.json(await getCommandState());
});
