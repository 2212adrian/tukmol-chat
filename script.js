// script.js (ES module)
'use strict';

import { EmojiButton } from 'https://cdn.jsdelivr.net/npm/@joeattardi/emoji-button@4.6.4/dist/index.min.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@5.1.1/lib/marked.esm.js';

// === GLOBAL STATE ===
let session = null;
const MESSAGE_REACTIONS = {};

// === AUTH + BOOT ===
(async () => {
  if (!window.supabaseClient) {
    alert('Supabase client failed to initialize. Please check the console.');
    return;
  }

  const {
    data: { session: sessionData },
    error,
  } = await window.supabaseClient.auth.getSession();
  session = sessionData;

  if (error) {
    console.error('Error getting session:', error);
    window.location.href = '/login.html';
    return;
  }

  if (!session) {
    window.location.href = '/login.html';
    return;
  }

  initializeApp();
})();

function initializeApp() {
  const ROOM_NAME = 'Tropang Tukmol';
  const CURRENT_USERNAME = session.user.email;

  // pagination / scroll
  let oldestMessage = null;
  let loadingOlder = false;
  const PAGE_SIZE = 20;
  let lastRenderedUserName = null;

  const EMOJI_DICT = window.EMOJI_DICT || [];

  const supabase2 = window.supabaseClient;
  if (!supabase2) {
    console.error(
      'Supabase client not found. Make sure supabase-init.js runs BEFORE this script.',
    );
  }

  // === DOM ELEMENTS ===
  const messagesEl = document.querySelector('.messages-container');
  const messageInput = document.getElementById('messageInput');
  const imageInput = document.getElementById('imageInput');
  const sendBtn = document.getElementById('sendBtn');
  const filePreview = document.getElementById('filePreview');
  const typingIndicator = document.getElementById('typingIndicator');
  const currentUsernameEl = document.getElementById('currentUsername');
  const inputLabelEl = document.getElementById('inputLabel');
  const sendIconEl = document.getElementById('sendIcon');
  const emojiBtn = document.getElementById('emojiBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const emojiSuggestionsEl = document.getElementById('emojiSuggestions');
  const textFieldContainer = document.querySelector('.text-field-container');
  const themeToggle = document.getElementById('themeToggle');

  if (!messagesEl || !messageInput || !sendBtn) {
    console.error('Required chat DOM elements not found.');
    logError('Required chat DOM elements not found.', err);
    return;
  }

  if (currentUsernameEl) currentUsernameEl.textContent = CURRENT_USERNAME;

  // “New messages” button
  const newMsgBtn = document.createElement('div');
  newMsgBtn.id = 'newMessagesBtn';
  newMsgBtn.className = 'new-messages-btn';
  newMsgBtn.textContent = '↓ New Messages';
  newMsgBtn.style.display = 'none';
  messagesEl.appendChild(newMsgBtn);

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function scrollToBottomSmooth() {
    messagesEl.scrollTo({
      top: messagesEl.scrollHeight,
      behavior: 'smooth',
    });
  }

  function isNearBottom() {
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      50
    );
  }

  newMsgBtn.addEventListener('click', () => {
    scrollToBottomSmooth();
    newMsgBtn.style.display = 'none';
  });

  messagesEl.addEventListener('scroll', () => {
    const nearBottom = isNearBottom();
    newMsgBtn.style.display = nearBottom ? 'none' : 'block';

    // infinite scroll up
    if (messagesEl.scrollTop === 0) {
      loadOlderMessages();
    }
  });

  // === Toast helpers ===
  function showToast(text, type = 'info') {
    let bg = 'linear-gradient(to right, #4b6cb7, #182848)';
    if (type === 'success') {
      bg = 'linear-gradient(to right, #00b09b, #96c93d)';
    } else if (type === 'error') {
      bg = 'linear-gradient(to right, #ff5f6d, #ffc371)';
    } else if (type === 'warning') {
      bg = 'linear-gradient(to right, #f7971e, #ffd200)';
    }
    Toastify({
      text,
      duration: 3000,
      gravity: 'top',
      position: 'right',
      close: true,
      stopOnFocus: true,
      style: { background: bg },
    }).showToast();
  }

  function logInfo(message, extra) {
    console.log(message, extra ?? '');
  }

  function logError(message, extra) {
    console.error(message, extra ?? '');
    showToast(String(message), 'error');
  }

  // === BROADCAST CHANNEL ===
  const TYPING_EVENT = 'typing';
  const REACTION_EVENT = 'reaction';

  logInfo('[Chat] Creating channel for room: ' + ROOM_NAME);
  const chatChannel = supabase2.channel(`chat:${ROOM_NAME}`, {
    config: {
      broadcast: { self: true },
    },
  });

  // === HELPERS ===
  function escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return (text || '').replace(/[&<>"']/g, (m) => map[m]);
  }

  function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // === ANTI-SPAM ===
  let sendTimestamps = [];
  let isSendBlocked = false;
  let sendBlockUntil = 0;

  function canSendNow() {
    const now = Date.now();

    if (isSendBlocked && now < sendBlockUntil) {
      const remaining = Math.ceil((sendBlockUntil - now) / 1000);
      showToast(
        `You are sending messages too quickly. Wait ${remaining}s.`,
        'warning',
      );
      return false;
    }

    if (isSendBlocked && now >= sendBlockUntil) {
      isSendBlocked = false;
      sendTimestamps = [];
    }

    sendTimestamps.push(now);

    const WINDOW_MS = 1000;
    sendTimestamps = sendTimestamps.filter((t) => now - t <= WINDOW_MS);

    const LIMIT = 5;
    if (sendTimestamps.length >= LIMIT) {
      isSendBlocked = true;
      sendBlockUntil = now + 10000;
      showToast(
        'You are sending messages too fast. Blocked for 10 seconds.',
        'warning',
      );
      return false;
    }

    return true;
  }

  // === EMOJI SHORTCODES ===
  function replaceShortcodesWithEmoji(text) {
    if (!text || !EMOJI_DICT.length) return text || '';

    return text.replace(/:([a-zA-Z0-9_+-]+):/g, (match) => {
      const lower = match.toLowerCase();
      const found = EMOJI_DICT.find((e) => e.code.toLowerCase() === lower);
      return found ? found.emoji : match;
    });
  }

  function convertShortcodesToEmoji(text) {
    return replaceShortcodesWithEmoji(text || '');
  }

  function searchEmojiSuggestions(query) {
    if (!EMOJI_DICT.length) return [];
    if (!query) return EMOJI_DICT.slice(0, 20);
    const q = query.toLowerCase();
    return EMOJI_DICT.filter((e) => {
      if (e.code && e.code.toLowerCase().includes(q)) return true;
      if (e.description && e.description.toLowerCase().includes(q)) return true;
      if (e.keywords && e.keywords.some((k) => k.toLowerCase().includes(q)))
        return true;
      return false;
    }).slice(0, 20);
  }

  // === EDIT / DELETE TIME LIMITS ===
  function canEdit(msg) {
    const created = new Date(msg.created_at).getTime();
    const now = Date.now();
    return now - created <= 5 * 60 * 1000;
  }

  function canDelete(msg) {
    const created = new Date(msg.created_at).getTime();
    const now = Date.now();
    return now - created <= 60 * 60 * 1000;
  }

  // === REACTIONS CACHE BUILD ===
  function buildReactionsCache(rows) {
    for (const r of rows) {
      if (!MESSAGE_REACTIONS[r.message_id]) {
        MESSAGE_REACTIONS[r.message_id] = {};
      }
      if (!MESSAGE_REACTIONS[r.message_id][r.emoji]) {
        MESSAGE_REACTIONS[r.message_id][r.emoji] = { count: 0, users: [] };
      }
      const bucket = MESSAGE_REACTIONS[r.message_id][r.emoji];
      if (!bucket.users.includes(r.user_name)) {
        bucket.users.push(r.user_name);
        bucket.count += 1;
      }
    }
  }

  // === REACTIONS UI ===
  function renderReactionBarForMessage(messageId, containerEl) {
    containerEl.innerHTML = '';

    const map = MESSAGE_REACTIONS[messageId] || {};

    const reactBtn = document.createElement('button');
    reactBtn.type = 'button';
    reactBtn.className = 'react-main-btn';
    reactBtn.textContent = '🙂 React';

    reactBtn.onclick = (e) => {
      e.stopPropagation();
      openReactionPicker(messageId, containerEl);
    };

    containerEl.appendChild(reactBtn);

    Object.entries(map).forEach(([emoji, info]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip';
      chip.textContent = `${emoji} ${info.count}`;

      chip.onclick = (e) => {
        e.stopPropagation();
        openReactionDetails(messageId, emoji, containerEl);
      };

      containerEl.appendChild(chip);
    });
  }

  function openReactionDetails(messageId, emoji, containerEl) {
    const existing = containerEl.querySelector('.reaction-details-popup');
    if (existing) existing.remove();

    const map = MESSAGE_REACTIONS[messageId] || {};
    const info = map[emoji];
    if (!info || !info.users.length) return;

    const popup = document.createElement('div');
    popup.className = 'reaction-details-popup';

    const header = document.createElement('div');
    header.className = 'reaction-details-header';
    header.textContent = `${emoji} • ${info.count} reaction${
      info.count > 1 ? 's' : ''
    }`;
    popup.appendChild(header);

    const list = document.createElement('div');
    list.className = 'reaction-details-list';

    info.users.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'reaction-details-row';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = user === CURRENT_USERNAME ? 'You' : user;
      row.appendChild(nameSpan);

      if (user === CURRENT_USERNAME) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'reaction-remove-btn';
        removeBtn.textContent = '✕';
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          toggleReaction(messageId, emoji);
          popup.remove();
        };
        row.appendChild(removeBtn);
      }

      list.appendChild(row);
    });

    popup.appendChild(list);
    containerEl.appendChild(popup);
  }

  function openReactionPicker(messageId, containerEl) {
    const existing = containerEl.querySelector('.reaction-picker-popup');
    if (existing) {
      existing.remove();
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'reaction-picker-popup';

    const emojis = ['👍', '❤️', '😂', '😮', '😢', '😡'];
    emojis.forEach((e) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reaction-picker-item';
      btn.textContent = e;
      btn.onclick = (ev) => {
        ev.stopPropagation();
        toggleReaction(messageId, e);
        popup.remove();
      };
      popup.appendChild(btn);
    });

    containerEl.appendChild(popup);
  }

  async function toggleReaction(messageId, emoji) {
    if (!supabase2) return;

    const existingMap = MESSAGE_REACTIONS[messageId] || {};
    const bucket = existingMap[emoji];
    const userAlreadyReacted =
      bucket && bucket.users.includes(CURRENT_USERNAME);

    try {
      if (!userAlreadyReacted) {
        const { error } = await supabase2.from('message_reactions').insert({
          message_id: messageId,
          user_name: CURRENT_USERNAME,
          emoji,
        });

        if (error) throw error;

        await chatChannel.send({
          type: 'broadcast',
          event: REACTION_EVENT,
          payload: {
            message_id: messageId,
            user_name: CURRENT_USERNAME,
            emoji,
            action: 'add',
          },
        });
      } else {
        const { error } = await supabase2
          .from('message_reactions')
          .delete()
          .eq('message_id', messageId)
          .eq('user_name', CURRENT_USERNAME)
          .eq('emoji', emoji);

        if (error) throw error;

        await chatChannel.send({
          type: 'broadcast',
          event: REACTION_EVENT,
          payload: {
            message_id: messageId,
            user_name: CURRENT_USERNAME,
            emoji,
            action: 'remove',
          },
        });
      }
    } catch (err) {
      logError('Reaction toggle error', err);
      showToast('Failed to update reaction.', 'error');
    }
  }

  function applyReactionToCacheAndUI(r) {
    const { message_id, user_name, emoji, action } = r;
    if (!MESSAGE_REACTIONS[message_id]) {
      MESSAGE_REACTIONS[message_id] = {};
    }
    const map = MESSAGE_REACTIONS[message_id];

    if (!map[emoji]) {
      map[emoji] = { count: 0, users: [] };
    }
    const bucket = map[emoji];

    if (action === 'add') {
      if (!bucket.users.includes(user_name)) {
        bucket.users.push(user_name);
        bucket.count += 1;
      }
    } else if (action === 'remove') {
      const idx = bucket.users.indexOf(user_name);
      if (idx !== -1) {
        bucket.users.splice(idx, 1);
        bucket.count = Math.max(0, bucket.count - 1);
      }
      if (bucket.count === 0) {
        delete map[emoji];
      }
    }

    const row = messagesEl.querySelector(`[data-message-id="${message_id}"]`);
    if (row) {
      const bar = row.querySelector('.reaction-bar');
      if (bar) {
        renderReactionBarForMessage(message_id, bar);
      }
    }
  }

  // === MESSAGE RENDERING ===
  function createMessageRow(msg) {
    const isMe = msg.user_name === CURRENT_USERNAME;

    const row = document.createElement('div');
    row.className = 'message-row ' + (isMe ? 'me' : 'other');
    row.dataset.messageId = msg.id;
    row.dataset.createdAt = msg.created_at;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const header = document.createElement('div');
    header.className = 'message-header';

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const usernameSpan = document.createElement('span');
    usernameSpan.className = 'message-username';
    usernameSpan.textContent = msg.user_name || 'Unknown';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = formatTime(msg.created_at);

    meta.appendChild(usernameSpan);
    meta.appendChild(timeSpan);
    header.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (isMe) {
      const editBtn = document.createElement('button');
      editBtn.className = 'message-action-btn edit-btn';
      editBtn.textContent = '✏';
      editBtn.onclick = () => editMessage(msg);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'message-action-btn delete-btn';
      deleteBtn.textContent = '🗑';
      deleteBtn.onclick = () => deleteMessage(msg);

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
    }
    header.appendChild(actions);
    bubble.appendChild(header);

    if (msg.content) {
      const textEl = document.createElement('div');
      textEl.className = 'message-text';
      // Markdown via marked, but escape first to be safe
      const safe = escapeHtml(msg.content);
      textEl.innerHTML = marked.parse(safe);
      bubble.appendChild(textEl);
    }

    if (msg.image_url) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'message-image';

      const img = document.createElement('img');
      img.src = msg.image_url;
      img.alt = 'Image';
      img.loading = 'lazy';
      img.onclick = () => window.open(msg.image_url, '_blank');

      imgWrap.appendChild(img);

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'image-download-btn';
      downloadBtn.type = 'button';
      downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i>';

      downloadBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          const response = await fetch(msg.image_url, { mode: 'cors' });
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          const url = new URL(msg.image_url, window.location.href);
          const pathPart = url.pathname.split('/').pop() || 'image.png';
          a.download = pathPart;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
        } catch (err) {
          logError('Download failed.', err);
          showToast('Download failed.', 'error');
        }
      };

      imgWrap.appendChild(downloadBtn);
      bubble.appendChild(imgWrap);
    }

    const reactionBar = document.createElement('div');
    reactionBar.className = 'reaction-bar';
    reactionBar.dataset.messageId = msg.id;
    renderReactionBarForMessage(msg.id, reactionBar);

    row.appendChild(bubble);
    row.appendChild(reactionBar);

    return row;
  }

  function renderMessage(msg, scroll = true, prepend = false) {
    const row = createMessageRow(msg);

    if (prepend) {
      messagesEl.insertBefore(row, messagesEl.firstChild);
    } else {
      messagesEl.appendChild(row);
    }

    lastRenderedUserName = msg.user_name;
    if (scroll) scrollToBottom();
  }

  // === LOAD INITIAL MESSAGES ===
  async function loadMessages() {
    if (!supabase2) return;
    try {
      const { data, error } = await supabase2
        .from('messages')
        .select('*')
        .eq('room_name', ROOM_NAME)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

      if (error) throw error;

      const rows = data || [];
      messagesEl.innerHTML = '';
      lastRenderedUserName = null;

      rows.reverse().forEach((msg) => renderMessage(msg, false)); // oldest → newest
      scrollToBottom();

      oldestMessage = rows[0] || null;

      const ids = rows.map((m) => m.id);
      if (ids.length) {
        const { data: reactionsData, error: reactionsError } = await supabase2
          .from('message_reactions')
          .select('*')
          .in('message_id', ids);
        if (!reactionsError && reactionsData) {
          buildReactionsCache(reactionsData);
          rows.forEach((msg) => {
            const row = messagesEl.querySelector(
              `[data-message-id="${msg.id}"]`,
            );
            if (row) {
              const bar = row.querySelector('.reaction-bar');
              if (bar) renderReactionBarForMessage(msg.id, bar);
            }
          });
        }
      }
    } catch (err) {
      logError('Load messages error', err);
    }
  }

  // === LOAD OLDER ON SCROLL UP ===
  async function loadOlderMessages() {
    if (!oldestMessage || loadingOlder) return;
    loadingOlder = true;

    try {
      const prevHeight = messagesEl.scrollHeight;

      const { data, error } = await supabase2
        .from('messages')
        .select('*')
        .eq('room_name', ROOM_NAME)
        .lt('created_at', oldestMessage.created_at)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

      if (error) throw error;

      const rows = data || [];
      if (rows.length > 0) {
        oldestMessage = rows[rows.length - 1];

        rows.reverse().forEach((msg) => renderMessage(msg, false, true));

        const ids = rows.map((m) => m.id);
        if (ids.length) {
          const { data: reactionsData, error: reactionsError } = await supabase2
            .from('message_reactions')
            .select('*')
            .in('message_id', ids);
          if (!reactionsError && reactionsData) {
            buildReactionsCache(reactionsData);
            rows.forEach((msg) => {
              const row = messagesEl.querySelector(
                `[data-message-id="${msg.id}"]`,
              );
              if (row) {
                const bar = row.querySelector('.reaction-bar');
                if (bar) renderReactionBarForMessage(msg.id, bar);
              }
            });
          }
        }

        messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight;
      }
    } catch (err) {
      logError('Load older messages error', err);
    } finally {
      loadingOlder = false;
    }
  }

  // === EDIT / DELETE ===
  let editingMessage = null;

  async function editMessage(msg) {
    if (!canEdit(msg)) {
      showToast('You can only edit messages within 5 minutes.', 'warning');
      return;
    }

    editingMessage = msg;
    messageInput.value = msg.content || '';
    messageInput.focus();

    if (inputLabelEl) inputLabelEl.textContent = 'Edit message';
    if (sendIconEl) sendIconEl.textContent = '✔';
    if (cancelEditBtn) cancelEditBtn.style.display = 'flex';
  }

  function cancelEdit() {
    editingMessage = null;
    messageInput.value = '';
    if (inputLabelEl) inputLabelEl.textContent = 'Write a message';
    if (sendIconEl) sendIconEl.textContent = '↵';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
  }

  async function deleteMessage(msg) {
    if (!canDelete(msg)) {
      showToast('You can only delete messages within 1 hour.', 'warning');
      return;
    }

    const ok = confirm('Delete this message?');
    if (!ok) return;

    try {
      const { error } = await supabase2
        .from('messages')
        .delete()
        .eq('id', msg.id);

      if (error) throw error;

      const row = messagesEl.querySelector(`[data-message-id="${msg.id}"]`);
      if (row) row.remove();

      showToast('Message deleted.', 'success');
    } catch (err) {
      logError('Delete error', err);
      showToast(
        'Failed to delete: ' + (err.message || 'Unknown error'),
        'error',
      );
    }
  }

  // === SEND MESSAGE ===
  async function sendMessage() {
    if (!supabase2) return;
    if (!canSendNow()) return;

    const rawText = messageInput.value.trim();
    const file = imageInput.files[0];

    // EDIT MODE
    if (editingMessage) {
      if (!rawText) {
        showToast('Message cannot be empty.', 'warning');
        return;
      }

      const processedText = convertShortcodesToEmoji(rawText);

      try {
        const { data, error } = await supabase2
          .from('messages')
          .update({ content: processedText })
          .eq('id', editingMessage.id)
          .select('*')
          .single();

        if (error) throw error;

        const row = messagesEl.querySelector(
          `[data-message-id="${editingMessage.id}"]`,
        );
        if (row) {
          const textEl = row.querySelector('.message-text');
          if (textEl) {
            const safe = escapeHtml(data.content);
            textEl.innerHTML = marked.parse(safe);
          }
        }

        showToast('Message edited.', 'success');
        cancelEdit();
        return;
      } catch (err) {
        logError('Edit error', err);
        showToast(
          'Failed to edit: ' + (err.message || 'Unknown error'),
          'error',
        );
        return;
      }
    }

    // CREATE MODE
    if (!rawText && !file) return;

    sendBtn.disabled = true;

    try {
      let imageUrl = null;

      if (file) {
        if (file.size > 8 * 1024 * 1024) {
          showToast('Image too large (max 8MB).', 'warning');
          sendBtn.disabled = false;
          return;
        }

        filePreview.textContent = 'Uploading image...';
        showToast('Uploading image...', 'info');

        const fileName = `${Date.now()}-${file.name}`;
        logInfo(
          '[Chat] Uploading to bucket chat-images. File name: ' + fileName,
        );

        const { data: uploadData, error: uploadError } = await supabase2.storage
          .from('chat-images')
          .upload(fileName, file, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: urlData, error: urlError } = supabase2.storage
          .from('chat-images')
          .getPublicUrl(uploadData.path);

        if (urlError) throw urlError;

        imageUrl = urlData.publicUrl;
        logInfo('[Chat] Image URL: ' + imageUrl);
        showToast('Image uploaded successfully.', 'success');
      }

      const processedText = convertShortcodesToEmoji(rawText);

      const payload = {
        room_name: ROOM_NAME,
        user_name: session.user.email,
        content: processedText || '',
        type: imageUrl ? 'image' : 'text',
        url: imageUrl || null,
        image_url: imageUrl || null,
      };

      const { data, error } = await supabase2
        .from('messages')
        .insert(payload)
        .select('*')
        .single();

      if (error) throw error;

      await chatChannel.send({
        type: 'broadcast',
        event: 'message',
        payload: data,
      });
    } catch (err) {
      logError('Send error (full object)', err);
      showToast('Failed to send: ' + (err.message || 'Unknown error'), 'error');
    } finally {
      messageInput.value = '';
      imageInput.value = '';
      filePreview.textContent = '';
      sendBtn.disabled = false;
    }
  }

  // === EMOJI SUGGESTION DROPDOWN ===
  function hideEmojiSuggestions() {
    if (!emojiSuggestionsEl) return;
    emojiSuggestionsEl.innerHTML = '';
    emojiSuggestionsEl.style.display = 'none';
  }

  function showEmojiSuggestions(filterText, colonIndex) {
    if (!emojiSuggestionsEl) return;
    const matches = searchEmojiSuggestions(filterText);

    if (!matches.length) {
      hideEmojiSuggestions();
      return;
    }

    emojiSuggestionsEl.innerHTML = '';
    matches.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-suggestion-item';
      btn.textContent = `${item.emoji}  ${item.code}`;
      btn.onclick = () => {
        const value = messageInput.value;
        const cursorPos = messageInput.selectionStart || 0;
        const before = value.slice(0, colonIndex);
        const after = value.slice(cursorPos);
        messageInput.value = before + item.code + after;
        const newCursor = before.length + item.code.length;
        messageInput.focus();
        messageInput.setSelectionRange(newCursor, newCursor);
        hideEmojiSuggestions();
      };
      emojiSuggestionsEl.appendChild(btn);
    });

    emojiSuggestionsEl.style.display = 'block';
  }

  // === REALTIME SUBSCRIPTION ===
  function subscribeRealtime() {
    if (!supabase2) return;

    chatChannel
      .on('broadcast', { event: 'message' }, (payload) => {
        const msg = payload.payload;
        const atBottom = isNearBottom();
        renderMessage(msg, atBottom, false);
        if (!atBottom) {
          newMsgBtn.style.display = 'block';
        }
      })
      .on('broadcast', { event: TYPING_EVENT }, (payload) => {
        const { username, isTyping } = payload.payload || {};
        if (!typingIndicator) return;

        if (username && username !== CURRENT_USERNAME && isTyping) {
          const span = typingIndicator.querySelector('span');
          if (span) span.textContent = `${username} is typing`;
          typingIndicator.style.display = 'inline-flex';
        } else {
          typingIndicator.style.display = 'none';
        }
      })
      .on('broadcast', { event: REACTION_EVENT }, (payload) => {
        const reaction = payload.payload;
        applyReactionToCacheAndUI(reaction);
      })
      .subscribe();
  }

  // === EVENTS ===
  sendBtn.addEventListener('click', () => {
    hideEmojiSuggestions();
    sendMessage();
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      hideEmojiSuggestions();
      sendMessage();
    }
    if (e.key === 'Escape' && editingMessage) {
      e.preventDefault();
      cancelEdit();
      hideEmojiSuggestions();
      showToast('Edit cancelled.', 'info');
    }
  });

  if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', () => {
      if (editingMessage) {
        cancelEdit();
        hideEmojiSuggestions();
        showToast('Edit cancelled.', 'info');
      }
    });
  }

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    if (file) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      filePreview.textContent = `📷 ${file.name} (${mb} MB)`;
    } else {
      filePreview.textContent = '';
    }
  });

  // send button show/hide
  sendBtn.style.display = 'none';
  if (textFieldContainer) textFieldContainer.classList.remove('chat-has-text');

  const showSendBtn = () => {
    if (sendBtn.style.display !== 'flex') {
      sendBtn.style.display = 'flex';
      void sendBtn.offsetWidth;
    }
    sendBtn.classList.remove('send-btn--hiding');
    sendBtn.classList.add('send-btn--visible');
  };

  const hideSendBtn = () => {
    sendBtn.classList.remove('send-btn--visible');
    sendBtn.classList.add('send-btn--hiding');
  };

  sendBtn.addEventListener('transitionend', (e) => {
    if (
      e.propertyName === 'opacity' &&
      sendBtn.classList.contains('send-btn--hiding')
    ) {
      sendBtn.style.display = 'none';
    }
  });

  // typing + emoji suggestions
  let typingTimeout;
  let typingTimeoutLocal = null;
  let typingThrottle;

  messageInput.addEventListener('input', () => {
    const hasText = messageInput.value.trim().length > 0;

    if (textFieldContainer) {
      if (hasText) {
        textFieldContainer.classList.add('chat-has-text');
        showSendBtn();
      } else {
        textFieldContainer.classList.remove('chat-has-text');
        hideSendBtn();
      }
    }

    if (chatChannel) {
      if (typingThrottle) clearTimeout(typingThrottle);
      typingThrottle = setTimeout(() => {
        chatChannel.send({
          type: 'broadcast',
          event: TYPING_EVENT,
          payload: {
            username: CURRENT_USERNAME,
            isTyping: messageInput.value.length > 0,
          },
        });
      }, 300);
    }

    if (chatChannel) {
      chatChannel.send({
        type: 'broadcast',
        event: TYPING_EVENT,
        payload: {
          username: CURRENT_USERNAME,
          isTyping: true,
        },
      });
    }

    clearTimeout(typingTimeoutLocal);
    typingTimeoutLocal = setTimeout(() => {
      if (chatChannel) {
        chatChannel.send({
          type: 'broadcast',
          event: TYPING_EVENT,
          payload: {
            username: CURRENT_USERNAME,
            isTyping: false,
          },
        });
      }
    }, 1500);

    if (typingIndicator) {
      typingIndicator.style.display = 'none';
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (typingIndicator) typingIndicator.style.display = 'none';
    }, 1500);
    if (!emojiSuggestionsEl) return;
    const value = messageInput.value;
    const cursorPos = messageInput.selectionStart || 0;

    const colonIndex = value.lastIndexOf(':', cursorPos - 1);
    if (colonIndex === -1) {
      hideEmojiSuggestions();
      return;
    }

    const afterColon = value.slice(colonIndex + 1, cursorPos);
    if (afterColon.includes(' ') || afterColon.includes('\n')) {
      hideEmojiSuggestions();
      return;
    }
    showEmojiSuggestions(afterColon, colonIndex);
  });

  // Emoji picker button
  if (emojiBtn) {
    const picker = new EmojiButton({
      position: 'top-end',
      autoHide: true,
      emojisPerRow: 8,
      rows: 4,
      rootElement: document.body,
    });

    picker.on('emoji', (selection) => {
      const emojiChar = selection.emoji || selection;
      const start = messageInput.selectionStart || 0;
      const end = messageInput.selectionEnd || 0;
      const value = messageInput.value;
      messageInput.value = value.slice(0, start) + emojiChar + value.slice(end);
      messageInput.focus();
      const cursor = start + emojiChar.length;
      messageInput.setSelectionRange(cursor, cursor);
    });

    emojiBtn.addEventListener('click', () => {
      picker.togglePicker(emojiBtn);
    });
  }

  // Theme toggle (inside app so it has access to DOM)
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      document.body.classList.toggle('dark-mode');
    });
  }

  // Hide emoji suggestions on outside click
  document.addEventListener('click', (e) => {
    if (!emojiSuggestionsEl) return;
    if (!emojiSuggestionsEl.contains(e.target) && e.target !== messageInput) {
      hideEmojiSuggestions();
    }
  });

  // Keyboard navigation for emoji suggestions
  let selectedEmojiIndex = -1;
  messageInput.addEventListener('keydown', (e) => {
    if (!emojiSuggestionsEl) return;
    const items =
      emojiSuggestionsEl.querySelectorAll('.emoji-suggestion-item') || [];
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedEmojiIndex = (selectedEmojiIndex + 1) % items.length;
      items.forEach((btn, i) =>
        btn.classList.toggle('selected', i === selectedEmojiIndex),
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedEmojiIndex =
        (selectedEmojiIndex - 1 + items.length) % items.length;
      items.forEach((btn, i) =>
        btn.classList.toggle('selected', i === selectedEmojiIndex),
      );
    } else if (e.key === 'Enter' && selectedEmojiIndex !== -1) {
      e.preventDefault();
      items[selectedEmojiIndex].click();
      selectedEmojiIndex = -1;
    }
  });

  // === INIT ===
  loadMessages();
  subscribeRealtime();

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      showToast('Logging out...', 'info');
      const { error } = await supabase2.auth.signOut();
      if (error) {
        logError('Error logging out', error);
        showToast('Logout failed.', 'error');
      } else {
        window.location.href = '/login.html';
      }
    });
  }
}
