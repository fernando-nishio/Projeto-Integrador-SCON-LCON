// Gêmeo digital 3D do kit LTR701 (three.js).
//
// Carrega /ltr701.glb (frontend/public) e espelha no modelo o que a planta real está
// fazendo, a cada lote que chega pelo /api/stream:
//   - LCD do modelo: temperatura, setpoint, erro, sinal de controle e estado do PI;
//   - tubo do aquecedor: muda de cor com a temperatura;
//   - LED "ON": aceso enquanto chegam dados da planta.
//
// Recebe as mesmas informações que os tiles do Dashboard (última amostra, comandos e
// se há dados recentes), então não abre nenhuma conexão própria.
//
// Na aba Simulação (simulacao = true) mostra a amostra simulada do instante escolhido
// na linha do tempo: o LCD indica "SIMULACAO" e o rodapé mostra o tempo do ensaio.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LcdLtr701 } from '../gemeo/lcdLtr701.js';

const URL_MODELO = `${import.meta.env.BASE_URL}ltr701.glb`;
const T_FRIO = 25; // °C: tubo sem cor
const T_QUENTE = 80; // °C: tubo no vermelho máximo

const num = (v, casas) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(casas) : '--.-');
const hora = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour12: false });

function montarTela(amostra, online, { simulacao, rodape } = {}) {
  const a = online ? amostra : null;
  let estado = !online ? 'SEM SINAL' : a?.enabled === 1 ? 'PI  ON' : 'PI OFF';
  if (simulacao && online) estado = a?.enabled === 1 ? 'PI  ON' : 'M.ABERTA';
  return {
    titulo: simulacao ? 'SIMULACAO' : 'LTR 701',
    estado,
    linhas: [
      { rotulo: 'Temp.', valor: num(a?.temp, 2), unidade: '°C' },
      { rotulo: 'Setpoint', valor: num(a?.setpoint, 1), unidade: '°C' },
      { rotulo: 'Erro', valor: num(a?.erro, 2), unidade: '°C' },
      { rotulo: 'Aquec. u', valor: num(a?.u, 2), unidade: 'V' },
    ],
    rodape: rodape ?? (amostra ? `ultima amostra ${hora(amostra.t)}` : 'aguardando dados'),
  };
}

export default function Gemeo3D({ amostra, online, altura = 340, simulacao = false, rodape }) {
  const caixa = useRef(null);
  const cena = useRef(null); // { lcd, tubo, led, ledCor }
  const ultimo = useRef({ amostra, online, opcoes: { simulacao, rodape } });
  const [erro, setErro] = useState(null);
  const [focoLcd, setFocoLcd] = useState(false);
  const vista = useRef(null); // { camera, controls, alvo: {pos, target} | null, kit, lcd }

  ultimo.current = { amostra, online, opcoes: { simulacao, rodape } };

  // Cria a cena uma vez
  useEffect(() => {
    const el = caixa.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 20);
    const VISTA_KIT = { pos: new THREE.Vector3(0.05, 0.55, 1.0), target: new THREE.Vector3(0, 0.25, 0) };
    camera.position.copy(VISTA_KIT.pos);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(VISTA_KIT.target);
    vista.current = { camera, controls, alvo: null, kit: VISTA_KIT, lcd: null };
    controls.enableDamping = true;
    controls.minDistance = 0.3;
    controls.maxDistance = 2.5;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // não passa por baixo da bancada

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.4));
    const sol = new THREE.DirectionalLight(0xffffff, 2.2);
    sol.position.set(0.6, 1.5, 1.2);
    scene.add(sol);

    let vivo = true;
    new GLTFLoader().load(
      URL_MODELO,
      (gltf) => {
        if (!vivo) return;
        scene.add(gltf.scene);
        const tubo = gltf.scene.getObjectByName('heater_tube_body');
        const led = gltf.scene.getObjectByName('led_on');
        tubo.material = tubo.material.clone();
        led.material = led.material.clone();
        cena.current = { lcd: new LcdLtr701(gltf.scene), tubo, led, ledCor: led.material.emissive.clone() };

        // vista de perto do LCD: centro da tela + afastado na direção da normal do painel
        gltf.scene.updateMatrixWorld(true);
        const tela = gltf.scene.getObjectByName('lcd_screen');
        const centro = new THREE.Box3().setFromObject(tela).getCenter(new THREE.Vector3());
        const normal = new THREE.Vector3(0, 0, 1).transformDirection(tela.matrixWorld);
        vista.current.lcd = { pos: centro.clone().addScaledVector(normal, 0.24), target: centro };
        const u = ultimo.current;
        atualizar(cena.current, u.amostra, u.online, u.opcoes);
      },
      undefined,
      () => vivo && setErro('Não foi possível carregar o modelo 3D (ltr701.glb).'),
    );

    const redimensionar = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // em telas estreitas (celular), afasta a câmera para caber a bancada inteira
      camera.zoom = Math.min(1, camera.aspect / 2.0);
      camera.updateProjectionMatrix();
    };
    const obs = new ResizeObserver(redimensionar);
    obs.observe(el);
    redimensionar();

    renderer.setAnimationLoop(() => {
      // transição suave entre a vista do kit e a do LCD
      const v = vista.current;
      if (v.alvo) {
        camera.position.lerp(v.alvo.pos, 0.12);
        controls.target.lerp(v.alvo.target, 0.12);
        if (camera.position.distanceTo(v.alvo.pos) < 1e-3) v.alvo = null;
      }
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      vivo = false;
      renderer.setAnimationLoop(null);
      obs.disconnect();
      controls.dispose();
      cena.current?.lcd.dispose();
      cena.current = null;
      scene.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          for (const m of [].concat(o.material)) {
            m.map?.dispose();
            m.dispose();
          }
        }
      });
      renderer.dispose();
      renderer.forceContextLoss(); // libera o contexto WebGL na hora (o navegador limita ~16)
      renderer.domElement.remove();
    };
  }, []);

  // A cada amostra nova (ou mudança de conexão), atualiza o modelo
  useEffect(() => {
    if (cena.current) atualizar(cena.current, amostra, online, { simulacao, rodape });
  }, [amostra, online, simulacao, rodape]);

  return (
    <div className="gemeo3d" style={{ height: altura }}>
      <div ref={caixa} className="gemeo3d-canvas" />
      <button
        className="btn secundario gemeo3d-botao"
        onClick={() => {
          const v = vista.current;
          const proximo = !focoLcd;
          if (proximo && !v?.lcd) return; // modelo ainda carregando
          v.alvo = proximo ? v.lcd : v.kit;
          setFocoLcd(proximo);
        }}
      >
        {focoLcd ? 'Ver o kit' : 'Ver o LCD'}
      </button>
      {erro && <p className="msg erro">{erro}</p>}
    </div>
  );
}

function atualizar({ lcd, tubo, led, ledCor }, amostra, online, opcoes) {
  lcd.desenhar(montarTela(amostra, online, opcoes));

  const t = online && typeof amostra?.temp === 'number' ? amostra.temp : T_FRIO;
  const k = THREE.MathUtils.clamp((t - T_FRIO) / (T_QUENTE - T_FRIO), 0, 1);
  tubo.material.emissive.setRGB(0.6 * k, 0.12 * k, 0);

  led.material.emissive.copy(online ? ledCor : new THREE.Color(0));
}
