// multiplayer.js — cole isto no seu front-end e integre com a lógica do jogo.
//
// Pré-requisito no HTML (antes deste arquivo):
// <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
//
// Como integrar (visão geral):
//   1. Quando o jogador clicar em "Jogar Online" -> mostrar opção "Criar Sala" ou "Entrar com Código"
//   2. Ao criar/entrar com sucesso, você recebe a `color` do jogador (marfim/onix) —
//      trave a UI para só permitir mover peças dessa cor.
//   3. Sempre que o SEU jogador fizer uma jogada (na sua lógica atual de clique/drag),
//      além de aplicar no seu tabuleiro local, chame Multiplayer.sendMove(moveData).
//   4. Quando Multiplayer.onOpponentMove disparar, aplique a jogada recebida no seu
//      tabuleiro exatamente como se fosse a lógica local de mover peça.
//
// moveData pode ser qualquer objeto — recomendo o formato que sua função de mover peça
// já usa internamente, por exemplo: { from: "e2", to: "e4", pieceType: "larva", promotion: null }

const Multiplayer = (() => {
  const SERVER_URL = "https://SEU-SERVIDOR-MULTIPLAYER.onrender.com"; // troque pela URL do serviço criado no Render

  let socket = null;
  let roomCode = null;
  let myColor = null;
  let myToken = null;

  const listeners = {
    opponentJoined: [],
    opponentMove: [],
    opponentDisconnected: [],
    opponentReconnected: [],
    gameOver: [],
  };

  function connect() {
    if (socket) return socket;
    socket = io(SERVER_URL, { transports: ["websocket"] });

    socket.on("opponent_joined", (data) => listeners.opponentJoined.forEach((fn) => fn(data)));
    socket.on("opponent_move", (moveData) => listeners.opponentMove.forEach((fn) => fn(moveData)));
    socket.on("opponent_disconnected", () => listeners.opponentDisconnected.forEach((fn) => fn()));
    socket.on("opponent_reconnected", () => listeners.opponentReconnected.forEach((fn) => fn()));
    socket.on("game_over", (data) => listeners.gameOver.forEach((fn) => fn(data)));

    // Tenta reconectar automaticamente numa partida em andamento (ex: refresh da página)
    socket.on("connect", () => {
      const saved = sessionStorage.getItem("xadrez_room");
      if (saved) {
        const { roomCode: savedRoom, token: savedToken } = JSON.parse(saved);
        socket.emit("rejoin_room", { roomCode: savedRoom, token: savedToken }, (res) => {
          if (res.ok) {
            roomCode = savedRoom;
            myToken = savedToken;
            myColor = res.color;
          }
        });
      }
    });

    return socket;
  }

  function persistSession() {
    sessionStorage.setItem("xadrez_room", JSON.stringify({ roomCode, token: myToken }));
  }

  function createRoom() {
    connect();
    return new Promise((resolve, reject) => {
      socket.emit("create_room", {}, (res) => {
        if (!res.ok) return reject(res.error);
        roomCode = res.roomCode;
        myColor = res.color;
        myToken = res.token;
        persistSession();
        resolve({ roomCode, color: myColor });
      });
    });
  }

  function joinRoom(code) {
    connect();
    return new Promise((resolve, reject) => {
      socket.emit("join_room", { roomCode: code }, (res) => {
        if (!res.ok) return reject(res.error);
        roomCode = code;
        myColor = res.color;
        myToken = res.token;
        persistSession();
        resolve({ roomCode, color: myColor });
      });
    });
  }

  function sendMove(moveData) {
    if (!socket || !roomCode) return;
    socket.emit("move", { roomCode, moveData }, (res) => {
      if (!res.ok) console.warn("Jogada rejeitada pelo servidor:", res.error);
    });
  }

  function sendGameOver(reason, winnerColor) {
    if (!socket || !roomCode) return;
    socket.emit("game_over", { roomCode, reason, winnerColor });
  }

  function resign() {
    if (!socket || !roomCode) return;
    socket.emit("resign", { roomCode });
  }

  return {
    createRoom,
    joinRoom,
    sendMove,
    sendGameOver,
    resign,
    get myColor() { return myColor; },
    get roomCode() { return roomCode; },
    onOpponentJoined: (fn) => listeners.opponentJoined.push(fn),
    onOpponentMove: (fn) => listeners.opponentMove.push(fn),
    onOpponentDisconnected: (fn) => listeners.opponentDisconnected.push(fn),
    onOpponentReconnected: (fn) => listeners.opponentReconnected.push(fn),
    onGameOver: (fn) => listeners.gameOver.push(fn),
  };
})();
