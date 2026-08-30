(() => {
  const socket = io();

  // ---------- Estado local ----------
  let myPlayerId = localStorage.getItem('pijudo_playerId') || null;
  let myName = localStorage.getItem('pijudo_name') || '';
  let currentRoomCode = null;
  let lastState = null;
  let myDice = [];
  let diceHidden = true;

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

  inputCode.addEventListener('input', () => {
    inputCode.value = inputCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('#btn-create').addEventListener('click', () => {
    const name = inputName.value.trim();
    if (!name) return showHomeError('Ingresá un nombre.');
    myName = name;
    localStorage.setItem('pijudo_name', name);
    homeError.textContent = '';
    socket.emit('createRoom', { name, playerId: myPlayerId }, handleJoinResponse);
  });

  $('#btn-join').addEventListener('click', () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim();
    if (!name) return showHomeError('Ingresá un nombre.');
    if (!code) return showHomeError('Ingresá el código de sala.');
    myName = name;
    localStorage.setItem('pijudo_name', name);
    homeError.textContent = '';
    socket.emit('joinRoom', { code, name, playerId: myPlayerId }, handleJoinResponse);
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
    if (state.started) {
      const cur = state.players.find((p) => p.id === state.currentPlayerId);
      turnIndicator.textContent = cur ? `Turno de ${cur.id === myPlayerId ? 'vos' : cur.name}` : '';
    } else {
      turnIndicator.textContent = state.winnerId ? '' : 'Esperando inicio...';
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
    const row = $('#my-dice');
    row.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const d = myDice[i];
      const die = document.createElement('div');
      if (d === undefined) {
        die.className = 'die gone';
      } else if (diceHidden) {
        die.className = 'die hidden-die';
      } else {
        die.className = 'die' + (d === 1 ? ' pijudo' : '');
        die.textContent = d;
      }
      row.appendChild(die);
    }
    const eyeIcon = $('#eye-icon');
    const eyeLabel = $('#eye-label');
    eyeIcon.textContent = diceHidden ? '👁️' : '🙈';
    eyeLabel.textContent = diceHidden ? 'Ver mis dados' : 'Ocultar mis dados';
  }

  function renderRoundResult(result) {
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
