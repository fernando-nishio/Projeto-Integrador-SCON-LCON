// Tela LCD do modelo 3D (malha "lcd_screen" do ltr701.glb).
//
// A tela é um <canvas> usado como textura: cada vez que chega um lote da planta,
// o Gemeo3D chama desenhar() com os valores novos e a textura é atualizada.
// Resolução baixa + filtro "nearest" dão o aspecto de pixel de LCD.
import * as THREE from 'three';

const AZUL = '#2834b4'; // fundo do LCD
const PIXEL = '#e8ecff'; // pixels acesos

export class LcdLtr701 {
  constructor(raiz, { largura = 240, altura = 170 } = {}) {
    this.mesh = raiz.getObjectByName('lcd_screen');
    if (!this.mesh) throw new Error('Malha "lcd_screen" não encontrada no ltr701.glb');

    this.W = largura;
    this.H = altura;
    this.canvas = document.createElement('canvas');
    this.canvas.width = largura;
    this.canvas.height = altura;
    this.ctx = this.canvas.getContext('2d');

    this.textura = new THREE.CanvasTexture(this.canvas);
    this.textura.flipY = false; // obrigatório em malhas glTF
    this.textura.colorSpace = THREE.SRGBColorSpace;
    this.textura.magFilter = THREE.NearestFilter;
    this.textura.minFilter = THREE.LinearFilter;
    this.textura.generateMipmaps = false;

    const m = this.mesh.material.clone();
    m.map = this.textura;
    m.emissiveMap = this.textura; // "backlight": a tela não depende da luz da cena
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveIntensity = 0.85;
    m.roughness = 0.9; // tela fosca: sem reflexo da luz da cena em cima do texto
    m.metalness = 0;
    this.mesh.material = m;
  }

  /**
   * @param {object} tela
   * @param {string} tela.titulo       texto à esquerda do cabeçalho
   * @param {string} tela.estado       texto à direita do cabeçalho
   * @param {{rotulo:string, valor:string, unidade:string}[]} tela.linhas
   * @param {string} [tela.rodape]
   */
  desenhar({ titulo, estado, linhas, rodape }) {
    const { ctx, W, H } = this;
    ctx.fillStyle = AZUL;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';

    // cabeçalho invertido
    const hc = 18;
    ctx.fillStyle = PIXEL;
    ctx.fillRect(0, 0, W, hc);
    ctx.fillStyle = AZUL;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(titulo, 5, hc / 2 + 1);
    ctx.textAlign = 'right';
    ctx.fillText(estado, W - 5, hc / 2 + 1);

    // linhas
    ctx.fillStyle = PIXEL;
    const hr = rodape ? 16 : 0;
    const topo = hc + 6;
    const lh = (H - topo - hr - 4) / linhas.length;
    linhas.forEach((l, i) => {
      const y = topo + lh * (i + 0.5);
      ctx.font = '12px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(l.rotulo, 6, y);
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(l.valor, W - 40, y);
      ctx.font = '12px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(l.unidade, W - 36, y);
    });

    if (rodape) {
      ctx.fillRect(4, H - hr - 2, W - 8, 1);
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(rodape, W / 2, H - hr / 2);
    }

    this.textura.needsUpdate = true;
  }

  dispose() {
    this.textura.dispose();
    this.mesh.material.dispose();
  }
}
