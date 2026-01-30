// script.js (ES module)
'use strict';

import { EmojiButton } from 'https://cdn.jsdelivr.net/npm/@joeattardi/emoji-button@4.6.4/dist/index.min.js';

// === GLOBAL VARIABLES ===
let session = null;
const MESSAGE_REACTIONS = {};
const REACTION_EVENT = 'reaction';
// === AUTHENTICATION & SESSION CHECK ===
// This block runs immediately to protect the page
(async () => {
  if (!window.supabaseClient) {
    console.error('Supabase client not found. Halting execution.');
    alert('Supabase client failed to initialize. Please check the console.');
    return;
  }

  const { data: { session: sessionData }, error } = await window.supabaseClient.auth.getSession();
  session = sessionData;

  if (error) {
    console.error('Error getting session:', error);
    window.location.href = '/login.html'; // Redirect on error
    return;
  }

  if (!session) {
    console.log('No active session found. Redirecting to login.');
    window.location.href = '/login.html'; // Redirect if not logged in
    return;
  }

  // If we have a session, set the current user and initialize the chat
  console.log('Session found for user:', session.user.email);
  // Simple way to get a username from an email

  // Now initialize the rest of the script
  initializeApp();
})();

function initializeApp() {
    
    // Import EmojiButton from CDN ES module build

    const ROOM_NAME = 'Tropang Tukmol';
    let CURRENT_USERNAME;

    // Supabase client from supabase-init.js
    const supabase2 = window.supabaseClient;
    if (!supabase2) {
    console.error('Supabase client not found. Make sure supabase-init.js runs BEFORE this script.');
    }

    CURRENT_USERNAME = session.user.email;
if (currentUsernameEl) currentUsernameEl.textContent = CURRENT_USERNAME;

    // === DOM ELEMENTS ===
    const messagesEl = document.getElementById('messages');
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
    const emojiSuggestionsEl = document.getElementById('emojiSuggestions'); // div in HTML

    if (currentUsernameEl) currentUsernameEl.textContent = session.user.email;

    // edit state
    let editingMessage = null;

    // typing state (for broadcast)
    let typingTimeout;
    let typingTimeoutLocal = null;
    const TYPING_EVENT = 'typing';

    // === BROADCAST CHANNEL (single instance) ===
    console.log('[Chat] Creating channel for room:', ROOM_NAME);
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
    return (text || '').replace(/[&<>"']/g, m => map[m]);
    }

    function formatTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

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

    // === ANTI-SPAM ===
    let sendTimestamps = []; // store recent message times (ms)
    let isSendBlocked = false;
    let sendBlockUntil = 0;

    function canSendNow() {
    const now = Date.now();

    // still blocked?
    if (isSendBlocked && now < sendBlockUntil) {
        const remaining = Math.ceil((sendBlockUntil - now) / 1000);
        showToast(`You are sending messages too quickly. Wait ${remaining}s.`, 'warning');
        return false;
    }

    // unblock if time passed
    if (isSendBlocked && now >= sendBlockUntil) {
        isSendBlocked = false;
        sendTimestamps = [];
    }

    // record this attempt first
    sendTimestamps.push(now);

    // keep only last 1 second of history
    const WINDOW_MS = 1000;
    sendTimestamps = sendTimestamps.filter(t => now - t <= WINDOW_MS);

    // if 5 or more messages in that window, block for 10 seconds
    const LIMIT = 5;
    if (sendTimestamps.length >= LIMIT) {
        isSendBlocked = true;
        sendBlockUntil = now + 10000; // 10 seconds
        showToast('You are sending messages too fast. Blocked for 10 seconds.', 'warning');
        return false;
    }

    return true;
    }

    // === EMOJI DICTIONARY UTILITIES (from emojis.js) ===
    const EMOJI_DICT = window.EMOJI_DICT || [];
    console.log('[Emoji] EMOJI_DICT size at script.js:', EMOJI_DICT.length);

    // Replace any :short_code: in text with the emoji character
    function replaceShortcodesWithEmoji(text) {
    if (!text || !EMOJI_DICT.length) return text || '';

    return text.replace(/:([a-zA-Z0-9_+-]+):/g, (match) => {
        const lower = match.toLowerCase();
        const found = EMOJI_DICT.find(e => e.code.toLowerCase() === lower);
        return found ? found.emoji : match;
    });
    }

    // Used before saving / editing
    function convertShortcodesToEmoji(text) {
    return replaceShortcodesWithEmoji(text || '');
    }

    // Simple suggestion search: match on code, description, or keywords
    function searchEmojiSuggestions(query) {
    if (!EMOJI_DICT.length) return [];
    if (!query) return EMOJI_DICT.slice(0, 20); // show first 20 on plain ":"
    const q = query.toLowerCase();
    return EMOJI_DICT.filter(e => {
        if (e.code && e.code.toLowerCase().includes(q)) return true;
        if (e.description && e.description.toLowerCase().includes(q)) return true;
        if (e.keywords && e.keywords.some(k => k.toLowerCase().includes(q))) return true;
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

    // === RENDER MESSAGE ===
    function renderMessage(msg) {
  console.log('[Chat] Rendering message:', msg);

  const welcome = messagesEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const isMe = msg.user_name === session.user.email;

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
    textEl.innerHTML = escapeHtml(msg.content);
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

    // download icon button (top-right)
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'image-download-btn';
    downloadBtn.type = 'button';
    downloadBtn.innerHTML = '⬇'; // replace with icon if desired

    downloadBtn.onclick = async (e) => {
      e.stopPropagation(); // don't open image

      try {
        const response = await fetch(msg.image_url, { mode: 'cors' });
        const blob = await response.blob();

        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;

        const url = new URL(msg.image_url, window.location.href);
        const pathPart = url.pathname.split('/').pop() || 'image';
        a.download = pathPart;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(blobUrl);
      } catch (err) {
        console.error('Download failed:', err);
        showToast('Failed to download image.', 'error');
      }
    };

    imgWrap.appendChild(img);
    imgWrap.appendChild(downloadBtn);
    bubble.appendChild(imgWrap);
  }

  // Reaction bar container (bottom-left, outside bubble)
  const reactionBar = document.createElement('div');
  reactionBar.className = 'reaction-bar';
  reactionBar.dataset.messageId = msg.id;

  // Render initial reactions (if any)
  renderReactionBarForMessage(msg.id, reactionBar);

  row.appendChild(bubble);
  row.appendChild(reactionBar);

  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}


    // === LOAD INITIAL MESSAGES ===
    async function loadMessages() {
  if (!supabase2) return;
  try {
    console.log('[Chat] Loading messages for room:', ROOM_NAME);

    const { data, error } = await supabase2
      .from('messages')
      .select('*')
      .eq('room_name', ROOM_NAME)
      .order('created_at', { ascending: true })
      .limit(200);

    console.log('[Chat] loadMessages result:', { data, error });

    if (error) throw error;

    const messages = data || [];

    // Load reactions for these messages
    const ids = messages.map(m => m.id);
    if (ids.length) {
      const { data: reactionsData, error: reactionsError } = await supabase2
        .from('message_reactions')
        .select('*')
        .in('message_id', ids);

      if (reactionsError) {
        console.error('Load reactions error:', reactionsError);
      } else {
        buildReactionsCache(reactionsData || []);
      }
    }

    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Load messages error:', err);
    showToast('Failed to load messages.', 'error');
  }
}

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


    // === REALTIME SUBSCRIPTION ===
    const REACTION_EVENT = 'reaction';

function subscribeRealtime() {
  if (!supabase2) return;

  console.log('[Chat] Subscribing to broadcast channel...');
  chatChannel
    // messages
    .on('broadcast', { event: 'message' }, (payload) => {
      console.log('[Chat] Broadcast received (message):', payload);
      const msg = payload.payload;
      renderMessage(msg);
    })
    // typing indicator (already present)
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
    // reactions
    .on('broadcast', { event: REACTION_EVENT }, (payload) => {
      const reaction = payload.payload;
      console.log('[Chat] Broadcast received (reaction):', reaction);
      applyReactionToCacheAndUI(reaction);
    })
    .subscribe((status) => {
      console.log('Broadcast status:', status);
    });
}

async function toggleReaction(messageId, emoji) {
  if (!supabase2) return;

  const existingMap = MESSAGE_REACTIONS[messageId] || {};
  const bucket = existingMap[emoji];
  const userAlreadyReacted = bucket && bucket.users.includes(CURRENT_USERNAME);

  try {
    if (!userAlreadyReacted) {
      const { error } = await supabase2
        .from('message_reactions')
        .insert({
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
    console.error('Reaction toggle error:', err);
    showToast('Failed to update reaction.', 'error');
  }
}


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
    chip.title = info.users.join(', ') || 'No reactions';

    chip.onclick = (e) => {
      e.stopPropagation();
      toggleReaction(messageId, emoji);
    };

    containerEl.appendChild(chip);
  });
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
  emojis.forEach(e => {
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

  // Re-render reaction bar for this message
  const row = messagesEl.querySelector(`[data-message-id="${message_id}"]`);
  if (row) {
    const bar = row.querySelector('.reaction-bar');
    if (bar) {
      renderReactionBarForMessage(message_id, bar);
    }
  }
}



    // === EDIT / DELETE FUNCTIONS ===
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

    showToast('Editing mode: press ✔ to save or ✕ / Esc to cancel.', 'info');
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

        console.log('[Chat] Delete result error:', error);
        if (error) throw error;

        const row = messagesEl.querySelector(`[data-message-id="${msg.id}"]`);
        if (row) row.remove();

        showToast('Message deleted.', 'success');
    } catch (err) {
        console.error('Delete error:', err);
        showToast('Failed to delete: ' + (err.message || 'Unknown error'), 'error');
    }
    }

    // === SEND MESSAGE (create or edit) ===
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

        console.log('[Chat] Edit result:', { data, error });
        if (error) throw error;

        const row = messagesEl.querySelector(`[data-message-id="${editingMessage.id}"]`);
        if (row) {
            const textEl = row.querySelector('.message-text');
            if (textEl) textEl.innerHTML = escapeHtml(data.content);
        }

        showToast('Message edited.', 'success');
        cancelEdit();
        return;
        } catch (err) {
        console.error('Edit error:', err);
        showToast('Failed to edit: ' + (err.message || 'Unknown error'), 'error');
        return;
        }
    }

    // CREATE MODE
    if (!rawText && !file) return;

    sendBtn.disabled = true;

    try {
        console.log('[Chat] Sending message. Text:', rawText, 'File:', file);

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
        console.log('[Chat] Uploading to bucket chat-images. File name:', fileName);

        const { data: uploadData, error: uploadError } = await supabase2.storage
            .from('chat-images')
            .upload(fileName, file, { upsert: true });

        console.log('[Chat] Upload result:', { uploadData, uploadError });

        if (uploadError) throw uploadError;

        const { data: urlData, error: urlError } = supabase2
            .storage
            .from('chat-images')
            .getPublicUrl(uploadData.path);

        console.log('[Chat] Public URL result:', { urlData, urlError });

        if (urlError) throw urlError;

        imageUrl = urlData.publicUrl;
        console.log('[Chat] Image URL:', imageUrl);
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

        console.log('[Chat] Inserting payload into messages:', payload);

        const { data, error } = await supabase2
        .from('messages')
        .insert(payload)
        .select('*')
        .single();

        console.log('[Chat] Insert result:', { data, error });

        if (error) throw error;

        console.log('[Chat] Broadcasting message via channel...');
        const sendResult = await chatChannel.send({
        type: 'broadcast',
        event: 'message',
        payload: data,
        });
        console.log('[Chat] Broadcast send result:', sendResult);

        showToast('Message sent successfully.', 'success');
    } catch (err) {
        console.error('Send error (full object):', err);
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
    matches.forEach(item => {
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

    // === EMOJI PICKER (EmojiButton, ES module) ===
    if (emojiBtn) {
    const picker = new EmojiButton({
        position: 'top-end',
        autoHide: true,
        emojisPerRow: 8,
        rows: 4,
    });

    picker.on('emoji', selection => {
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
    } else {
    console.warn('emojiBtn not found.');
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

    // typing + emoji suggestions
    messageInput.addEventListener('input', () => {
    // Do not show typing indicator for myself; instead, broadcast to others
    if (chatChannel) {
        chatChannel.send({
        type: 'broadcast',
        event: TYPING_EVENT,
        payload: {
            username: session.user.email,
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
            username: session.user.email,
            isTyping: false,
            },
        });
        }
    }, 1500);

    // existing local timeout still used only to hide if somehow shown
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

    // === INIT ===
    console.log('[Chat] Initializing chat page...');
    showToast('Initializing Tropang Tukmol chat...', 'info');
    loadMessages();
    subscribeRealtime();

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        showToast('Logging out...', 'info');
        const { error } = await supabase2.auth.signOut();
        if (error) {
        console.error('Error logging out:', error);
        showToast('Logout failed.', 'error');
        } else {
        // The session check at the top will redirect to login page automatically,
        // but we can do it explicitly for a faster response.
        window.location.href = '/login.html';
        }
    });
    }
}