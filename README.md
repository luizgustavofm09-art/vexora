# Vexora: Bangers — Multiplayer

## Como jogar com amigos
1. Instale o Node.js 16+ e rode, na pasta com `server.js` e `index.html`:
   `node server.js`  (outra porta: `PORT=8080 node server.js`)
2. O terminal mostra os endereços. Você abre `http://localhost:3000`; amigos na mesma rede abrem `http://SEU-IP:3000`. Pela internet, use um servidor/VPS (ou túnel tipo ngrok) e envie o link.
3. No lobby clique em **👥 MULTIPLAYER** → **Criar sala** (modo, bots 0–24, pública/privada).
4. Passe o **código** (ou o botão *Copiar link*, que abre direto na sala: `/?sala=ABCDE`). Cabem **16 jogadores** (você + 15 amigos).
5. Amigos marcam **Pronto**; o anfitrião clica **Iniciar partida**.

Anfitrião: muda modo/bots/nome, expulsa jogadores, inicia e encerra a partida. Se ele sair, o jogador mais antigo vira anfitrião. Em partida: **Enter** abre o chat; **⬅ SAIR** volta à sala.

## Arquivos
- `server.js` – servidor WebSocket + salas (sem dependências).
- `index.html` – jogo com o cliente multiplayer embutido (`mp.js` é só o código-fonte dessa parte).

## Como funciona
Cada cliente controla o próprio jogador; o anfitrião simula bots e zona e transmite. Tiros/dano: quem atira calcula o acerto e o dono do alvo aplica. Loot, avião, granadas, foguetes, paredes e emotes são replicados. Não é à prova de trapaça (feito para amigos). Sem sala, o jogo offline funciona como antes.

## Novidades
**Mapa ☁️ ILHAS FLUTUANTES** — ilhas no céu ligadas por pontes e tirolesas, com vazio embaixo. Cair no vazio = eliminação, mas ao despencar o paraquedas abre sozinho (dá para planar de volta a uma ilha). Cada ilha tem um bioma (verde, neve, deserto, cristal, outono), casas com loot, torres de sniper e cristais de evento. Bots atravessam as pontes; a zona do Battle Royale sempre fecha sobre ilhas.
No lobby, o botão **MAPA** alterna entre *Aleatório*, *Arquipélago Vexora* e *Ilhas Flutuantes* (no multiplayer vale a escolha do anfitrião).

**6 novos pets** (tecla V): ☁️ Nimbus (salto + planeio), 🐺 Fenrir (+25% dano), 🐧 Gelinho (-40% dano recebido), 🐢 Casquinho (barreira), 🔥 Fênix (regeneração), 🐱 Mochi (recarga instantânea). Desbloqueio pelo Passe: Mochi nv.3 e Casquinho nv.14 e Gelinho nv.18 (grátis); Nimbus nv.3, Fenrir nv.12 e Fênix nv.18 (premium).
