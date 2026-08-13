/* Teste do gerador de QR.
   Etiqueta impressa não se troca depois — então o QR é conferido contra
   uma implementação de referência (byte a byte) E decodificado de verdade
   a partir do bitmap, em todas as versões que a etiqueta pode usar.

   Rodar:  npm install && npm test
*/
import { gerarMatriz, _interno } from "../qr.js";
import jsQRmod from "jsqr";
import QRCode from "qrcode";
const jsQR = jsQRmod.default || jsQRmod;

const casos = [
  "https://almoxarifado.ryze.workers.dev/e/CIM-001",   // etiqueta de material
  "https://almoxarifado.ryze.workers.dev/e/PAT-0001",  // etiqueta de ferramenta
  "CIM-001",
  "x".repeat(14),   // v1 no limite
  "y".repeat(26),   // v2
  "z".repeat(42),   // v3
  "a".repeat(62),   // v4
  "b".repeat(84),   // v5
  "c".repeat(106),  // v6
  "d".repeat(122),  // v7 — entra a informação de versão
  "e".repeat(152),  // v8
  "f".repeat(180),  // v9
  "g".repeat(213),  // v10 — contagem de 16 bits
  "Construtora Modelo · CIM-001 · Cimento CP-II 50kg · Rua A Pilha 1",
];

let falhas = 0;

// 1. vetor canônico da especificação para a correção de erro
const eccEsperado = "a5 24 d4 c1 ed 36 c7 87 2c 55";
const eccObtido = _interno
  .corrigirErro([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], 10)
  .map(v => v.toString(16).padStart(2, "0")).join(" ");
if (eccObtido !== eccEsperado) { falhas++; console.log(`ECC do vetor canônico: esperado ${eccEsperado}, veio ${eccObtido}`); }
else console.log("ecc  vetor canônico da especificação ....... ok");

// 2. cada caso: idêntico à referência e legível por um decodificador
for (const texto of casos) {
  const m = gerarMatriz(texto);
  const n = m.length;
  const versao = (n - 17) / 4;

  const ref = QRCode.create([{ data: texto, mode: "byte" }], { errorCorrectionLevel: "M" });
  let igual = ref.modules.size === n;
  if (igual) {
    for (let i = 0; i < n && igual; i++) {
      for (let j = 0; j < n; j++) {
        if ((ref.modules.data[i * n + j] ? 1 : 0) !== m[i][j]) { igual = false; break; }
      }
    }
  }

  const esc = 4, mar = 4 * esc, lado = n * esc + mar * 2;
  const buf = new Uint8ClampedArray(lado * lado * 4).fill(255);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!m[i][j]) continue;
      for (let dy = 0; dy < esc; dy++) {
        for (let dx = 0; dx < esc; dx++) {
          const p = ((mar + i * esc + dy) * lado + (mar + j * esc + dx)) * 4;
          buf[p] = buf[p + 1] = buf[p + 2] = 0;
        }
      }
    }
  }
  const lido = jsQR(buf, lado, lado);
  const decodificou = lido && lido.data === texto;

  if (!igual || !decodificou) falhas++;
  console.log(
    `v${String(versao).padStart(2)}  ${igual ? "igual à referência" : "DIFERE DA REFERÊNCIA"}  ` +
    `${decodificou ? "decodifica" : "NÃO DECODIFICA"}  ${texto.slice(0, 30)}`
  );
}

console.log(falhas === 0 ? "\ntudo certo" : `\n${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
