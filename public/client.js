(() => {
  const socket = io();

  // ---------- Estado local ----------
  let myPlayerId = localStorage.getItem('pijudo_playerId') || null;
  let myName = localStorage.getItem('pijudo_name') || '';
  let currentRoomCode = null;
  let lastState = null;
  let myDice = [];
  let diceHidden = true;
  let tableReveal = null; // { byId: {playerId: [dice]}, betValue, palo }

  const AVATARS = [
    '😀', '😎', '🤠', '🥸', '🤓', '😺', '🐵', '🦊',
    '🐸', '🐼', '🐧', '🦁', '🐯', '🐙', '👽', '🤖',
    '🧙', '🧟', '🥷', '👑',
  ];
  let selectedAvatar = localStorage.getItem('pijudo_avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];

  // ---------- Helpers DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const screenHome = $('#screen-home');
  const screenRoom = $('#screen-room');

  function showScreen(el) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    el.classList.add('active');
  }

  function diceLabel(value) {
    return value === 1 ? 'Pijudos' : `${value}s`;
  }

  // ---------- Home screen ----------
  const inputName = $('#input-name');
  const inputCode = $('#input-code');
  const homeError = $('#home-error');

  inputName.value = myName;

  function renderAvatarPicker() {
    const wrap = $('#avatar-picker');
    wrap.innerHTML = '';
    AVATARS.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-option' + (a === selectedAvatar ? ' selected' : '');
      btn.textContent = a;
      btn.addEventListener('click', () => {
        selectedAvatar = a;
        localStorage.setItem('pijudo_avatar', a);
        renderAvatarPicker();
      });
      wrap.appendChild(btn);
    });
  }
  renderAvatarPicker();

  inputCode.addEventListener('input', () => {
    inputCode.value = inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('#btn-create').addEventListener('click', () => {
    const name = inputName.value.trim();
    if (!name) return showHomeError('Ingresá un nombre.');
    myName = name;
    localStorage.setItem('pijudo_name', name);
    homeError.textContent = '';
    socket.emit('createRoom', { name, avatar: selectedAvatar, playerId: myPlayerId }, handleJoinResponse);
  });

  $('#btn-join').addEventListener('click', () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim();
    if (!name) return showHomeError('Ingresá un nombre.');
    if (!code) return showHomeError('Ingresá el código de sala.');
    myName = name;
    localStorage.setItem('pijudo_name', name);
    homeError.textContent = '';
    socket.emit('joinRoom', { code, name, avatar: selectedAvatar, playerId: myPlayerId }, handleJoinResponse);
  });

  function showHomeError(msg) {
    homeError.textContent = msg;
  }

  function handleJoinResponse(res) {
    if (!res || !res.ok) {
      showHomeError((res && res.error) || 'Ocurrió un error.');
      return;
    }
    myPlayerId = res.playerId;
    currentRoomCode = res.code;
    localStorage.setItem('pijudo_playerId', myPlayerId);
    localStorage.setItem('pijudo_roomCode', currentRoomCode);
    enterRoom(res.state);
  }

  function enterRoom(state) {
    $('#room-code-display').textContent = state.code;
    showScreen(screenRoom);
    renderState(state);
  }

  // Re-sincroniza la identidad del jugador con el servidor en cada conexión
  // del socket (carga inicial de la página Y cualquier reconexión automática
  // por hipo de red, notebook suspendida, celular bloqueado, etc.). Sin esto,
  // el socket se reconecta a nivel de transporte pero el servidor no sabe a
  // qué jugador/sala pertenece esa nueva conexión.
  socket.on('connect', () => {
    const savedCode = localStorage.getItem('pijudo_roomCode');
    const savedPlayerId = localStorage.getItem('pijudo_playerId');
    const savedName = localStorage.getItem('pijudo_name');
    if (savedCode && savedPlayerId && savedName) {
      socket.emit('joinRoom', { code: savedCode, name: savedName, playerId: savedPlayerId }, (res) => {
        if (res && res.ok) {
          myPlayerId = savedPlayerId;
          myName = savedName;
          currentRoomCode = res.code;
          enterRoom(res.state);
        }
      });
    }
  });

  // ---------- Room screen: leave / copy ----------
  $('#btn-leave').addEventListener('click', () => {
    socket.emit('leaveRoom');
    localStorage.removeItem('pijudo_roomCode');
    currentRoomCode = null;
    lastState = null;
    showScreen(screenHome);
  });

  $('#btn-copy-code').addEventListener('click', () => {
    if (!currentRoomCode) return;
    navigator.clipboard && navigator.clipboard.writeText(currentRoomCode).catch(() => {});
  });

  $('#btn-start').addEventListener('click', () => {
    socket.emit('startGame');
  });

  // ---------- Betting controls ----------
  const betQty = $('#bet-qty');
  const betValue = $('#bet-value');

  $('#btn-bet').addEventListener('click', () => {
    const qty = parseInt(betQty.value, 10);
    const value = parseInt(betValue.value, 10);
    if (!qty || qty < 1) return;
    socket.emit('placeBet', { qty, value });
  });

  $('#btn-toggle-dice').addEventListener('click', () => {
    diceHidden = !diceHidden;
    renderMyDice();
  });

  betValue.addEventListener('change', () => {
    updateBetHint();
  });

  document.querySelectorAll('.emote-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      socket.emit('emote', { emoji: btn.dataset.emoji });
      if (myPlayerId) showEmoteBubble(myPlayerId, btn.dataset.emoji);
    });
  });

  socket.on('emote', ({ playerId, emoji }) => {
    if (playerId === myPlayerId) return; // ya la mostramos al instante localmente
    showEmoteBubble(playerId, emoji);
  });

  function showEmoteBubble(playerId, emoji) {
    const seat = document.getElementById('seat-' + playerId);
    if (!seat) return;
    const bubble = document.createElement('div');
    bubble.className = 'emote-bubble';
    bubble.textContent = emoji;
    seat.appendChild(bubble);
    setTimeout(() => bubble.remove(), 1800);
  }

  $('#btn-doubt').addEventListener('click', () => {
    socket.emit('doubt');
  });

  $('#btn-calzo').addEventListener('click', () => {
    socket.emit('calzo');
  });

  // ---------- Chat ----------
  const chatForm = $('#chat-form');
  const chatInput = $('#chat-input');
  const chatMessages = $('#chat-messages');

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chatMessage', { text });
    chatInput.value = '';
  });

  socket.on('chatMessage', (msg) => {
    appendChatMessage(msg);
  });

  function appendChatMessage(msg) {
    const div = document.createElement('div');
    if (msg.system) {
      div.className = 'chat-msg system';
      div.textContent = msg.text;
    } else {
      div.className = 'chat-msg';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'chat-name';
      nameSpan.textContent = msg.name + ': ';
      div.appendChild(nameSpan);
      div.appendChild(document.createTextNode(msg.text));
    }
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ---------- Server state ----------
  socket.on('roomUpdate', (state) => {
    lastState = state;
    renderState(state);
  });

  socket.on('yourDice', ({ dice }) => {
    myDice = dice;
    diceHidden = true; // por privacidad, cada ronda nueva arranca oculta
    renderMyDice();
  });

  socket.on('errorMessage', (msg) => {
    flashError(msg);
  });

  socket.on('roundResult', (result) => {
    renderRoundResult(result);
  });

  function flashError(msg) {
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    el.style.color = '#e56864';
    el.textContent = '⚠ ' + msg;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ---------- Rendering ----------
  function renderState(state) {
    if (!state) return;

    // Players list
    const list = $('#players-list');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      if (p.id === state.currentPlayerId) li.classList.add('is-turn');
      if (p.diceCount === 0) li.classList.add('is-eliminated');
      if (!p.connected) li.classList.add('is-disconnected');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'player-name';
      nameSpan.textContent = p.name + (p.id === myPlayerId ? ' (vos)' : '');
      if (p.isHost) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = '★';
        nameSpan.appendChild(badge);
      }

      const diceSpan = document.createElement('span');
      diceSpan.className = 'dice-count';
      diceSpan.textContent = '🎲 ' + p.diceCount;

      li.appendChild(nameSpan);
      li.appendChild(diceSpan);
      list.appendChild(li);
    });

    // Pregame panel
    const pregame = $('#pregame-panel');
    const btnStart = $('#btn-start');
    if (!state.started && !state.winnerId) {
      pregame.style.display = 'block';
      const isHost = state.hostId === myPlayerId;
      btnStart.style.display = isHost ? 'inline-block' : 'none';
      $('.hint', pregame) || null;
      pregame.querySelector('.hint').textContent = isHost
        ? 'Sos el anfitrión. Empezá cuando estén todos.'
        : 'Esperando a que el anfitrión empiece la partida...';
    } else {
      pregame.style.display = 'none';
    }

    // Palo banner
    $('#palo-banner').style.display = state.started && state.paloRound ? 'block' : 'none';

    // Turn indicator
    const turnIndicator = $('#turn-indicator');
    const nextIndicator = $('#next-indicator');
    if (state.started) {
      const cur = state.players.find((p) => p.id === state.currentPlayerId);
      turnIndicator.textContent = cur ? `Turno de ${cur.id === myPlayerId ? 'vos' : cur.name}` : '';
      const next = state.players.find((p) => p.id === state.nextPlayerId);
      nextIndicator.textContent = next ? `→ después: ${next.id === myPlayerId ? 'vos' : next.name}` : '';
    } else {
      turnIndicator.textContent = state.winnerId ? '' : 'Esperando inicio...';
      nextIndicator.textContent = '';
    }

    // Current bet
    const betDisplay = $('#current-bet-display');
    if (state.currentBet) {
      betDisplay.innerHTML = `<span class="bet-value-icon">${state.currentBet.qty}</span> × ${diceLabel(state.currentBet.value)}` +
        `<div style="font-size:0.8rem; font-weight:400; color:var(--text-dim); margin-top:4px;">apostado por ${state.currentBet.byId === myPlayerId ? 'vos' : escapeHtml(state.currentBet.byName)}</div>`;
    } else {
      betDisplay.innerHTML = '<span class="bet-empty">Sin apuestas todavía</span>';
    }

    // Controls visibility
    const isMyTurn = state.started && state.currentPlayerId === myPlayerId;
    const betControls = $('#bet-controls');
    const waitingTurn = $('#waiting-turn');
    const btnDoubt = $('#btn-doubt');
    const btnCalzo = $('#btn-calzo');

    if (isMyTurn) {
      betControls.style.display = 'flex';
      waitingTurn.style.display = 'none';
      const hasBet = !!state.currentBet;
      btnDoubt.style.display = hasBet && state.currentBet.byId !== myPlayerId ? 'inline-block' : 'none';
      btnCalzo.style.display = hasBet ? 'inline-block' : 'none';
      updateBetHint();
    } else {
      betControls.style.display = 'none';
      $('#bet-hint').textContent = '';
      const cur = state.players.find((p) => p.id === state.currentPlayerId);
      waitingTurn.style.display = state.started ? 'block' : 'none';
      $('#waiting-name').textContent = cur ? cur.name : '';
    }

    // Game over banner
    const overBanner = $('#game-over-banner');
    if (state.winnerId) {
      const winner = state.players.find((p) => p.id === state.winnerId);
      overBanner.style.display = 'block';
      overBanner.textContent = winner
        ? `🏆 ${winner.id === myPlayerId ? '¡Ganaste!' : winner.name + ' ganó la partida'}`
        : '';
      const isHost = state.hostId === myPlayerId;
      if (isHost) {
        overBanner.textContent += ' — podés empezar una nueva partida.';
        pregame.style.display = 'block';
        btnStart.style.display = 'inline-block';
        btnStart.textContent = 'Jugar de nuevo';
      }
    } else {
      overBanner.style.display = 'none';
      btnStart.textContent = 'Empezar partida';
    }

    renderTable(state);
  }

  // Espejo de Room.isValidBet / la lógica del servidor: mínima cantidad legal
  // para apostar `newValue` dado el estado actual de la ronda.
  function minQtyFor(oldBet, paloRound, newValue) {
    if (!oldBet) return 1;
    if (paloRound) return oldBet.qty + 1;
    if (newValue === 1 && oldBet.value !== 1) return Math.ceil(oldBet.qty / 2);
    if (newValue === 1 && oldBet.value === 1) return oldBet.qty + 1;
    if (newValue !== 1 && oldBet.value === 1) return oldBet.qty * 2 + 1;
    if (newValue > oldBet.value) return oldBet.qty;
    return oldBet.qty + 1; // igual o menor valor: hay que subir cantidad
  }

  function updateBetHint() {
    const hint = $('#bet-hint');
    const state = lastState;
    if (!state || state.currentPlayerId !== myPlayerId) return;
    const newValue = parseInt(betValue.value, 10);
    const min = minQtyFor(state.currentBet, state.paloRound, newValue);

    betQty.min = min;
    if (parseInt(betQty.value, 10) < min || !betQty.value) betQty.value = min;

    if (!state.currentBet) {
      hint.textContent = '';
      return;
    }
    if (state.paloRound) {
      hint.textContent = `🪓 Mano de palo: solo se puede subir cantidad. Mínimo ${min}.`;
    } else if (newValue === 1 && state.currentBet.value !== 1) {
      hint.textContent = `Pasar a Pijudos: mitad de ${state.currentBet.qty} redondeado hacia arriba → mínimo ${min}.`;
    } else if (newValue !== 1 && state.currentBet.value === 1) {
      hint.textContent = `Pasar de Pijudos a ${newValue}: mínimo ${min} (el doble + 1).`;
    } else {
      hint.textContent = `Mínimo para esta apuesta: ${min}.`;
    }
  }

  function renderMyDice() {
    const eyeIcon = $('#eye-icon');
    const eyeLabel = $('#eye-label');
    eyeIcon.textContent = diceHidden ? '👁️' : '🙈';
    eyeLabel.textContent = diceHidden ? 'Ver mis dados' : 'Ocultar mis dados';
    if (lastState) renderTable(lastState);
  }

  // ---------- Mesa con avatares y cubiletes ----------
  function renderTable(state) {
    const seatsEl = $('#seats');
    if (!seatsEl) return;
    const players = state.players || [];
    seatsEl.innerHTML = '';
    if (players.length === 0) return;

    let myIndex = players.findIndex((p) => p.id === myPlayerId);
    if (myIndex === -1) myIndex = 0;
    const seatOrder = players.slice(myIndex).concat(players.slice(0, myIndex));
    const N = seatOrder.length;
    const rx = 44;
    const ry = 40;

    seatOrder.forEach((p, i) => {
      const theta = Math.PI / 2 + i * ((2 * Math.PI) / N);
      const left = 50 + rx * Math.cos(theta);
      const top = 50 + ry * Math.sin(theta);

      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.id = 'seat-' + p.id;
      seat.style.left = left + '%';
      seat.style.top = top + '%';
      if (p.id === myPlayerId) seat.classList.add('is-me');
      if (state.started && p.id === state.currentPlayerId) seat.classList.add('is-turn');
      if (state.started && p.id === state.nextPlayerId) seat.classList.add('is-next');
      if (p.diceCount === 0) seat.classList.add('is-eliminated');
      if (!p.connected) seat.classList.add('is-disconnected');

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = p.avatar || '🎲';

      const nameEl = document.createElement('div');
      nameEl.className = 'seat-name';
      nameEl.textContent = (p.isHost ? '★ ' : '') + p.name + (p.id === myPlayerId ? ' (vos)' : '');

      const cupWrap = document.createElement('div');
      cupWrap.className = 'cup-wrap';

      const diceRow = document.createElement('div');
      diceRow.className = 'seat-dice';

      const reveal = tableReveal && tableReveal.byId[p.id];
      let lifted = false;

      if (reveal) {
        lifted = true;
        reveal.forEach((val) => {
          const d = document.createElement('div');
          const isMatch = val === tableReveal.betValue ||
            (!tableReveal.palo && tableReveal.betValue !== 1 && val === 1);
          d.className = 'seat-die' + (isMatch ? ' match' : '');
          d.textContent = val;
          diceRow.appendChild(d);
        });
      } else if (p.id === myPlayerId) {
        lifted = !diceHidden && p.diceCount > 0;
        for (let k = 0; k < p.diceCount; k++) {
          const d = document.createElement('div');
          if (lifted) {
            d.className = 'seat-die' + (myDice[k] === 1 ? ' pijudo' : '');
            d.textContent = myDice[k];
          } else {
            d.className = 'seat-die hidden';
          }
          diceRow.appendChild(d);
        }
      } else {
        for (let k = 0; k < p.diceCount; k++) {
          const d = document.createElement('div');
          d.className = 'seat-die hidden';
          diceRow.appendChild(d);
        }
      }

      const cup = document.createElement('div');
      cup.className = 'cup';
      if (p.diceCount === 0) cup.style.display = 'none';

      cupWrap.appendChild(diceRow);
      cupWrap.appendChild(cup);
      if (lifted && p.diceCount > 0) cupWrap.classList.add('lifted');

      const diceCountEl = document.createElement('div');
      diceCountEl.className = 'seat-dicecount';
      diceCountEl.textContent = '🎲 ' + p.diceCount;

      seat.appendChild(avatar);
      seat.appendChild(nameEl);
      seat.appendChild(cupWrap);
      seat.appendChild(diceCountEl);
      seatsEl.appendChild(seat);
    });
  }

  function renderRoundResult(result) {
    const byId = {};
    result.detail.forEach((d) => {
      byId[d.id] = d.dice;
    });
    tableReveal = { byId, betValue: result.bet.value, palo: isPaloResult(result) };
    if (lastState) renderTable(lastState);
    setTimeout(() => {
      tableReveal = null;
      if (lastState) renderTable(lastState);
    }, 5000);

    const el = $('#round-result');
    el.style.display = 'block';
    const bet = result.bet;
    let html = `<h4>${result.type === 'doubt' ? 'Resultado del desconfío' : 'Resultado del ¡hay justo!'}</h4>`;
    html += `<p>Se apostó <strong>${bet.qty} ${diceLabel(bet.value)}</strong> — en la mesa había <strong>${result.actualCount}</strong>.</p>`;

    result.detail.forEach((d) => {
      html += `<div class="reveal-row"><span class="reveal-name">${escapeHtml(d.name)}</span>`;
      d.dice.forEach((val) => {
        const match = val === bet.value || (bet.value !== 1 && val === 1 && !isPaloResult(result));
        html += `<span class="mini-die${match ? ' match' : ''}">${val}</span>`;
      });
      html += `</div>`;
    });

    if (result.type === 'doubt') {
      html += `<p>${escapeHtml(result.loserName)} pierde un dado${result.eliminated ? ' y queda eliminado.' : '.'}</p>`;
    } else {
      html += `<p>${escapeHtml(result.callerName)} ${result.exact ? 'acertó y recupera un dado.' : 'falló y pierde un dado' + (result.eliminated ? ', quedando eliminado.' : '.')}</p>`;
    }

    el.innerHTML = html;
    setTimeout(() => {
      el.style.display = 'none';
    }, 5000);
  }

  function isPaloResult() {
    return lastState && lastState.paloRound;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  renderMyDice();
})();
