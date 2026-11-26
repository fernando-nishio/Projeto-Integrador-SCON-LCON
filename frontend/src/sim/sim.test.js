// Testes do modelo e da identificação:  npm test   (node --test, sem dependências)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMETROS_PADRAO, simular, metricasDegrau, lerDegraus } from './modelo.js';
import { identificar, lerCSV } from './identificar.js';

const P = { ...PARAMETROS_PADRAO };
const perto = (a, b, tolRel, msg) =>
  assert.ok(Math.abs(a - b) <= Math.abs(b) * tolRel, `${msg}: ${a.toFixed(4)} ≉ ${b} (±${tolRel * 100}%)`);

test('malha aberta sem ruído: regime = T_amb + K·u', () => {
  const r = simular({ ...P, ruido: 0 }, { duracao: 60, malha: 'aberta', degraus: [{ t: 0, v: 4 }] });
  const fim = r[r.length - 1];
  assert.ok(Math.abs(fim.Treal - (P.Tamb + P.K * 4)) < 0.01, `T final ${fim.Treal}`);
  // em t = τ chega a 63,2% do degrau
  const emTau = r.find((s) => s.t >= P.tau - 1e-9);
  perto(emTau.Treal - P.Tamb, 0.632 * P.K * 4, 0.01, 'resposta em t = τ');
});

test('atraso θ desloca a resposta', () => {
  const r = simular({ ...P, ruido: 0, theta: 2 }, { duracao: 10, malha: 'aberta', degraus: [{ t: 0, v: 4 }] });
  assert.ok(r.find((s) => s.t >= 1.9).Treal - P.Tamb < 1e-9, 'antes de θ não pode ter subido');
  assert.ok(r.find((s) => s.t >= 2.5).Treal - P.Tamb > 0.1, 'depois de θ precisa subir');
});

test('malha fechada: PI leva a temperatura ao setpoint', () => {
  const r = simular(P, { duracao: 120, degraus: lerDegraus('0:40, 60:50') });
  const m = metricasDegrau(r, 60, { Umax: P.Umax });
  assert.ok(Math.abs(m.erroRegime) < 0.3, `erro em regime ${m.erroRegime}`);
  assert.ok(m.uMax <= P.Umax + 1e-9);
  assert.equal(r[0].u, 0); // primeiros passos sem controle
});

test('identificação em malha aberta recupera K, τ, θ e T_amb', () => {
  const real = { ...P, K: 4, tau: 12, theta: 1, Tamb: 24 };
  const r = simular(real, {
    duracao: 150, malha: 'aberta', degraus: lerDegraus('0:0, 5:6, 70:3, 110:8'), semente: 7,
  });
  const id = identificar(r);
  perto(id.K, 4, 0.05, 'K');
  perto(id.tau, 12, 0.08, 'τ');
  assert.ok(Math.abs(id.theta - 1) <= 0.2, `θ ${id.theta}`);
  assert.ok(Math.abs(id.Tamb - 24) < 0.5, `T_amb ${id.Tamb}`);
  assert.ok(id.ajuste > 95, `ajuste ${id.ajuste}`);
});

test('identificação com dados de malha fechada (como o banco guarda)', () => {
  const real = { ...P, K: 4, tau: 12, theta: 0.5, Tamb: 24 };
  const r = simular(real, { duracao: 200, degraus: lerDegraus('0:35, 70:50, 140:40'), semente: 3 });
  const id = identificar(r);
  perto(id.K, 4, 0.15, 'K');
  perto(id.tau, 12, 0.2, 'τ');
});

test('identificação recusa dados sem variação de u', () => {
  const r = simular(P, { duracao: 30, malha: 'aberta', degraus: [{ t: 0, v: 0 }] });
  assert.throws(() => identificar(r), /quase não variou/);
});

test('CSV com ; e vírgula decimal, tempo em ms', () => {
  const d = lerCSV('tempo;temp;u\n1700000000000;25,1;0\n1700000000100;25,3;2,5\n');
  assert.deepEqual(d.map((s) => s.t), [0, 0.1]);
  assert.equal(d[1].temp, 25.3);
  assert.equal(d[1].u, 2.5);
});

test('degraus inválidos geram erro claro', () => {
  assert.throws(() => lerDegraus('abc'), /Degrau inválido/);
  assert.throws(() => lerDegraus(''), /pelo menos um degrau/);
});

test('modelo da Ativ. 07: PI do script estável sem atraso, oscila com a partida a frio', async () => {
  const { ATRASO_PARTIDA_FRIO } = await import('./modelo.js');
  const oscilacao = (theta) => {
    const r = simular({ ...P, theta, ruido: 0 }, { duracao: 200, degraus: lerDegraus('0:40, 100:50') });
    const fim = r.filter((s) => s.t > 170).map((s) => s.Treal);
    return Math.max(...fim) - Math.min(...fim);
  };
  assert.ok(oscilacao(0) < 0.05, 'sem atraso deve acomodar');
  assert.ok(oscilacao(ATRASO_PARTIDA_FRIO) > 1, 'com 2,2 s de atraso o PI (Kp 1,1, Ki 0,4) oscila');
});
