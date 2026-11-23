#!/usr/bin/env python3
"""
Simulador da planta + MATLAB, para testar o backend sem o kit nem o MATLAB.

Faz exatamente o que o script MATLAB (firmware/matlab/cliente_planta.m) faz:
  - laço de controle PI a 100 Hz (Ts = 0,01 s);
  - guarda 1 amostra a cada DECIMACAO passos (padrão: 10 Hz);
  - a cada 1 s envia o lote para POST /api/data e lê, na própria resposta,
    os comandos { enabled, setpoint };
  - enabled = 0 -> controle desligado, integral zerada, aquecedor em 0 V.

Planta: dT/dt = -0,4 (T - T_amb) + 2 u, ou seja, G(s) = 2/(s + 0,4) como no
script do professor, com a temperatura ambiente como ponto de equilíbrio.
Troque pelos parâmetros do kit do seu grupo (obtidos em LCON-I).

Ao apertar Ctrl+C mostra: lotes enviados, perda (%) e RTT médio/mín/máx.

Uso (com o backend rodando):   python3 simulacao/planta_simulada.py
Só usa a biblioteca padrão do Python.
"""

import json
import os
import random
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER = os.environ.get("SERVER", "http://localhost:3000/api")
DEVICE_ID = os.environ.get("DEVICE_ID", "LTR701_SIM")

TS = 0.01            # período de amostragem do controle (100 Hz)
DECIMACAO = 10       # guarda 1 a cada 10 amostras -> 10 Hz no banco
PERIODO_ENVIO = 1.0  # envia um lote por segundo

# Planta (troque pelos valores do seu kit) e controlador PI
T_AMB = 25.0
A, B = 0.4, 2.0      # dT/dt = -A (T - T_AMB) + B u
KP, KI = 0.8, 0.3
U_MAX = 10.0


def ler_device_key():
    if os.environ.get("DEVICE_KEY"):
        return os.environ["DEVICE_KEY"]
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for linha in env.read_text().splitlines():
            if linha.startswith("DEVICE_KEY="):
                return linha.split("=", 1)[1].strip()
    raise SystemExit("DEVICE_KEY não encontrada (nem no ambiente, nem no .env da raiz do repositório)")


DEVICE_KEY = ler_device_key()


def post_lote(amostras):
    """Envia o lote. Devolve (status, resposta, rtt_ms)."""
    corpo = json.dumps({"device_id": DEVICE_ID, "samples": amostras}).encode()
    req = urllib.request.Request(
        f"{SERVER}/data", data=corpo, method="POST",
        headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=2) as r:
            status, texto = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, texto = e.code, e.read().decode()
    rtt = (time.perf_counter() - t0) * 1000
    try:
        return status, json.loads(texto), rtt
    except json.JSONDecodeError:
        return status, texto, rtt


# Estado
temp = T_AMB          # temperatura "real" da planta
temp_f = T_AMB        # temperatura filtrada (o que o controle enxerga)
integral = 0.0
enabled, setpoint = 0, 25.0   # até o site mandar outra coisa, controle desligado

buffer = []
lotes = falhas = 0
rtts = []
k = 0
print(f"Simulando {DEVICE_ID} -> {SERVER}  (Ctrl+C para parar)")
print("Controle começa DESLIGADO. Ligue com:  docker compose exec backend /backend comando enabled 1\n")

inicio = time.perf_counter()
proximo_envio = inicio + PERIODO_ENVIO

try:
    while True:
        # 1. Sensor (com ruído) + filtro passa-baixa de 1ª ordem
        leitura = temp + random.gauss(0, 0.15)
        temp_f = 0.1 * leitura + 0.9 * temp_f

        # 2. Controle PI (ou desligado)
        erro = setpoint - temp_f
        if enabled:
            integral += KI * erro * TS
            u = min(max(KP * erro + integral, 0.0), U_MAX)
        else:
            integral = 0.0   # PDF de LCON-I: flag 0 reinicializa o controlador
            u = 0.0

        # 3. Planta avança um passo (Euler)
        temp += TS * (-A * (temp - T_AMB) + B * u)

        # 4. Guarda a amostra (decimada) com o instante em ms (UTC)
        if k % DECIMACAO == 0:
            buffer.append({
                "t": time.time() * 1000,
                "temp": round(temp_f, 3), "setpoint": setpoint,
                "erro": round(erro, 3), "u": round(u, 3), "enabled": enabled,
            })
        k += 1

        # 5. Uma vez por segundo: envia o lote e recebe os comandos
        agora = time.perf_counter()
        if agora >= proximo_envio:
            proximo_envio += PERIODO_ENVIO
            lotes += 1
            try:
                status, resp, rtt = post_lote(buffer)
                if status == 201:
                    rtts.append(rtt)
                    enabled = int(resp["commands"]["enabled"])
                    setpoint = float(resp["commands"]["setpoint"])
                    print(f"[201] {len(buffer):3d} amostras  T={temp_f:6.2f} °C  SP={setpoint:5.1f}  "
                          f"u={u:5.2f} V  {'ON ' if enabled else 'OFF'}  RTT={rtt:6.1f} ms")
                else:
                    falhas += 1
                    print(f"[{status}] {resp}")
            except (urllib.error.URLError, TimeoutError) as e:
                falhas += 1
                print(f"[falhou] servidor inacessível: {e}")
            buffer = []   # lote enviado (ou perdido): começa outro

        # 6. Espera até o próximo passo de 10 ms
        espera = inicio + k * TS - time.perf_counter()
        if espera > 0:
            time.sleep(espera)
except KeyboardInterrupt:
    print("\n--- Resumo ---")
    print(f"Lotes enviados: {lotes}   falhas: {falhas}   perda: {100 * falhas / max(lotes, 1):.1f}%")
    if rtts:
        print(f"RTT médio: {sum(rtts) / len(rtts):.1f} ms   mín: {min(rtts):.1f} ms   máx: {max(rtts):.1f} ms")
