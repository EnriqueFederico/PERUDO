const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory state ----------
// rooms: Map<code, Room>
const rooms = new Map();

const MAX_DICE = 5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos

const ALLOWED_AVATARS = [
  '😀', '😎', '🤠', '🥸', '🤓', '😺', '🐵', '🦊',
  '🐸', '🐼', '🐧', '🦁', '🐯', '🐙', '👽', '🤖',
  '🧙', '🧟', '🥷', '👑',
];
const ALLOWED_EMOTES = ['😂', '😠', '🖕'];
const EMOTE_COOLDOWN_MS = 600;

function sanitizeAvatar(avatar) {
  if (typeof avatar === 'string' && ALLOWED_AVATARS.includes(avatar)) return avatar;
  return ALLOWED_AVATARS[Math.floor(Math.random() * ALLOWED_AVATARS.length)];
}

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function rollDice(n) {
  const dice = [];
  for (let i = 0; i < n; i++) dice.push(1 + Math.floor(Math.random() * 6));
  return dice;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  return name.trim().slice(0, 20).replace(/[<>]/g, '');
}

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, 500);
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> player
    this.order = []; // array of player ids, join order (fixed seating)
    this.hostId = null;
    this.started = false;
    this.currentBet = null; // { qty, value, byId, byName }
    this.currentIndex = 0; // index into activeOrder() for whose turn it is
    this.roundStarterId = null;
    this.paloRound = false;
    this.messages = [];
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.winnerId = null;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  activePlayers() {
    // players still in game, in seating order
    return this.order
      .map((id) => this.players.get(id))
      .filter((p) => p && p.diceCount > 0 && !p.left);
  }

  connectedCount() {
    return [...this.players.values()].filter((p) => p.connected && !p.left).length;
  }

  publicPlayers() {
    return this.order
      .map((id) => this.players.get(id))
      .filter((p) => p && !p.left)
      .map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        diceCount: p.diceCount,
        connected: p.connected,
        isHost: p.id === this.hostId,
      }));
  }

  nextPlayerAfter(playerId) {
    const active = this.activePlayers();
    if (active.length < 2) return null;
    const idx = active.findIndex((p) => p.id === playerId);
    if (idx === -1) return null;
    return active[(idx + 1) % active.length];
  }

  currentPlayer() {
    const active = this.activePlayers();
    if (active.length === 0) return null;
    return active[this.currentIndex % active.length];
  }

  publicState() {
    const cur = this.currentPlayer();
    return {
      code: this.code,
      started: this.started,
      hostId: this.hostId,
      players: this.publicPlayers(),
      currentBet: this.currentBet,
      currentPlayerId: cur ? cur.id : null,
      nextPlayerId: cur ? (this.nextPlayerAfter(cur.id) || {}).id || null : null,
      paloRound: this.paloRound,
      winnerId: this.winnerId,
      totalDiceOnTable: [...this.players.values()]
        .filter((p) => !p.left && p.diceCount > 0)
        .reduce((s, p) => s + p.diceCount, 0),
    };
  }

  broadcastState() {
    io.to(this.code).emit('roomUpdate', this.publicState());
  }

  sendChatSystem(text) {
    const msg = { id: makeId(), system: true, name: 'Mesa', text, ts: Date.now() };
    this.messages.push(msg);
    if (this.messages.length > 200) this.messages.shift();
    io.to(this.code).emit('chatMessage', msg);
  }

  startGame() {
    this.started = true;
    this.winnerId = null;
    for (const p of this.players.values()) {
      if (p.left) continue;
      p.diceCount = MAX_DICE;
      p.dice = rollDice(MAX_DICE);
    }
    this.currentBet = null;
    this.currentIndex = 0;
    const active = this.activePlayers();
    this.roundStarterId = active.length ? active[0].id : null;
    this.paloRound = active.length === 1 ? false : active[0] && active[0].diceCount === 1;
    this.sendChatSystem('¡Empieza la partida! Cada uno agita su cubilete...');
    this.sendPrivateDice();
  }

  startNewRound(starterId) {
    for (const p of this.players.values()) {
      if (p.left || p.diceCount <= 0) continue;
      p.dice = rollDice(p.diceCount);
    }
    this.currentBet = null;
    const active = this.activePlayers();
    if (active.length === 0) {
      this.currentIndex = 0;
      return;
    }
    let idx = active.findIndex((p) => p.id === starterId);
    if (idx === -1) idx = 0;
    this.currentIndex = idx;
    this.roundStarterId = active[idx].id;
    this.paloRound = active[idx].diceCount === 1;
    this.sendPrivateDice();
  }

  sendPrivateDice() {
    for (const p of this.players.values()) {
      if (p.left || !p.socketId) continue;
      io.to(p.socketId).emit('yourDice', { dice: p.diceCount > 0 ? p.dice : [] });
    }
  }

  advanceTurn() {
    const active = this.activePlayers();
    if (active.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % active.length;
  }

  // Determine if newBet is a legal raise over this.currentBet, respecting palo rules.
  isValidBet(newBet) {
    const { qty, value } = newBet;
    if (!Number.isInteger(qty) || qty < 1) return false;
    if (!Number.isInteger(value) || value < 1 || value > 6) return false;
    const old = this.currentBet;
    if (!old) return true; // first bet of the round, anything goes

    if (this.paloRound) {
      // No wildcards, no halving shortcut: strictly more dice required.
      return qty > old.qty;
    }

    if (value === 1 && old.value !== 1) {
      const minQty = Math.ceil(old.qty / 2);
      return qty >= minQty;
    }
    if (value === 1 && old.value === 1) {
      return qty > old.qty;
    }
    if (value !== 1 && old.value === 1) {
      const minQty = old.qty * 2 + 1;
      return qty >= minQty;
    }
    // both non-pijos
    if (qty > old.qty) return true;
    if (qty === old.qty && value > old.value) return true;
    return false;
  }

  countValue(value) {
    let count = 0;
    const detail = [];
    for (const p of this.players.values()) {
      if (p.left || p.diceCount <= 0) continue;
      let mine = 0;
      for (const d of p.dice) {
        if (d === value) mine++;
        else if (!this.paloRound && value !== 1 && d === 1) mine++;
      }
      count += mine;
      detail.push({ id: p.id, name: p.name, dice: [...p.dice] });
    }
    return { count, detail };
  }

  resolveDoubt(doubterId) {
    const bet = this.currentBet;
    const { count, detail } = this.countValue(bet.value);
    const actualMet = count >= bet.qty;
    const loserId = actualMet ? doubterId : bet.byId;
    const loser = this.players.get(loserId);
    loser.diceCount = Math.max(0, loser.diceCount - 1);
    const eliminated = loser.diceCount === 0;

    const result = {
      type: 'doubt',
      bet,
      actualCount: count,
      detail,
      doubterId,
      loserId,
      loserName: loser.name,
      eliminated,
    };
    io.to(this.code).emit('roundResult', result);

    const doubterName = this.players.get(doubterId).name;
    this.sendChatSystem(
      `${doubterName} desconfió de ${bet.byName} (${bet.qty} ${diceLabel(bet.value)}). Salieron ${count}. ` +
        `${loser.name} pierde un dado${eliminated ? ' y queda eliminado' : ''}.`
    );

    this.afterRound(loserId, eliminated);
  }

  resolveCalzo(callerId) {
    const bet = this.currentBet;
    const { count, detail } = this.countValue(bet.value);
    const exact = count === bet.qty;
    const caller = this.players.get(callerId);
    let eliminated = false;
    if (exact) {
      caller.diceCount = Math.min(MAX_DICE, caller.diceCount + 1);
    } else {
      caller.diceCount = Math.max(0, caller.diceCount - 1);
      eliminated = caller.diceCount === 0;
    }

    const result = {
      type: 'calzo',
      bet,
      actualCount: count,
      detail,
      callerId,
      exact,
      eliminated,
      callerName: caller.name,
    };
    io.to(this.code).emit('roundResult', result);

    this.sendChatSystem(
      `${caller.name} dijo "¡hay justo!" sobre ${bet.qty} ${diceLabel(bet.value)}. Salieron ${count}. ` +
        (exact
          ? `¡Acertó y recupera un dado!`
          : `Falló y pierde un dado${eliminated ? ' quedando eliminado' : ''}.`)
    );

    this.afterRound(callerId, eliminated);
  }

  afterRound(lastActorId, eliminated) {
    const alive = [...this.players.values()].filter((p) => !p.left && p.diceCount > 0);
    if (alive.length <= 1) {
      this.started = false;
      this.currentBet = null;
      this.winnerId = alive.length === 1 ? alive[0].id : null;
      if (this.winnerId) {
        this.sendChatSystem(`🏆 ¡${this.players.get(this.winnerId).name} gana la partida!`);
      } else {
        this.sendChatSystem('La partida terminó sin ganador (todos eliminados).');
      }
      this.broadcastState();
      return;
    }

    // Determine who starts next round: the loser if still alive, otherwise next alive player after them in seating order.
    let nextStarterId = lastActorId;
    const loserStillAlive = this.players.get(lastActorId).diceCount > 0;
    if (!loserStillAlive) {
      const startIdx = this.order.indexOf(lastActorId);
      for (let i = 1; i <= this.order.length; i++) {
        const cand = this.players.get(this.order[(startIdx + i) % this.order.length]);
        if (cand && !cand.left && cand.diceCount > 0) {
          nextStarterId = cand.id;
          break;
        }
      }
    }

    setTimeout(() => {
      this.startNewRound(nextStarterId);
      this.broadcastState();
    }, 3500);
  }
}

function diceLabel(value) {
  return value === 1 ? 'Pijudos (ases)' : `${value}s`;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase());
}

// ---------- Socket handling ----------
io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on('createRoom', ({ name, avatar, playerId }, cb) => {
    try {
      const cleanName = sanitizeName(name) || 'Jugador';
      const code = makeRoomCode();
      const room = new Room(code);
      rooms.set(code, room);

      const id = playerId && typeof playerId === 'string' ? playerId : makeId();
      const player = {
        id,
        name: cleanName,
        avatar: sanitizeAvatar(avatar),
        socketId: socket.id,
        connected: true,
        left: false,
        diceCount: MAX_DICE,
        dice: [],
        lastEmoteAt: 0,
      };
      room.players.set(id, player);
      room.order.push(id);
      room.hostId = id;

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = id;

      room.sendChatSystem(`${cleanName} creó la sala.`);
      cb && cb({ ok: true, code, playerId: id, state: room.publicState() });
      room.broadcastState();
    } catch (err) {
      cb && cb({ ok: false, error: 'No se pudo crear la sala.' });
    }
  });

  socket.on('joinRoom', ({ code, name, avatar, playerId }, cb) => {
    const room = getRoom(code);
    if (!room) return cb && cb({ ok: false, error: 'No existe una sala con ese código.' });

    // Reconnection path: same playerId already seated in this room.
    if (playerId && room.players.has(playerId)) {
      const existing = room.players.get(playerId);
      existing.connected = true;
      existing.left = false;
      existing.socketId = socket.id;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      room.touch();
      cb && cb({ ok: true, code: room.code, playerId, state: room.publicState() });
      if (room.started) {
        io.to(socket.id).emit('yourDice', { dice: existing.diceCount > 0 ? existing.dice : [] });
      }
      room.sendChatSystem(`${existing.name} se reconectó.`);
      room.broadcastState();
      return;
    }

    if (room.started) {
      return cb && cb({ ok: false, error: 'La partida ya empezó, esperá a la próxima ronda.' });
    }
    if (room.connectedCount() >= 15) {
      return cb && cb({ ok: false, error: 'La sala está llena (máximo 15 jugadores).' });
    }

    const cleanName = sanitizeName(name) || 'Jugador';
    const id = makeId();
    const player = {
      id,
      name: cleanName,
      avatar: sanitizeAvatar(avatar),
      socketId: socket.id,
      connected: true,
      left: false,
      diceCount: MAX_DICE,
      dice: [],
      lastEmoteAt: 0,
    };
    room.players.set(id, player);
    room.order.push(id);

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = id;
    room.touch();

    room.sendChatSystem(`${cleanName} se unió a la sala.`);
    cb && cb({ ok: true, code: room.code, playerId: id, state: room.publicState() });
    room.broadcastState();
  });

  socket.on('startGame', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.started) return;
    const activeCount = [...room.players.values()].filter((p) => !p.left).length;
    if (activeCount < 2) {
      io.to(socket.id).emit('errorMessage', 'Necesitás al menos 2 jugadores para empezar.');
      return;
    }
    room.startGame();
    room.broadcastState();
  });

  socket.on('placeBet', ({ qty, value }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.started) return;
    const cur = room.currentPlayer();
    if (!cur || cur.id !== socket.data.playerId) return;

    const bet = { qty: Number(qty), value: Number(value) };
    if (!room.isValidBet(bet)) {
      io.to(socket.id).emit('errorMessage', 'Esa apuesta no es válida, tiene que superar la anterior.');
      return;
    }
    room.currentBet = { ...bet, byId: cur.id, byName: cur.name };
    room.sendChatSystem(`${cur.name} apostó ${bet.qty} ${diceLabel(bet.value)}.`);
    room.advanceTurn();
    room.broadcastState();
  });

  socket.on('doubt', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.started || !room.currentBet) return;
    const cur = room.currentPlayer();
    if (!cur || cur.id !== socket.data.playerId) return;
    if (cur.id === room.currentBet.byId) return; // can't doubt yourself
    room.resolveDoubt(cur.id);
    room.broadcastState();
  });

  socket.on('calzo', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.started || !room.currentBet) return;
    const cur = room.currentPlayer();
    if (!cur || cur.id !== socket.data.playerId) return;
    room.resolveCalzo(cur.id);
    room.broadcastState();
  });

  socket.on('chatMessage', ({ text }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    const clean = sanitizeText(text);
    if (!clean) return;
    const msg = { id: makeId(), system: false, name: player.name, playerId: player.id, text: clean, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(room.code).emit('chatMessage', msg);
  });

  socket.on('emote', ({ emoji }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || player.left) return;
    if (!ALLOWED_EMOTES.includes(emoji)) return;
    const now = Date.now();
    if (now - (player.lastEmoteAt || 0) < EMOTE_COOLDOWN_MS) return;
    player.lastEmoteAt = now;
    io.to(room.code).emit('emote', { playerId: player.id, emoji });
  });

  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    player.connected = false;
    room.sendChatSystem(`${player.name} se desconectó.`);
    room.broadcastState();
    maybeCleanupRoom(room);
  });
});

function handleLeave(socket) {
  const room = getRoom(socket.data.roomCode);
  if (!room) return;
  const player = room.players.get(socket.data.playerId);
  if (player) {
    player.left = true;
    player.connected = false;
    room.sendChatSystem(`${player.name} abandonó la sala.`);
    if (room.hostId === player.id) {
      const nextHost = room.order.map((id) => room.players.get(id)).find((p) => p && !p.left);
      room.hostId = nextHost ? nextHost.id : null;
    }
  }
  socket.leave(room.code);
  socket.data.roomCode = null;
  socket.data.playerId = null;
  room.broadcastState();
  maybeCleanupRoom(room);
}

function maybeCleanupRoom(room) {
  const anyoneLeft = [...room.players.values()].some((p) => !p.left);
  if (!anyoneLeft) {
    rooms.delete(room.code);
    return;
  }
  const anyoneConnected = [...room.players.values()].some((p) => p.connected && !p.left);
  if (!anyoneConnected) {
    // Give the room a grace period before deletion in case everyone reconnects.
    setTimeout(() => {
      const r = rooms.get(room.code);
      if (!r) return;
      const stillNoOne = [...r.players.values()].some((p) => p.connected && !p.left);
      if (!stillNoOne) rooms.delete(room.code);
    }, 5 * 60 * 1000);
  }
}

// Periodic cleanup of very stale empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = [...room.players.values()].some((p) => p.connected && !p.left);
    if (!anyoneConnected && now - room.lastActivity > 30 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pijudo corriendo en http://localhost:${PORT}`);
});
