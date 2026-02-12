/* ═══════════════════════════════════════════
   VC+ Main Application
   ═══════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── State ───
  let socket = null;
  let token = localStorage.getItem('vcplus_token');
  let currentUser = null;
  let voiceEngine = null;
  let streamEngine = null;
  let audioVisualizer = null;

  let guilds = [];
  let currentGuild = null;
  let currentChannel = null;
  let guildData = {}; // guildId -> { guild, channels, members }
  let voiceChannelStates = {}; // channelId -> [users]
  let activeStreams = {}; // channelId -> stream info

  let typingTimeout = null;
  let membersVisible = true;
  let mobileMenuOpen = false;

  // ─── DOM refs ───
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ─── API Helper ───
  async function api(path, method = 'GET', body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`/api${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ─── Init ───
  async function init() {
    setupAuthUI();
    setupAppUI();

    if (token) {
      try {
        const data = await api('/auth/me');
        currentUser = data.user;
        enterApp();
      } catch {
        token = null;
        localStorage.removeItem('vcplus_token');
        showScreen('auth');
      }
    } else {
      showScreen('auth');
    }
  }

  function showScreen(name) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#${name}-screen`).classList.add('active');
  }

  // ─── Auth ───
  function setupAuthUI() {
    // Tab switching
    $$('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.auth-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        $$('.auth-form').forEach(f => f.classList.remove('active'));
        $(`#${tab.dataset.tab}-form`).classList.add('active');
      });
    });

    // Login
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#login-error').textContent = '';
      try {
        const data = await api('/auth/login', 'POST', {
          username: $('#login-username').value,
          password: $('#login-password').value
        });
        token = data.token;
        localStorage.setItem('vcplus_token', token);
        currentUser = data.user;
        enterApp();
      } catch (err) {
        $('#login-error').textContent = err.message;
      }
    });

    // Register
    $('#register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#register-error').textContent = '';
      try {
        const data = await api('/auth/register', 'POST', {
          username: $('#reg-username').value,
          password: $('#reg-password').value,
          displayName: $('#reg-display').value || undefined,
          email: $('#reg-email').value || undefined
        });
        token = data.token;
        localStorage.setItem('vcplus_token', token);
        currentUser = data.user;
        enterApp();
      } catch (err) {
        $('#register-error').textContent = err.message;
      }
    });
  }

  // ─── Enter App ───
  async function enterApp() {
    showScreen('app');
    updateUserBar();
    connectSocket();
    await loadGuilds();
    showView('home');
  }

  function updateUserBar() {
    $('#user-display-name').textContent = currentUser.display_name;
    $('#user-tag').textContent = `@${currentUser.username}`;
  }

  // ─── Socket ───
  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => {
      console.log('[App] Socket connected');
      // Re-join guild rooms
      guilds.forEach(g => socket.emit('guild:join-room', { guildId: g.id }));
    });

    socket.on('message:new', (msg) => {
      if (currentChannel && msg.channel_id === currentChannel.id) {
        appendMessage(msg);
        scrollChat();
      }
    });

    socket.on('message:typing', (data) => {
      if (currentChannel && data.channelId === currentChannel.id) {
        showTyping(data.user.display_name);
      }
    });

    socket.on('user:status', (data) => {
      // Update member list if visible
      if (currentGuild && guildData[currentGuild.id]) {
        const members = guildData[currentGuild.id].members;
        const m = members?.find(m => m.id === data.userId);
        if (m) {
          m.status = data.status;
          renderMembers();
        }
      }
    });

    socket.on('voice:state', (data) => {
      voiceChannelStates[data.channelId] = data.users;
      renderVoiceUsers(data.channelId);
    });

    socket.on('stream:started', (data) => {
      activeStreams[data.channelId] = data;
      if (currentGuild) renderChannels();
    });

    socket.on('stream:stopped', (data) => {
      delete activeStreams[data.channelId];
      if (currentGuild) renderChannels();
    });

    socket.on('stream:obs-live', (data) => {
      activeStreams[`obs-${data.userId}`] = { ...data, type: 'obs' };
    });

    socket.on('stream:obs-stopped', (data) => {
      delete activeStreams[`obs-${data.userId}`];
    });

    // Init engines
    voiceEngine = new VoiceEngine(socket, currentUser.id);
    streamEngine = new StreamingEngine(socket, currentUser.id);

    voiceEngine.onVoiceActivity = (userId, speaking) => {
      // Update voice user visual
      const el = document.querySelector(`.voice-user-item[data-user-id="${userId}"]`);
      if (el) {
        el.classList.toggle('speaking', speaking);
      }
    };
  }

  // ─── Guilds ───
  async function loadGuilds() {
    const data = await api('/guilds');
    guilds = data.guilds;
    renderGuildList();
  }

  function renderGuildList() {
    const list = $('#guild-list');
    // Keep the home button and separator
    const homeBtn = list.querySelector('.guild-item.home');
    const sep = list.querySelector('.guild-separator');
    list.innerHTML = '';
    list.appendChild(homeBtn);
    list.appendChild(sep);

    guilds.forEach(guild => {
      const el = document.createElement('div');
      el.className = 'guild-item';
      el.dataset.guildId = guild.id;
      el.title = guild.name;
      const initials = guild.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      el.innerHTML = `<span class="guild-initial">${initials}</span>`;
      el.addEventListener('click', () => selectGuild(guild.id));
      list.appendChild(el);
    });
  }

  async function selectGuild(guildId) {
    // Update active state
    $$('.guild-item').forEach(g => g.classList.remove('active'));
    const guildEl = $(`.guild-item[data-guild-id="${guildId}"]`);
    if (guildEl) guildEl.classList.add('active');
    $$('.guild-item.home').forEach(g => g.classList.remove('active'));

    // Load guild data
    if (!guildData[guildId]) {
      const data = await api(`/guilds/${guildId}`);
      guildData[guildId] = data;
    }

    currentGuild = guildData[guildId].guild;
    $('#guild-name-display').textContent = currentGuild.name;
    $('#guild-settings-btn').style.display = (currentGuild.owner_id === currentUser.id) ? '' : 'none';

    // Join guild room
    socket.emit('guild:join-room', { guildId });

    renderChannels();
    renderMembers();

    // Select first text channel
    const textChannels = guildData[guildId].channels.filter(c => c.type === 'text');
    if (textChannels.length > 0) {
      selectChannel(textChannels[0]);
    }

    closeMobileMenu();
  }

  function renderChannels() {
    const list = $('#channel-list');
    list.innerHTML = '';

    if (!currentGuild) {
      list.innerHTML = '<div id="home-view" class="home-view"></div>';
      return;
    }

    const data = guildData[currentGuild.id];
    if (!data) return;

    const textChannels = data.channels.filter(c => c.type === 'text');
    const voiceChannels = data.channels.filter(c => c.type === 'voice');

    // Text channels
    if (textChannels.length > 0) {
      const cat = document.createElement('div');
      cat.className = 'channel-category';
      cat.innerHTML = `<i class="fas fa-chevron-down" style="font-size:8px;"></i> KANAŁY TEKSTOWE`;
      list.appendChild(cat);

      textChannels.forEach(ch => {
        const el = document.createElement('div');
        el.className = `channel-item${currentChannel && currentChannel.id === ch.id ? ' active' : ''}`;
        el.dataset.channelId = ch.id;
        el.innerHTML = `<i class="fas fa-hashtag"></i> <span>${ch.name}</span>`;
        el.addEventListener('click', () => selectChannel(ch));
        list.appendChild(el);
      });
    }

    // Voice channels
    if (voiceChannels.length > 0) {
      const cat = document.createElement('div');
      cat.className = 'channel-category';
      cat.innerHTML = `<i class="fas fa-chevron-down" style="font-size:8px;"></i> KANAŁY GŁOSOWE`;
      list.appendChild(cat);

      voiceChannels.forEach(ch => {
        const el = document.createElement('div');
        const inVoice = voiceEngine && voiceEngine.currentChannelId === ch.id;
        el.className = `channel-item${inVoice ? ' active' : ''}`;
        el.dataset.channelId = ch.id;

        let icon = 'fa-volume-up';
        let extra = '';
        const streamInfo = activeStreams[ch.id];
        if (streamInfo) {
          icon = 'fa-broadcast-tower';
          extra = `<span class="stream-live-badge" style="font-size:10px; padding:1px 6px; margin-left:auto;"><i class="fas fa-circle"></i> LIVE</span>`;
        }

        el.innerHTML = `<i class="fas ${icon}"></i> <span>${ch.name}</span>${extra}`;
        el.addEventListener('click', () => joinVoiceChannel(ch));
        list.appendChild(el);

        // Show "Watch stream" button if someone is streaming on this channel
        if (streamInfo && streamInfo.userId !== currentUser.id) {
          const watchBtn = document.createElement('div');
          watchBtn.className = 'channel-item';
          watchBtn.style.cssText = 'padding-left:32px; color:var(--red); font-size:13px; gap:6px;';
          watchBtn.innerHTML = `<i class="fas fa-eye"></i> <span>Oglądaj stream</span>`;
          watchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _watchStream(ch.id, streamInfo);
          });
          list.appendChild(watchBtn);
        }

        // Show users in voice channel
        renderVoiceUsers(ch.id, list);
      });
    }

    // Add channel button (for owner)
    if (currentGuild.owner_id === currentUser.id) {
      const addBtn = document.createElement('div');
      addBtn.className = 'channel-item';
      addBtn.style.color = 'var(--text-muted)';
      addBtn.innerHTML = `<i class="fas fa-plus"></i> <span>Dodaj kanał</span>`;
      addBtn.addEventListener('click', () => showCreateChannelModal());
      list.appendChild(addBtn);
    }
  }

  function renderVoiceUsers(channelId, parent) {
    const container = parent || $('#channel-list');
    // Remove existing voice user list for this channel
    const existing = container.querySelector(`.voice-user-list[data-channel="${channelId}"]`);
    if (existing) existing.remove();

    const users = voiceChannelStates[channelId];
    if (!users || users.length === 0) return;

    const userList = document.createElement('div');
    userList.className = 'voice-user-list';
    userList.dataset.channel = channelId;

    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'voice-user-item';
      item.dataset.userId = u.userId;

      let indicators = '';
      if (u.muted) indicators += '<i class="fas fa-microphone-slash muted"></i>';
      if (u.deafened) indicators += '<i class="fas fa-headphones-alt muted"></i>';

      const initial = (u.display_name || u.username || '?')[0].toUpperCase();
      item.innerHTML = `
        <div class="avatar-tiny">${initial}</div>
        <span>${u.display_name || u.username}</span>
        <div class="voice-indicators">${indicators}</div>
      `;
      userList.appendChild(item);
    });

    // Insert after the channel item
    const channelItem = container.querySelector(`.channel-item[data-channel-id="${channelId}"]`);
    if (channelItem) {
      channelItem.after(userList);
    }
  }

  // ─── Channel Selection ───
  async function selectChannel(channel) {
    currentChannel = channel;

    $$('.channel-item').forEach(c => {
      if (c.dataset.channelId === channel.id) c.classList.add('active');
      else if (channel.type === 'text') {
        // Only deactivate text channel highlights, keep voice active separately
        const isVoice = voiceEngine && voiceEngine.currentChannelId === c.dataset.channelId;
        if (!isVoice) c.classList.remove('active');
      }
    });

    showView('chat');
    const chatName = document.getElementById('chat-channel-name');
    const welcomeName = document.getElementById('welcome-channel-name');
    const chatMsgs = document.getElementById('chat-messages');
    if (chatName) chatName.textContent = channel.name;
    if (welcomeName) welcomeName.textContent = `#${channel.name}`;
    if (chatMsgs) chatMsgs.innerHTML = `<div class="chat-welcome"><h2>Witaj na kanale #${escapeHtml(channel.name)}</h2><p>To jest początek tego kanału.</p></div>`;

    // Load messages
    try {
      const data = await api(`/channels/${channel.id}/messages`);
      renderMessages(data.messages);
    } catch (e) {
      console.error('[App] Failed to load messages:', e);
    }

    closeMobileMenu();
  }

  // ─── Messages ───
  function renderMessages(messages) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = `<div class="chat-welcome"><h2>Witaj na kanale #${escapeHtml(currentChannel.name)}</h2><p>To jest początek tego kanału.</p></div>`;

    let lastUserId = null;
    let lastTime = null;

    messages.forEach(msg => {
      const isGroupStart = msg.user_id !== lastUserId ||
        (lastTime && new Date(msg.created_at) - new Date(lastTime) > 5 * 60 * 1000);

      appendMessage(msg, isGroupStart);
      lastUserId = msg.user_id;
      lastTime = msg.created_at;
    });

    scrollChat();
  }

  function appendMessage(msg, forceGroupStart = true) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = `message${forceGroupStart ? ' message-group-start' : ''}`;
    div.dataset.messageId = msg.id;

    const time = new Date(msg.created_at);
    const timeStr = time.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const dateStr = time.toLocaleDateString('pl-PL');

    const initial = (msg.display_name || msg.username || '?')[0].toUpperCase();
    const colors = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f47b67', '#3ba55c'];
    const colorIdx = msg.username ? msg.username.charCodeAt(0) % colors.length : 0;

    if (forceGroupStart) {
      div.innerHTML = `
        <div class="message-avatar" style="background:${colors[colorIdx]}">${initial}</div>
        <div class="message-header">
          <span class="message-author" style="color:${colors[colorIdx]}">${escapeHtml(msg.display_name || msg.username)}</span>
          <span class="message-timestamp">${dateStr} ${timeStr}</span>
        </div>
        <div class="message-content">${formatMessage(msg.content)}</div>
      `;
    } else {
      div.innerHTML = `<div class="message-content">${formatMessage(msg.content)}</div>`;
    }

    container.appendChild(div);
  }

  function formatMessage(text) {
    text = escapeHtml(text);
    // Bold **text**
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Code `text`
    text = text.replace(/`(.*?)`/g, '<code>$1</code>');
    // URLs
    text = text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // Newlines
    text = text.replace(/\n/g, '<br>');
    return text;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function scrollChat() {
    const container = $('#chat-messages');
    container.scrollTop = container.scrollHeight;
  }

  function showTyping(name) {
    const el = $('#chat-typing');
    el.textContent = `${name} pisze...`;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { el.textContent = ''; }, 3000);
  }

  // ─── Voice ───
  async function joinVoiceChannel(channel) {
    if (voiceEngine && voiceEngine.currentChannelId === channel.id) return;

    // Leave current if any
    if (voiceEngine && voiceEngine.currentChannelId) {
      voiceEngine.leave();
    }

    try {
      const settings = getAudioSettings();
      await voiceEngine.join(channel.id, settings);

      // Attach audio visualizer to the processor
      if (audioVisualizer && voiceEngine.audioProcessor) {
        audioVisualizer.attach(voiceEngine.audioProcessor);
      }

      // Update UI
      $('#voice-status-bar').style.display = '';
      $('#voice-channel-name').textContent = channel.name;
      updateVoiceButtons();

      renderChannels();
    } catch (err) {
      alert('Nie udało się dołączyć do kanału głosowego. Sprawdź uprawnienia mikrofonu.');
    }
  }

  function updateVoiceButtons() {
    if (!voiceEngine) return;
    const muteBtn = $('#voice-mute-btn');
    const deafBtn = $('#voice-deaf-btn');

    if (voiceEngine.isMuted) {
      muteBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
      muteBtn.classList.add('muted');
    } else {
      muteBtn.innerHTML = '<i class="fas fa-microphone"></i>';
      muteBtn.classList.remove('muted');
    }

    if (voiceEngine.isDeafened) {
      deafBtn.innerHTML = '<i class="fas fa-headphones-alt"></i>';
      deafBtn.classList.add('muted');
    } else {
      deafBtn.innerHTML = '<i class="fas fa-headphones"></i>';
      deafBtn.classList.remove('muted');
    }
  }

  function getAudioSettings() {
    return {
      noiseSuppression: $('#setting-noise-suppression')?.checked !== false,
      echoCancellation: $('#setting-echo-cancel')?.checked !== false,
      autoGainControl: $('#setting-auto-gain')?.checked !== false,
      keyboardFilter: $('#setting-keyboard-filter')?.checked !== false,
      noiseGateThreshold: parseInt($('#setting-noise-gate')?.value || -50)
    };
  }

  // ─── Members ───
  function renderMembers() {
    const list = $('#members-list');
    list.innerHTML = '';

    if (!currentGuild || !guildData[currentGuild.id]) return;

    const members = guildData[currentGuild.id].members;
    const online = members.filter(m => m.status === 'online');
    const offline = members.filter(m => m.status !== 'online');

    if (online.length > 0) {
      const cat = document.createElement('div');
      cat.className = 'member-category';
      cat.textContent = `ONLINE — ${online.length}`;
      list.appendChild(cat);
      online.forEach(m => list.appendChild(createMemberItem(m)));
    }

    if (offline.length > 0) {
      const cat = document.createElement('div');
      cat.className = 'member-category';
      cat.textContent = `OFFLINE — ${offline.length}`;
      list.appendChild(cat);
      offline.forEach(m => list.appendChild(createMemberItem(m)));
    }
  }

  function createMemberItem(member) {
    const div = document.createElement('div');
    div.className = 'member-item';

    const initial = (member.display_name || member.username || '?')[0].toUpperCase();
    const colors = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f47b67', '#3ba55c'];
    const colorIdx = member.username.charCodeAt(0) % colors.length;

    div.innerHTML = `
      <div class="member-avatar" style="background:${colors[colorIdx]}">
        ${initial}
        <span class="status-dot ${member.status === 'online' ? 'online' : 'offline'}"></span>
      </div>
      <span class="member-name">${escapeHtml(member.display_name)}</span>
      ${member.role === 'owner' ? '<span class="member-role">Właściciel</span>' : ''}
      ${member.role === 'admin' ? '<span class="member-role" style="background:var(--green)">Admin</span>' : ''}
    `;
    return div;
  }

  // ─── Views ───
  function showView(name) {
    document.querySelectorAll('#main-content > .view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${name}`);
    if (target) target.classList.add('active');

    // Show/hide home nav
    if (name === 'home' || name === 'settings' || name === 'admin') {
      $('#channel-list').innerHTML = '';
      const homeView = document.createElement('div');
      homeView.className = 'home-view';
      homeView.innerHTML = `
        <div class="home-section">
          <div class="home-item${name === 'home' ? ' active' : ''}" id="nav-friends"><i class="fas fa-user-friends"></i> Znajomi</div>
          <div class="home-item" id="nav-streams"><i class="fas fa-broadcast-tower"></i> Streamy</div>
          <div class="home-item${name === 'settings' ? ' active' : ''}" id="nav-settings"><i class="fas fa-cog"></i> Ustawienia</div>
          ${currentUser && currentUser.is_admin ? `<div class="home-item${name === 'admin' ? ' active' : ''}" id="nav-admin"><i class="fas fa-shield-alt"></i> Panel Admina</div>` : ''}
        </div>
      `;
      $('#channel-list').appendChild(homeView);
      rebindHomeNav();
    }
  }

  function rebindHomeNav() {
    $('#nav-friends')?.addEventListener('click', () => showView('home'));
    $('#nav-streams')?.addEventListener('click', () => showStreamsView());
    $('#nav-settings')?.addEventListener('click', () => showSettingsView());
    $('#nav-admin')?.addEventListener('click', () => showAdminView());
  }

  // ─── Settings ───
  function showSettingsView() {
    showView('settings');
    $('#settings-display-name').value = currentUser.display_name;
    $('#stream-key-input').value = currentUser.stream_key || '';

    // Load audio devices
    loadAudioDevices();

    // Noise gate display
    const noiseGate = $('#setting-noise-gate');
    const noiseGateVal = $('#noise-gate-value');
    noiseGate.addEventListener('input', () => {
      noiseGateVal.textContent = `${noiseGate.value} dB`;
      if (voiceEngine) {
        voiceEngine.updateAudioSettings({ noiseGateThreshold: parseInt(noiseGate.value) });
      }
    });
  }

  async function loadAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const micSelect = $('#setting-mic-device');
      const spkSelect = $('#setting-speaker-device');

      micSelect.innerHTML = '';
      spkSelect.innerHTML = '';

      devices.forEach(d => {
        if (d.kind === 'audioinput') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Mikrofon ${micSelect.options.length + 1}`;
          micSelect.appendChild(opt);
        }
        if (d.kind === 'audiooutput') {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || `Głośnik ${spkSelect.options.length + 1}`;
          spkSelect.appendChild(opt);
        }
      });
    } catch (e) {
      console.warn('[App] Cannot enumerate devices:', e);
    }
  }

  // ─── Streams view ───
  function showStreamsView() {
    showView('home');
    const content = $('#view-home .home-content');
    if (!content) return;
    content.innerHTML = `
      <div style="text-align:center; padding: 40px; width:100%;">
        <i class="fas fa-broadcast-tower" style="font-size:48px; color:var(--brand-primary); margin-bottom:16px;"></i>
        <h2>Aktywne Streamy</h2>
        <div id="streams-list" style="margin-top:20px; text-align:left; max-width:600px; margin-left:auto; margin-right:auto;"></div>
        <div style="margin-top:24px; text-align:left; max-width:600px; margin-left:auto; margin-right:auto;">
          <h3 style="margin-bottom:12px; font-size:16px;">Streamy na kanałach głosowych</h3>
          <div id="channel-streams-list"></div>
        </div>
      </div>
    `;

    // OBS / DB streams
    api('/streams/live').then(data => {
      const list = content.querySelector('#streams-list');
      if (!list) return;
      if (data.streams.length === 0) {
        list.innerHTML = '<p style="color:var(--text-muted);">Brak aktywnych streamów z OBS</p>';
      } else {
        data.streams.forEach(s => {
          const card = document.createElement('div');
          card.style.cssText = 'background:var(--bg-secondary); padding:16px; border-radius:8px; margin:8px 0; cursor:pointer; display:flex; align-items:center; gap:12px;';
          card.innerHTML = `
            <i class="fas fa-broadcast-tower" style="color:var(--red); font-size:20px;"></i>
            <div style="flex:1;">
              <strong>${escapeHtml(s.display_name)}</strong> — ${escapeHtml(s.title)}
            </div>
            <span class="stream-live-badge"><i class="fas fa-circle"></i> LIVE</span>
          `;
          card.addEventListener('click', () => {
            _watchStream(s.channel_id, {
              userId: s.user_id,
              username: s.display_name,
              title: s.title,
              type: s.type,
              flvUrl: s.flvUrl
            });
          });
          list.appendChild(card);
        });
      }
    }).catch(e => console.error('[Streams] Error loading live streams:', e));

    // Channel-based active streams (WebRTC browser shares)
    const chList = content.querySelector('#channel-streams-list');
    if (!chList) return;
    const streamEntries = Object.entries(activeStreams);
    if (streamEntries.length === 0) {
      chList.innerHTML = '<p style="color:var(--text-muted);">Brak aktywnych streamów na kanałach</p>';
    } else {
      streamEntries.forEach(([channelId, stream]) => {
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-secondary); padding:12px 16px; border-radius:8px; margin:6px 0; cursor:pointer; display:flex; align-items:center; gap:12px;';
        card.innerHTML = `
          <i class="fas fa-desktop" style="color:var(--brand-primary); font-size:18px;"></i>
          <div style="flex:1;">
            <strong>${escapeHtml(stream.username || 'Ktoś')}</strong> streamuje
            <span style="color:var(--text-muted);"> — ${escapeHtml(stream.title || 'Screen Share')}</span>
          </div>
          <span class="stream-live-badge"><i class="fas fa-circle"></i> LIVE</span>
        `;
        card.addEventListener('click', () => _watchStream(channelId, stream));
        chList.appendChild(card);
      });
    }
  }

  // ─── Watch / Stop watching stream ───
  function _watchStream(channelId, streamInfo) {
    showView('stream');
    const title = document.getElementById('stream-title');
    if (title) title.textContent = streamInfo.title || `Stream — ${streamInfo.username || ''}`;

    if (streamInfo.type === 'obs' && streamInfo.flvUrl) {
      streamEngine.watchOBSStream(streamInfo.flvUrl);
    } else {
      streamEngine.watchStream(channelId);
    }
  }

  function _stopWatching() {
    if (streamEngine) streamEngine.stopWatching();
    // Go back to chat or home
    if (currentChannel) {
      showView('chat');
    } else {
      showView('home');
    }
  }

  // ─── Admin ───
  async function showAdminView() {
    showView('admin');
    try {
      const [stats, users, guildsData] = await Promise.all([
        api('/admin/stats'),
        api('/admin/users'),
        api('/admin/guilds')
      ]);

      $('#stat-users').textContent = stats.userCount;
      $('#stat-guilds').textContent = stats.guildCount;
      $('#stat-messages').textContent = stats.messageCount;
      $('#stat-online').textContent = stats.onlineCount;

      // Users table
      const tbody = $('#admin-users-body');
      tbody.innerHTML = '';
      users.users.forEach(u => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(u.display_name)}</strong><br><small>@${escapeHtml(u.username)}</small></td>
          <td>${u.email || '—'}</td>
          <td><span class="status-dot ${u.status === 'online' ? 'online' : 'offline'}" style="display:inline-block;position:static;border:none;width:8px;height:8px;"></span> ${u.status}</td>
          <td>${u.is_admin ? '✅' : '—'}</td>
          <td>${u.id !== currentUser.id ? `<button class="btn btn-sm btn-danger" onclick="window._adminDeleteUser('${u.id}')">Usuń</button>` : '—'}</td>
        `;
        tbody.appendChild(tr);
      });

      // Guilds table
      const gbody = $('#admin-guilds-body');
      gbody.innerHTML = '';
      guildsData.guilds.forEach(g => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeHtml(g.name)}</td>
          <td>@${escapeHtml(g.owner_username)}</td>
          <td>${g.member_count}</td>
          <td><code>${g.invite_code}</code></td>
          <td><button class="btn btn-sm btn-danger" onclick="window._adminDeleteGuild('${g.id}')">Usuń</button></td>
        `;
        gbody.appendChild(tr);
      });

    } catch (e) {
      console.error('[Admin] Error:', e);
    }
  }

  window._adminDeleteUser = async (userId) => {
    if (!confirm('Czy na pewno chcesz usunąć tego użytkownika?')) return;
    await api(`/admin/users/${userId}`, 'DELETE');
    showAdminView();
  };

  window._adminDeleteGuild = async (guildId) => {
    if (!confirm('Czy na pewno chcesz usunąć ten serwer?')) return;
    await api(`/admin/guilds/${guildId}`, 'DELETE');
    showAdminView();
    await loadGuilds();
  };

  // ─── Modals ───
  function showModal(html) {
    $('#modal-content').innerHTML = html;
    $('#modal-overlay').style.display = '';
  }

  function closeModal() {
    $('#modal-overlay').style.display = 'none';
    $('#modal-content').innerHTML = '';
  }

  function showCreateGuildModal() {
    showModal(`
      <h3>Utwórz lub dołącz do serwera</h3>
      <div class="auth-tabs" style="margin-bottom:16px;">
        <button class="auth-tab active" onclick="this.parentElement.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));this.classList.add('active');document.getElementById('modal-create').style.display='';document.getElementById('modal-join').style.display='none';">Utwórz</button>
        <button class="auth-tab" onclick="this.parentElement.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));this.classList.add('active');document.getElementById('modal-create').style.display='none';document.getElementById('modal-join').style.display='';">Dołącz</button>
      </div>
      <div id="modal-create">
        <div class="form-group">
          <label>Nazwa serwera</label>
          <input type="text" id="new-guild-name" placeholder="Mój Serwer">
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="window._closeModal()">Anuluj</button>
          <button class="btn btn-primary" style="width:auto;" onclick="window._createGuild()">Utwórz</button>
        </div>
      </div>
      <div id="modal-join" style="display:none;">
        <div class="form-group">
          <label>Kod zaproszenia</label>
          <input type="text" id="join-invite-code" placeholder="np. a1b2c3d4">
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" onclick="window._closeModal()">Anuluj</button>
          <button class="btn btn-primary" style="width:auto;" onclick="window._joinGuild()">Dołącz</button>
        </div>
      </div>
    `);
  }

  window._closeModal = closeModal;

  window._createGuild = async () => {
    const name = $('#new-guild-name').value.trim();
    if (!name) return;
    try {
      const data = await api('/guilds', 'POST', { name });
      closeModal();
      await loadGuilds();

      // Show invite code
      showModal(`
        <h3>Serwer utworzony! 🎉</h3>
        <p>Twój kod zaproszenia:</p>
        <div class="invite-code" onclick="navigator.clipboard.writeText('${data.guild.invite_code}')" title="Kliknij aby skopiować">${data.guild.invite_code}</div>
        <p class="form-help">Kliknij kod aby skopiować. Udostępnij go znajomym!</p>
        <div class="modal-actions">
          <button class="btn btn-primary" style="width:auto;" onclick="window._closeModal()">OK</button>
        </div>
      `);

      selectGuild(data.guild.id);
    } catch (e) {
      alert(e.message);
    }
  };

  window._joinGuild = async () => {
    const code = $('#join-invite-code').value.trim();
    if (!code) return;
    try {
      await api('/guilds/join', 'POST', { inviteCode: code });
      closeModal();
      await loadGuilds();
    } catch (e) {
      alert(e.message);
    }
  };

  function showCreateChannelModal() {
    showModal(`
      <h3>Nowy kanał</h3>
      <div class="form-group">
        <label>Nazwa</label>
        <input type="text" id="new-channel-name" placeholder="nowy-kanał">
      </div>
      <div class="form-group">
        <label>Typ</label>
        <select id="new-channel-type">
          <option value="text">📝 Tekstowy</option>
          <option value="voice">🔊 Głosowy</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="window._closeModal()">Anuluj</button>
        <button class="btn btn-primary" style="width:auto;" onclick="window._createChannel()">Utwórz</button>
      </div>
    `);
  }

  window._createChannel = async () => {
    const name = $('#new-channel-name').value.trim();
    const type = $('#new-channel-type').value;
    if (!name || !currentGuild) return;
    try {
      const data = await api(`/guilds/${currentGuild.id}/channels`, 'POST', { name, type });
      closeModal();
      // Refresh guild data
      const gData = await api(`/guilds/${currentGuild.id}`);
      guildData[currentGuild.id] = gData;
      renderChannels();
    } catch (e) {
      alert(e.message);
    }
  };

  // ─── Mobile ───
  function closeMobileMenu() {
    mobileMenuOpen = false;
    $('#guild-sidebar').classList.remove('open');
    $('#channel-sidebar').classList.remove('open');
    document.querySelector('.sidebar-backdrop')?.classList.remove('active');
  }

  // ─── Setup App UI Listeners ───
  function setupAppUI() {
    // Chat form
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text || !currentChannel) return;
      socket.emit('message:send', { channelId: currentChannel.id, content: text });
      input.value = '';
    });

    // Typing indicator
    $('#chat-input').addEventListener('input', () => {
      if (currentChannel) {
        socket.emit('message:typing', { channelId: currentChannel.id });
      }
    });

    // Home button
    $('.guild-item.home').addEventListener('click', () => {
      $$('.guild-item').forEach(g => g.classList.remove('active'));
      $('.guild-item.home').classList.add('active');
      currentGuild = null;
      currentChannel = null;
      $('#guild-name-display').textContent = 'VC+';
      $('#guild-settings-btn').style.display = 'none';
      showView('home');
    });

    // Add guild
    $('#add-guild-btn').addEventListener('click', showCreateGuildModal);

    // Voice controls
    $('#voice-mute-btn').addEventListener('click', () => {
      if (voiceEngine) {
        voiceEngine.toggleMute();
        updateVoiceButtons();
      }
    });

    $('#voice-deaf-btn').addEventListener('click', () => {
      if (voiceEngine) {
        voiceEngine.toggleDeafen();
        updateVoiceButtons();
      }
    });

    $('#voice-disconnect-btn').addEventListener('click', () => {
      if (voiceEngine) {
        voiceEngine.leave();
        if (audioVisualizer) audioVisualizer.detach();
        $('#voice-status-bar').style.display = 'none';
        renderChannels();
      }
    });

    // Screen share from voice
    $('#voice-screen-btn').addEventListener('click', async () => {
      if (!voiceEngine || !voiceEngine.currentChannelId) return;

      if (streamEngine.isStreaming) {
        streamEngine.stopStream();
      } else {
        try {
          await streamEngine.startBrowserStream(voiceEngine.currentChannelId, {
            title: `${currentUser.display_name}'s Screen`
          });
        } catch (e) {
          console.warn('[Stream] User cancelled screen share');
        }
      }
    });

    // Toggle members sidebar
    $('#toggle-members-btn').addEventListener('click', () => {
      membersVisible = !membersVisible;
      $('#members-sidebar').classList.toggle('hidden', !membersVisible);
      $('#toggle-members-btn').classList.toggle('active', membersVisible);
    });

    // Audio mixer toggle
    $('#toggle-audio-panel').addEventListener('click', () => {
      const panel = $('#audio-mixer-panel');
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
      updateMixerUI();
    });

    $('#close-mixer').addEventListener('click', () => {
      $('#audio-mixer-panel').style.display = 'none';
    });

    // Mixer master volume
    $('#mixer-master').addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      e.target.nextElementSibling.textContent = `${val}%`;
      if (voiceEngine) {
        voiceEngine.setMasterVolume(val / 100);
      }
    });

    // Settings actions
    $('#save-profile-btn')?.addEventListener('click', async () => {
      try {
        const data = await api('/auth/profile', 'PUT', {
          display_name: $('#settings-display-name').value
        });
        currentUser = data.user;
        updateUserBar();
        alert('Profil zapisany!');
      } catch (e) {
        alert(e.message);
      }
    });

    $('#copy-stream-key')?.addEventListener('click', () => {
      const key = $('#stream-key-input').value;
      navigator.clipboard.writeText(key).then(() => alert('Skopiowano klucz!'));
    });

    $('#regen-stream-key')?.addEventListener('click', async () => {
      if (!confirm('Wygenerować nowy klucz streamu? Stary przestanie działać.')) return;
      const data = await api('/stream/key/regenerate', 'POST');
      currentUser.stream_key = data.streamKey;
      $('#stream-key-input').value = data.streamKey;
    });

    $('#logout-btn')?.addEventListener('click', () => {
      token = null;
      localStorage.removeItem('vcplus_token');
      if (voiceEngine) voiceEngine.destroy();
      if (streamEngine) streamEngine.destroy();
      if (socket) socket.disconnect();
      location.reload();
    });

    // Audio settings changes apply live
    ['setting-noise-suppression', 'setting-keyboard-filter', 'setting-echo-cancel', 'setting-auto-gain'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          if (voiceEngine) {
            voiceEngine.updateAudioSettings(getAudioSettings());
          }
        });
      }
    });

    // Test audio button
    $('#test-audio-btn')?.addEventListener('click', async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        osc.frequency.value = 440;
        osc.connect(audioCtx.destination);
        osc.start();
        setTimeout(() => {
          osc.stop();
          audioCtx.close();
          stream.getTracks().forEach(t => t.stop());
        }, 500);
      } catch (e) {
        alert('Nie udało się przetestować audio');
      }
    });

    // Mobile menu
    $('#mobile-menu-btn').addEventListener('click', () => {
      mobileMenuOpen = !mobileMenuOpen;
      $('#guild-sidebar').classList.toggle('open', mobileMenuOpen);
      $('#channel-sidebar').classList.toggle('open', mobileMenuOpen);

      let backdrop = document.querySelector('.sidebar-backdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'sidebar-backdrop';
        backdrop.addEventListener('click', closeMobileMenu);
        document.body.appendChild(backdrop);
      }
      backdrop.classList.toggle('active', mobileMenuOpen);
    });

    // Modal overlay click to close
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModal();
    });

    // Stream back button
    const streamBackBtn = document.getElementById('stream-back-btn');
    if (streamBackBtn) {
      streamBackBtn.addEventListener('click', () => _stopWatching());
    }

    // Guild settings button
    $('#guild-settings-btn').addEventListener('click', () => {
      if (!currentGuild) return;
      showModal(`
        <h3>Ustawienia serwera</h3>
        <div class="form-group">
          <label>Kod zaproszenia</label>
          <div class="invite-code" onclick="navigator.clipboard.writeText('${currentGuild.invite_code}')" title="Kliknij aby skopiować">${currentGuild.invite_code}</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-danger" onclick="window._deleteGuild('${currentGuild.id}')">Usuń serwer</button>
          <button class="btn btn-secondary" onclick="window._closeModal()">Zamknij</button>
        </div>
      `);
    });

    window._deleteGuild = async (guildId) => {
      if (!confirm('Czy na pewno chcesz usunąć ten serwer? Tej operacji nie można cofnąć!')) return;
      await api(`/guilds/${guildId}`, 'DELETE');
      closeModal();
      currentGuild = null;
      currentChannel = null;
      delete guildData[guildId];
      await loadGuilds();
      showView('home');
    };

    // Audio settings button
    $('#audio-settings-btn')?.addEventListener('click', () => {
      showSettingsView();
      // Switch to home/settings mode
      $$('.guild-item').forEach(g => g.classList.remove('active'));
      $('.guild-item.home').classList.add('active');
      currentGuild = null;
      currentChannel = null;
      $('#guild-name-display').textContent = 'VC+';
    });

    // Keyboard shortcut: Escape to close modals / stop stream
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        closeMobileMenu();
        // If watching a stream, stop watching
        const viewStream = document.getElementById('view-stream');
        if (viewStream && viewStream.classList.contains('active')) {
          _stopWatching();
        }
      }
    });

    // Audio Visualizer
    audioVisualizer = new AudioVisualizer('audio-visualizer-panel');
    const avToggle = document.getElementById('av-toggle-btn');
    if (avToggle) {
      avToggle.addEventListener('click', () => {
        const panel = document.getElementById('audio-visualizer-panel');
        const visible = panel && panel.style.display !== 'none';
        if (visible) {
          audioVisualizer.hide();
          avToggle.classList.remove('active');
        } else {
          audioVisualizer.show();
          avToggle.classList.add('active');
          // Re-attach if voice is active
          if (voiceEngine && voiceEngine.audioProcessor && voiceEngine.audioProcessor.context) {
            audioVisualizer.attach(voiceEngine.audioProcessor);
          }
        }
      });
    }
  }

  function updateMixerUI() {
    const usersDiv = $('#mixer-users');
    if (!usersDiv) return;
    usersDiv.innerHTML = '';

    if (!voiceEngine) return;

    const vc = voiceEngine.currentChannelId;
    if (!vc || !voiceChannelStates[vc]) return;

    voiceChannelStates[vc].forEach(u => {
      if (u.userId === currentUser.id) return;

      const div = document.createElement('div');
      div.className = 'mixer-channel';
      div.innerHTML = `
        <label>${escapeHtml(u.display_name || u.username)}</label>
        <input type="range" min="0" max="200" value="100" data-user-id="${u.userId}">
        <span class="mixer-value">100%</span>
      `;

      const slider = div.querySelector('input');
      const label = div.querySelector('.mixer-value');
      slider.addEventListener('input', () => {
        const val = parseInt(slider.value);
        label.textContent = `${val}%`;
        voiceEngine.setUserVolume(u.userId, val / 100);
      });

      usersDiv.appendChild(div);
    });
  }

  // ─── Start ───
  init();

})();
