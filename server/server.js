// Servidor de multiplayer online — Xadrez do Formigueiro
//
// O que este servidor faz:
//  - Cria salas de partida (2 jogadores por sala) identificadas por um código curto
//  - Atribui cor (Marfim / Ônix) a cada jogador que entra
//  - Retransmite jogadas de um jogador para o outro, validando que é a vez dele
//  - Lida com desconexão/reconexão (dá 60s de tolerância antes de encerrar a partida)
//
// O que ele NÃO faz (de propósito):
//  - Não reimplementa as regras completas do seu xadrez de formigas (metamorfose, etc).
//    A validação de "jogada legal segundo as regras do jogo" continua no cliente.
//    O servidor só garante que ninguém joga fora da sua vez e retransmite o lance.
//    Se quiser blindar contra jogador malicioso, veja o hook isMoveLegal() abaixo.

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("Xadrez do Formigueiro — servidor multiplayer ativo"));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // em produção, troque "*" pela URL do seu jogo (ex: https://xadrez-formigueiro.onrender.com)
});

const PORT = process.env.PORT || 3001;
const RECONNECT_GRACE_MS = 60_000;

/** @type {Map<string, Room>} */
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem caracteres ambíguos
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {{socketId: string, token: string, color: string, connected: boolean, disconnectTimer: NodeJS.Timeout|null}[]} */
    this.players = [];
    this.turn = "marfim"; // cor que joga primeiro — ajuste se seu jogo definir diferente
    this.moveHistory = [];
    this.createdAt = Date.now();
  }

  opponentOf(socketId) {
    return this.players.find((p) => p.socketId !== socketId);
  }

  playerBySocket(socketId) {
    return this.players.find((p) => p.socketId === socketId);
  }
}

// Hook opcional: plugue aqui a validação real das regras do jogo (movimento, metamorfose etc.)
// Retorne true/false. Se não implementar, o servidor confia no cliente (bom o suficiente pra jogar com amigos).
function isMoveLegal(_room, _moveData) {
  return true;
}

function cleanupRoomIfEmpty(room) {
  const anyoneConnected = room.players.some((p) => p.connected);
  if (!anyoneConnected) rooms.delete(room.code);
}

io.on("connection", (socket) => {
  // Cria uma sala nova. O criador vira a cor "marfim" por padrão.
  socket.on("create_room", (_payload, callback) => {
    const code = generateRoomCode();
    const room = new Room(code);
    const token = cryptoRandomToken();
    room.players.push({ socketId: socket.id, token, color: "marfim", connected: true, disconnectTimer: null });
    rooms.set(code, room);
    socket.join(code);
    callback?.({ ok: true, roomCode: code, color: "marfim", token });
  });

  // Entra numa sala existente pelo código.
  socket.on("join_room", ({ roomCode }, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback?.({ ok: false, error: "Sala não encontrada." });
    if (room.players.length >= 2) return callback?.({ ok: false, error: "Sala cheia." });

    const token = cryptoRandomToken();
    const color = room.players[0].color === "marfim" ? "onix" : "marfim";
    room.players.push({ socketId: socket.id, token, color, connected: true, disconnectTimer: null });
    socket.join(roomCode);

    callback?.({ ok: true, roomCode, color, token });
    socket.to(roomCode).emit("opponent_joined", { color });
  });

  // Reconecta a uma sala após queda de conexão, usando o token recebido no join/create.
  socket.on("rejoin_room", ({ roomCode, token }, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback?.({ ok: false, error: "Sala não existe mais." });
    const player = room.players.find((p) => p.token === token);
    if (!player) return callback?.({ ok: false, error: "Jogador não reconhecido nesta sala." });

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(roomCode);

    callback?.({
      ok: true,
      color: player.color,
      turn: room.turn,
      moveHistory: room.moveHistory,
    });
    socket.to(roomCode).emit("opponent_reconnected");
  });

  // Recebe uma jogada, valida a vez, atualiza o estado e retransmite pro adversário.
  socket.on("move", ({ roomCode, moveData }, callback) => {
    const room = rooms.get(roomCode);
    if (!room) return callback?.({ ok: false, error: "Sala não encontrada." });

    const player = room.playerBySocket(socket.id);
    if (!player) return callback?.({ ok: false, error: "Você não está nesta sala." });
    if (player.color !== room.turn) return callback?.({ ok: false, error: "Não é a sua vez." });
    if (!isMoveLegal(room, moveData)) return callback?.({ ok: false, error: "Jogada inválida." });

    room.moveHistory.push(moveData);
    room.turn = room.turn === "marfim" ? "onix" : "marfim";

    callback?.({ ok: true });
    socket.to(roomCode).emit("opponent_move", moveData);
  });

  // Fim de jogo (xeque-mate, desistência etc.) — repasse o motivo para sincronizar a tela dos dois.
  socket.on("game_over", ({ roomCode, reason, winnerColor }) => {
    socket.to(roomCode).emit("game_over", { reason, winnerColor });
  });

  socket.on("resign", ({ roomCode }) => {
    const room = rooms.get(roomCode);
    const player = room?.playerBySocket(socket.id);
    if (!room || !player) return;
    const opponent = room.opponentOf(socket.id);
    socket.to(roomCode).emit("game_over", { reason: "resign", winnerColor: opponent?.color ?? null });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.playerBySocket(socket.id);
      if (!player) continue;

      player.connected = false;
      socket.to(room.code).emit("opponent_disconnected");

      player.disconnectTimer = setTimeout(() => {
        socket.to(room.code).emit("game_over", { reason: "opponent_left", winnerColor: room.opponentOf(socket.id)?.color ?? null });
        rooms.delete(room.code);
      }, RECONNECT_GRACE_MS);
    }
  });
});

function cryptoRandomToken() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

server.listen(PORT, () => {
  console.log(`Servidor multiplayer do Xadrez do Formigueiro rodando na porta ${PORT}`);
});
