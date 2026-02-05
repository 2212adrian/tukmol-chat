// script.js (ES module)
import { EmojiButton } from 'https://cdn.jsdelivr.net/npm/@joeattardi/emoji-button@4.6.4/dist/index.min.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@5.1.1/lib/marked.esm.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((reg) => reg.unregister());
  });
}

let emojiPicker = null;

const supabaseClient = window.supabaseClient;
function debugToast(text) {
  Toastify({
    text: String(text),
    duration: 6000,
    gravity: 'top',
    position: 'right',
    close: true,
    stopOnFocus: true,
    style: { background: 'linear-gradient(to right, #4b6cb7, #182848)' },
  }).showToast();
}

// === GLOBAL STATE ===
let session = null;
const MESSAGE_REACTIONS = {};
let reactionChangesChannel = null;
let profilesByUserId = {};
const LAST_AVATAR_BY_USER_ID = {};
let typingTimeoutId = null;
const MESSAGE_CONTENT_CACHE = {};
// === AUTH + BOOT ===
(async () => {
  const {
    data: { session: sessionData },
    error,
  } = await window.supabaseClient.auth.getSession();

  session = sessionData;

  if (!session) {
    window.location.href = '/login.html';
    return;
  }

  initializeApp();
})();

function initializeApp() {
  async function loadInitialReactions() {
    if (!supabaseClient) return;

    const { data, error } = await supabaseClient
      .from('message_reactions')
      .select('message_id, user_name, emoji');

    if (error) {
      console.error('Load reactions error', error);
      return;
    }

    data.forEach((r) => {
      if (!MESSAGE_REACTIONS[r.message_id]) {
        MESSAGE_REACTIONS[r.message_id] = {};
      }
      const map = MESSAGE_REACTIONS[r.message_id];

      if (!map[r.emoji]) {
        map[r.emoji] = { count: 0, users: [] };
      }
      const bucket = map[r.emoji];

      if (!bucket.users.includes(r.user_name)) {
        bucket.users.push(r.user_name);
        bucket.count += 1;
      }
    });

    // re-render bars for messages already in the DOM
    messagesEl.querySelectorAll('.message-row').forEach((row) => {
      const mid = row.dataset.messageId;
      const bar = row.querySelector('.reaction-bar');
      if (mid && bar) {
        renderReactionBarForMessage(mid, bar);
      }
    });
  }

  const sendBtn = document.getElementById('sendBtn');

  if (sendBtn) {
    // Remove anonymous function listeners that may have been created
    sendBtn.removeEventListener('click', handleSendClick);
    // Use the named function to attach the listener only ONCE
    sendBtn.addEventListener('click', handleSendClick);
  }
  let ROOM_NAME = 'general-1'; // default room
  const CURRENT_USER = session.user;

  async function fetchMyProfileIfMissing() {
    if (!session?.user) return;
    const id = session.user.id;
    if (profilesByUserId[id]) return;

    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', id)
      .single();

    if (!error && data) {
      profilesByUserId[id] = data;
    }
  }

  function applyThemeFromProfile() {
    if (!CURRENT_USER) return;
    const myProfile = CURRENT_USER.id;
    if (!myProfile) return;

    const mode = (myProfile.theme_mode || '').toLowerCase();
    if (mode === 'dark') {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }

  applyThemeFromProfile();

  function getDisplayNameFromUser(user) {
    return (
      user.user_metadata?.display_name ||
      user.user_metadata?.full_name ||
      user.email
    );
  }

  function getBubbleColorFromUser(user) {
    return user.user_metadata?.bubble_color || '#2563eb';
  }

  function getAvatarUrlFromUser(user) {
    return user.user_metadata?.avatar_url || null;
  }

  // New settings-compatible helpers (settings.js uses these keys)
  function getUserBubbleStyle(user) {
    return user.user_metadata?.bubble_style || 'solid';
  }

  function getUserChatBgColor(user) {
    return user.user_metadata?.chat_bg_color || '#020617';
  }

  function getUserChatTexture(user) {
    return user.user_metadata?.chat_texture || null;
  }

  // === EVENTS (CRITICAL FIX 2: Correct, Single Listener) ===
  function handleSendClick() {
    hideEmojiSuggestions();
    sendMessage();
  }

  if (sendBtn) {
    // Ensure listener is removed if initializeApp runs multiple times (e.g., in testing/hot-reload)
    sendBtn.removeEventListener('click', handleSendClick);
    // Attach the single, correct listener
    sendBtn.addEventListener('click', handleSendClick);
  }
  // ========================================================

  const CURRENT_USERNAME =
    session.user.user_metadata.display_name || session.user.email;

  const imageViewerContainer = document.getElementById('imageViewerContainer');
  let imageViewerEl, imageViewerImg, imageViewerCaption;
  let imageViewerClose, imageViewerBackdrop;
  async function loadImageViewerPartial() {
    if (!imageViewerContainer) return;

    try {
      const res = await fetch('/image-viewer.html');
      const html = await res.text();
      imageViewerContainer.innerHTML = html;

      imageViewerEl = document.getElementById('imageViewer');
      imageViewerImg = document.getElementById('imageViewerImg');
      imageViewerCaption = document.getElementById('imageViewerCaption');
      imageViewerClose = document.getElementById('imageViewerClose');
      imageViewerBackdrop = document.getElementById('imageViewerBackdrop');

      if (!imageViewerEl) return;

      const close = () => {
        imageViewerEl.style.display = 'none';
        if (imageViewerImg) imageViewerImg.src = '';
      };

      if (imageViewerClose) imageViewerClose.addEventListener('click', close);
      if (imageViewerBackdrop)
        imageViewerBackdrop.addEventListener('click', close);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });
    } catch (err) {
      logError('Failed to load image viewer partial', err);
    }
  }

  // pagination / scroll
  let oldestMessage = null;
  let loadingOlder = false;
  const PAGE_SIZE = 20;
  let lastRenderedUserName = null;
  let lastRenderedDateKey = null;
  let attachedImages = [];
  let attachedFiles = [];
  let messageReadsByUserId = {};
  let readChangesChannel = null;

  const EMOJI_DICT = window.EMOJI_DICT || [];

  const supabaseClient = window.supabaseClient;
  if (!supabaseClient) {
    console.error(
      'Supabase client not found. Make sure supabase-init.js runs BEFORE this script.',
    );
  }
  window.chatTheme = {
    bubbleStyle: 'solid',
    bgColor: '#2563eb',
    texture: null,
  };

  async function loadChatTheme() {
    if (!supabaseClient) return;

    const { data: sessionData, error: sessionError } =
      await supabaseClient.auth.getSession();
    if (sessionError || !sessionData?.session) return;

    const user = sessionData.session.user;

    const { data: profile, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (error || !profile) return;

    window.chatTheme = {
      bubbleStyle: profile.bubble_style || 'solid',
      bgColor: profile.chat_bg_color || '#2563eb',
      texture: profile.chat_texture || null,
    };

    // optional: tint chat background
    const chatPage = document.querySelector('.chat-page');
    if (chatPage) {
      chatPage.style.backgroundColor = window.chatTheme.bgColor;
    }
  }

  // call once on page load
  loadChatTheme();

  function createMyMessageBubble(text) {
    const { bubbleStyle, bgColor, texture } = window.chatTheme || {};
    const baseColor = bgColor || '#2563eb';
    bubble.style.color = baseColor;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble me';

    // reset
    bubble.style.background = '';
    bubble.style.backgroundImage = '';
    bubble.style.boxShadow = '';
    bubble.style.border = '';
    bubble.style.color = '';

    if (bubbleStyle === 'outline') {
      // soft fill + colored border
      const fill = baseColor + '1A'; // ~10% alpha
      bubble.classList.add('style-outline');
      bubble.style.background = fill;
      bubble.style.backgroundColor = fill;
      bubble.style.border = `1px solid ${baseColor}`;
      bubble.style.color = textColor;
    } else if (bubbleStyle === 'glass') {
      bubble.classList.add('style-glass');
      bubble.style.background = `linear-gradient(
      135deg,
      ${baseColor}33,
      rgba(15, 23, 42, 0.9)
    )`;
      bubble.style.color = '#e5e7eb';
    } else if (bubbleStyle === 'texture' && texture) {
      bubble.classList.add('style-texture');
      bubble.style.backgroundColor = baseColor;
      bubble.style.backgroundImage = `url('${texture}')`;
      bubble.style.backgroundSize = 'cover';
      bubble.style.backgroundPosition = 'center';
      bubble.style.color = textColor;
    } else {
      // solid
      bubble.style.background = baseColor;
      bubble.style.color = textColor;
    }

    bubble.textContent = text;
    return bubble;
  }

  async function bootstrapSession() {
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data.user) return;
    session = { user: data.user };

    // load own profile and cache
    const { data: profile, error: profileError } = await supabaseClient
      .from('profiles')
      .select(
        'id, email, avatar_url, display_name, bubble_style, chat_bg_color, chat_texture',
      )
      .eq('id', session.user.id)
      .single();

    if (!profileError && profile) {
      profilesByUserId[profile.id] = profile;
    }
  }

  let chatChannel = null;
  const TYPING_EVENT = 'typing';

  let typingTimer = null;
  function sendTyping(isTyping) {
    if (!chatChannel) return;

    // Clear any pending timer
    if (typingTimer) clearTimeout(typingTimer);

    chatChannel.send({
      type: 'broadcast',
      event: TYPING_EVENT,
      payload: {
        username: CURRENT_USERNAME,
        isTyping,
        room: ROOM_NAME,
      },
    });

    // Auto-send stop after 2s inactivity
    if (isTyping) {
      typingTimer = setTimeout(() => sendTyping(false), 2000);
    }
  }
  const currentTypers = new Set();

  function updateTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (!el) return;

    el.classList.remove('show', 'fade-out');

    if (currentTypers.size === 0) {
      el.classList.add('fade-out');
      return;
    }

    const labelEl = el.querySelector('.typing-indicator-label') || el;
    labelEl.textContent =
      currentTypers.size === 1
        ? `${Array.from(currentTypers)[0]} is typing…`
        : `${currentTypers.size} users typing…`;

    el.classList.add('show');
  }

  const REACTION_EVENT = 'reaction';
  const READS_EVENT = 'reads_updated';
  let messageChangesChannel = null;

  function subscribeRealtime() {
    if (!supabaseClient) return;

    if (chatChannel) {
      supabaseClient.removeChannel(chatChannel);
      chatChannel = null;
    }

    chatChannel = supabaseClient.channel(`room:${ROOM_NAME}`, {
      config: { broadcast: { self: true } },
    });

    chatChannel
      .on('broadcast', { event: 'message' }, ({ payload }) => {
        const msg = payload;

        // --- CRITICAL FIX: PREVENT SELF-DUPLICATION (ECHO) ---
        // The local client's sendMessage already rendered this message optimistically.
        // Ignore the broadcast if the sender ID matches the current session user ID.
        if (msg.user_id === session.user.id) {
          return;
        }
        // --------------------------------------------------------

        const atBottom = isNearBottom();
        renderMessage(msg, atBottom, false);
        if (!atBottom) newMsgBtn.style.display = 'block';
        handleIncomingNotification(msg);
        markMySeen();
      })
      // === NEW LISTENER: Handle explicit broadcast for deleted messages ===
      .on('broadcast', { event: 'message_deleted' }, ({ payload }) => {
        const msg = payload; // The payload is the updated message row with deleted_at set
        applyDeletedMessageToUI(msg);
      })
      .on('broadcast', { event: 'message_edited' }, ({ payload }) => {
        const msg = payload; // The payload is the updated message row
        updateExistingMessageContent(msg);
      })
      // ===================================================================
      .on('broadcast', { event: TYPING_EVENT }, ({ payload }) => {
        const { username, isTyping, room } = payload || {};
        if (!username || room !== ROOM_NAME || username === CURRENT_USERNAME)
          return;

        const el = document.getElementById('typingIndicator');
        if (!el) return;

        if (isTyping) {
          currentTypers.add(username);
        } else {
          currentTypers.delete(username);
        }

        updateTypingIndicator();
      })

      .on('broadcast', { event: REACTION_EVENT }, ({ payload }) => {
        const reaction = payload;

        // CRITICAL FIX: The sender already updated the UI optimistically in toggleReaction.
        // Ignore the self-echoed broadcast to prevent double-update/race condition.
        if (reaction.user_name === CURRENT_USERNAME) {
          return;
        }

        applyReactionToCacheAndUI(reaction);
      })
      .on('broadcast', { event: READS_EVENT }, ({ payload }) => {
        const { room } = payload || {};
        if (room && room !== ROOM_NAME) return;
        loadMessageReads();
      })
      .subscribe();
  }

  function removeMessageWithAnimation(messageId) {
    const row = messagesEl.querySelector(`[data-message-id="${messageId}"]`);
    if (!row) return;

    // Apply a fade-out animation before removal
    row.classList.add('message-remove');
    row.addEventListener(
      'animationend',
      () => {
        row.remove();
      },
      { once: true },
    );
  }

  function subscribeMessageChanges() {
    if (!supabaseClient) return;

    if (messageChangesChannel) {
      supabaseClient.removeChannel(messageChangesChannel);
      messageChangesChannel = null;
    }

    messageChangesChannel = supabaseClient
      .channel('messages-db-changes')
      .on(
        'postgres_changes',
        {
          event: '*', // INSERT, UPDATE, DELETE
          schema: 'public',
          table: 'messages',
          // optional room filter: filter: `room_name=eq.${ROOM_NAME}`,
        },
        (payload) => {
          console.log('[MSG CHANGE]', payload);

          if (payload.eventType === 'INSERT') {
            const msg = payload.new;
            const atBottom = isNearBottom();
            renderMessage(msg, atBottom, false);
            if (!atBottom) newMsgBtn.style.display = 'block';
            handleIncomingNotification(msg);
            markMySeen();
          } else if (payload.eventType === 'UPDATE') {
            const msg = payload.new;
            if (msg.deleted_at) {
              applyDeletedMessageToUI(msg); // show "<name> just deleted this message"
            } else {
              updateExistingMessageContent(msg); // your edit handler
            }
          } else if (payload.eventType === 'DELETE') {
            const oldMsg = payload.old;
            removeMessageWithAnimation(oldMsg.id); // remove with fade
          }
        },
      )
      .subscribe();
  }

  // Function is structurally correct, no change needed here.
  let reactionChannel;

  function subscribeReactionTableChanges(roomName) {
    if (!supabaseClient) return;

    // cleanup old channel if any
    if (reactionChannel) {
      supabaseClient.removeChannel(reactionChannel);
      reactionChannel = null;
    }

    reactionChannel = supabaseClient
      .channel(`room:${roomName}:reactions`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_reactions',
          filter: `room_name=eq.${roomName}`, // Requires room_name column added to table
        },
        (payload) => {
          const row = payload.new || payload.old;

          // Double-check message belongs to this room (safety for cross-room edge cases)
          if (!isMessageInCurrentRoom(row.message_id)) return;

          const reaction = {
            message_id: row.message_id,
            user_name: row.user_name,
            emoji: row.emoji,
            action:
              payload.eventType === 'DELETE'
                ? 'remove'
                : 'INSERT' || 'UPDATE'
                  ? 'add'
                  : 'add',
          };

          applyReactionToCacheAndUI(reaction);
        },
      )
      .subscribe();
  }

  // Add this helper function (uses your local messages cache)
  function isMessageInCurrentRoom(messageId) {
    // Assumes you have a global MESSAGES array/object with loaded messages for current room
    return MESSAGES.some(
      (msg) => msg.id === messageId && msg.room_name === ROOM_NAME,
    );
  }

  // === DOM ELEMENTS ===
  const messagesEl = document.querySelector('.messages-container');
  const messageInput = document.getElementById('messageInput');
  const imageInput = document.getElementById('imageInput');

  sendBtn.style.display = 'none';
  const filePreview = document.getElementById('filePreview');
  const typingIndicator = document.getElementById('typingIndicator');
  const currentUsernameEl = document.getElementById('currentUsername');
  const inputLabelEl = document.getElementById('inputLabel');
  const sendIconEl = document.getElementById('sendIcon');
  const emojiBtn = document.getElementById('emojiBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const emojiSuggestionsEl = document.getElementById('emojiSuggestions');
  const replyPreviewEl = document.getElementById('replyPreview');
  const replyPreviewNameEl = document.getElementById('replyPreviewName');
  const replyPreviewTextEl = document.getElementById('replyPreviewText');
  const cancelReplyBtn = document.getElementById('cancelReplyBtn');
  const notificationToggle = document.getElementById('notificationToggle');
  const notificationBtn = document.getElementById('notificationBtn');
  const notificationBadge = document.getElementById('notificationBadge');
  const notificationPanel = document.getElementById('notificationPanel');
  const notificationList = document.getElementById('notificationList');
  const markAllReadBtn = document.getElementById('markAllReadBtn');
  const textFieldContainer = document.querySelector('.text-field-container');
  const sidebarUsername = document.getElementById('sidebarUsername');
  const onlineUsersContainer = document.getElementById('onlineUsersContainer');
  if (sidebarUsername) sidebarUsername.textContent = CURRENT_USERNAME;

  if (cancelReplyBtn) {
    cancelReplyBtn.addEventListener('click', () => {
      clearReplyTarget();
    });
  }

  let notificationsEnabled =
    localStorage.getItem('notifications_enabled') === 'true';
  let unreadNotifications = 0;

  function updateNotificationBadge() {
    if (!notificationBadge) return;
    if (unreadNotifications > 0) {
      notificationBadge.hidden = false;
      notificationBadge.textContent =
        unreadNotifications > 99 ? '99+' : String(unreadNotifications);
    } else {
      notificationBadge.hidden = true;
      notificationBadge.textContent = '0';
    }
  }

  function setNotificationPanelVisible(visible) {
    if (!notificationPanel) return;
    notificationPanel.hidden = !visible;
  }

  function applyNotificationToggleState() {
    if (notificationToggle) {
      notificationToggle.checked = notificationsEnabled;
    }
    if (notificationBtn) {
      notificationBtn.style.display = notificationsEnabled
        ? 'inline-flex'
        : 'none';
    }
    if (!notificationsEnabled) {
      setNotificationPanelVisible(false);
    }
  }

  async function syncNotificationPermission() {
    if (!notificationToggle) return;
    if (!notificationToggle.checked) return;
    const permission = await ensureNotificationPermission();
    if (permission !== 'granted') {
      notificationsEnabled = false;
      localStorage.setItem('notifications_enabled', 'false');
      applyNotificationToggleState();
      showToast('Notifications denied. Toggle turned off.', 'warning');
      return;
    }
    notificationsEnabled = true;
    localStorage.setItem('notifications_enabled', 'true');
    applyNotificationToggleState();
  }

  if (notificationToggle) {
    notificationToggle.addEventListener('change', async () => {
      if (notificationToggle.checked) {
        const permission = await ensureNotificationPermission();
        if (permission !== 'granted') {
          notificationsEnabled = false;
          localStorage.setItem('notifications_enabled', 'false');
          applyNotificationToggleState();
          showToast('Notifications denied. Toggle turned off.', 'warning');
          return;
        }
        notificationsEnabled = true;
      } else {
        notificationsEnabled = false;
      }

      localStorage.setItem(
        'notifications_enabled',
        notificationsEnabled ? 'true' : 'false',
      );
      applyNotificationToggleState();
    });
  }

  if (notificationBtn) {
    notificationBtn.addEventListener('click', () => {
      const isHidden = notificationPanel?.hidden ?? true;
      setNotificationPanelVisible(isHidden);
    });
  }

  if (markAllReadBtn) {
    markAllReadBtn.addEventListener('click', () => {
      if (notificationList) {
        notificationList.innerHTML = '';
      }
      unreadNotifications = 0;
      updateNotificationBadge();
    });
  }

  applyNotificationToggleState();
  updateNotificationBadge();
  syncNotificationPermission();
  // hydrate sidebar/header avatar from auth metadata
  const userAvatarUrl = getAvatarUrlFromUser(CURRENT_USER);
  const userInitial = CURRENT_USERNAME.charAt(0).toUpperCase();

  // apply chat background color + texture from metadata
  //const userBgColor = getUserChatBgColor(CURRENT_USER);
  //const userTexture = getUserChatTexture(CURRENT_USER);
  //if (messagesEl) {
  //  messagesEl.style.background = userBgColor;
  //  if (userTexture) {
  //    messagesEl.style.backgroundImage = `url('${userTexture}')`;
  //    messagesEl.style.backgroundSize = '160px 160px';
  //    messagesEl.style.backgroundRepeat = 'repeat';
  //  } else {
  //    messagesEl.style.backgroundImage = '';
  //  }
  //}
  let onlineUsers = []; // array of { id, email }

  const roomNameHeader = document.getElementById('roomNameHeader');
  const channelItems = document.querySelectorAll('.channel-item');

  channelItems.forEach((item) => {
    item.addEventListener('click', () => {
      const room = item.getAttribute('data-room-name');
      switchRoom(room);
    });
  });

  async function switchRoom(newRoom) {
    if (!newRoom || newRoom === ROOM_NAME) return;
    if (!supabaseClient) return;

    ROOM_NAME = newRoom;
    clearReplyTarget();
    messageReadsByUserId = {};

    // 1) Leave old presence channel
    if (presenceChannel) {
      supabaseClient.removeChannel(presenceChannel);
      presenceChannel = null;
    }

    // 2) Leave old realtime channels
    if (chatChannel) {
      supabaseClient.removeChannel(chatChannel);
      chatChannel = null;
    }
    if (reactionChangesChannel) {
      supabaseClient.removeChannel(reactionChangesChannel);
      reactionChangesChannel = null;
    }
    if (readChangesChannel) {
      supabaseClient.removeChannel(readChangesChannel);
      readChangesChannel = null;
    }
    if (readChangesChannel) {
      supabaseClient.removeChannel(readChangesChannel);
      readChangesChannel = null;
    }

    // 3) Clear cache + UI
    if (window.MESSAGE_REACTIONS) {
      MESSAGE_REACTIONS = {};
    }
    if (messagesEl) {
      messagesEl.innerHTML = '';
    }

    // 4) Load new room data from DB
    await loadMessages(); // uses ROOM_NAME internally
    await loadInitialReactions(); // uses ROOM_NAME internally
    await loadMessageReads();

    // 5) Re‑subscribe realtime & presence for the new room
    subscribeRealtime(); // messages + typing + REACTION_EVENT (broadcast)
    subscribeMessageChanges(); // 👈 CALL the function
    subscribeReactionTableChanges(); // EITHER keep this OR broadcast, not both
    subscribeMessageReads();
    await setupPresence(); // presence for ROOM_NAME
    markMySeen();

    // 6) Update header UI
    if (roomNameHeader) {
      roomNameHeader.textContent = itemDisplayNameForRoom(newRoom);
    }

    // 7) Update active state in sidebar
    channelItems.forEach((item) => {
      const room = item.getAttribute('data-room-name');
      item.classList.toggle('active', room === newRoom);
    });

    // 8) Mobile layout – show chat
    if (window.innerWidth <= 768) {
      document.getElementById('appLayout')?.classList.add('chat-active');
    }
  }

  function itemDisplayNameForRoom(room) {
    const item = document.querySelector(
      `.channel-item[data-room-name="${room}"]`,
    );
    return item?.getAttribute('data-room-display') || room.replace(/-/g, ' ');
  }

  if (textFieldContainer) textFieldContainer.classList.remove('chat-has-text');
  function handleMessageInputChange() {
    updateSendButtonState();

    const hasText = messageInput.value.trim().length > 0;
    const hasImages = attachedImages.length > 0;
    const hasFiles = attachedFiles.length > 0;

    // 1) show / hide send button depending on text / images
    if (textFieldContainer) {
      if (hasText || hasImages || hasFiles) {
        textFieldContainer.classList.add('chat-has-text');
        showSendBtn();
      } else {
        textFieldContainer.classList.remove('chat-has-text');
        hideSendBtn();
      }
    }

    // 2) emoji suggestions
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
  }

  // === CLEANED INPUT LISTENER (REPLACE THE ENTIRE OLD ONE) ===
  messageInput.addEventListener('input', () => {
    // Auto-grow for multiline textarea
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';

    // Typing indicator: broadcast + timeout
    sendTyping(true);
    if (typingTimeoutId) clearTimeout(typingTimeoutId);
    typingTimeoutId = setTimeout(() => sendTyping(false), 2000);

    // Send button + input state
    handleMessageInputChange();

    // Emoji suggestions
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

  const themeToggle = document.getElementById('themeToggle');
  const dragOverlay = document.getElementById('dragOverlay');
  const inputSection = document.querySelector('.input-section');

  if (inputSection) {
    const preventDefaults = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      inputSection.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      inputSection.addEventListener(eventName, () => {
        if (dragOverlay) dragOverlay.style.display = 'flex';
        if (textFieldContainer) textFieldContainer.classList.add('drop-active');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      inputSection.addEventListener(eventName, () => {
        if (dragOverlay) dragOverlay.style.display = 'none';
        if (textFieldContainer)
          textFieldContainer.classList.remove('drop-active');
      });
    });

    inputSection.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;

      addAttachmentFiles(files);
      showToast('File added from drag & drop.', 'info');
    });
  }

  if (!messagesEl || !messageInput || !sendBtn) {
    const errMsg = 'Required chat DOM elements not found.';
    console.error(errMsg);
    logError(errMsg);
    return;
  }

  sendBtn.style.display = 'none';
  if (currentUsernameEl) currentUsernameEl.textContent = CURRENT_USERNAME;
  if (sidebarUsername) sidebarUsername.textContent = CURRENT_USERNAME;
  if (textFieldContainer) textFieldContainer.classList.remove('chat-has-text');
  // “New messages” button
  const newMsgBtn = document.createElement('div');
  newMsgBtn.id = 'newMessagesBtn';
  newMsgBtn.className = 'new-messages-btn';
  newMsgBtn.textContent = '↓ New Messages';
  newMsgBtn.style.display = 'none';
  messagesEl.appendChild(newMsgBtn);

  function renderImagePreview() {
    filePreview.innerHTML = '';

    attachedImages.forEach((item, index) => {
      const chip = document.createElement('div');
      chip.className = 'preview-chip';

      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.file.name;
      chip.appendChild(img);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'preview-remove';
      removeBtn.textContent = '✕';
      removeBtn.onclick = () => {
        // revoke object URL
        URL.revokeObjectURL(item.url);
        attachedImages.splice(index, 1);
        renderImagePreview();
      };
      chip.appendChild(removeBtn);

      filePreview.appendChild(chip);
    });

    attachedFiles.forEach((item, index) => {
      const chip = document.createElement('div');
      chip.className = 'preview-chip preview-file';

      const icon = document.createElement('div');
      icon.className = 'preview-file-icon';
      icon.textContent = 'DOC';
      chip.appendChild(icon);

      const meta = document.createElement('div');
      meta.className = 'preview-file-meta';
      const name = document.createElement('div');
      name.className = 'preview-file-name';
      name.textContent = item.file.name;
      const size = document.createElement('div');
      size.className = 'preview-file-size';
      size.textContent = formatFileSize(item.file.size);
      meta.appendChild(name);
      meta.appendChild(size);
      chip.appendChild(meta);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'preview-remove';
      removeBtn.textContent = 'X';
      removeBtn.onclick = () => {
        attachedFiles.splice(index, 1);
        renderImagePreview();
      };
      chip.appendChild(removeBtn);

      filePreview.appendChild(chip);
    });

    if (!attachedImages.length && !attachedFiles.length) {
      filePreview.textContent = '';
    }
  }

  function addImageFiles(files) {
    if (!files || !files.length) return;

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;

      if (attachedImages.length >= 4) {
        showToast('You can attach up to 4 images only.', 'warning');
        break;
      }

      attachedImages.push({
        file,
        url: URL.createObjectURL(file),
      });
    }

    renderImagePreview();
    updateSendButtonState();
    sendBtn.disabled = false;
  }

  function addAttachmentFiles(files) {
    if (!files || !files.length) return;

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        addImageFiles([file]);
      } else {
        if (attachedFiles.length >= 1) {
          showToast('You can attach 1 document at a time.', 'warning');
          break;
        }
        attachedFiles.push({ file });
        showToast(
          `Document attached: ${file.name} (${formatFileSize(file.size)})`,
          'info',
        );
      }
    }

    renderImagePreview();
    updateSendButtonState();
    sendBtn.disabled = false;
  }

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
      bg = 'linear-gradient(to right, #f11f30, #ec5417)';
    } else if (type === 'warning') {
      bg = 'linear-gradient(to right, #ff6022, #ff9100)';
    }

    Toastify({
      text,
      duration: 3000,
      close: true,
      gravity: 'top',
      position: 'right',
      stopOnFocus: true,
      style: {
        background: bg,
      },
    }).showToast();
  }

  function logInfo(message, extra) {
    console.log(message, extra ?? '');
  }

  function logError(message, extra) {
    console.error(message, extra ?? '');
    showToast(String(message), 'error');
  }

  let presenceChannel = null;

  async function setupPresence() {
    if (!supabaseClient || !session?.user) return;

    if (presenceChannel) {
      supabaseClient.removeChannel(presenceChannel);
      presenceChannel = null;
    }

    presenceChannel = supabaseClient.channel(`presence:${ROOM_NAME}`, {
      config: {
        presence: { key: session.user.id },
      },
    });

    // Helper to read presenceState, fetch missing profiles, then update onlineUsers
    const syncFromPresenceState = async () => {
      const state = presenceChannel.presenceState();

      // Flatten connections and base presenceUsers (for profile fetching)
      const presenceUsers = Object.values(state)
        .flat()
        .map((p) => ({
          id: p.user_id || p.id || p.email,
          email: p.email,
          display_name: p.display_name || null,
          user_meta: p.user_meta || p.meta || {},
        }))
        .filter((u) => !!u.id); // keep only valid ids

      const onlineIds = presenceUsers.map((u) => u.id).filter(Boolean);
      const missingIds = onlineIds.filter((id) => !profilesByUserId[id]);

      if (missingIds.length) {
        const { data: profilesData, error: profilesError } =
          await supabaseClient
            .from('profiles')
            .select(
              'id, email, avatar_url, display_name, bubble_style, chat_bg_color, chat_texture',
            )
            .in('id', missingIds);

        if (!profilesError && profilesData) {
          for (const p of profilesData) {
            profilesByUserId[p.id] = p;
          }
        }
      }

      // Now build onlineUsers from full presenceState (deduped per user_id)
      syncOnlineUsersFromPresenceState(state);
    };

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        syncFromPresenceState();
      })
      .on('presence', { event: 'join' }, () => {
        syncFromPresenceState();
      })
      .on('presence', { event: 'leave' }, () => {
        syncFromPresenceState();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({
            user_id: session.user.id,
            email: session.user.email,
            display_name: CURRENT_USERNAME,
          });
        }
      });
  }

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
    return now - created <= 5 * 60 * 1000;
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

      if (info.users.includes(CURRENT_USERNAME)) {
        chip.classList.add('active');
      }

      chip.onclick = (e) => {
        e.stopPropagation();
        openReactionDetails(messageId, emoji, containerEl); // just open/close list
      };

      containerEl.appendChild(chip);
    });
  }

  function openReactionDetails(messageId, emoji, containerEl) {
    // if this emoji's popup is already open in this bar, close it
    const existing = containerEl.querySelector('.reaction-details-popup');
    if (existing && existing.dataset.emoji === emoji) {
      existing.remove();
      return;
    }

    // otherwise close any other details popup globally
    document
      .querySelectorAll('.reaction-details-popup')
      .forEach((p) => p.remove());

    const map = MESSAGE_REACTIONS[messageId] || {};
    const info = map[emoji];
    if (!info || !info.users.length) return;

    const popup = document.createElement('div');
    popup.className = 'reaction-details-popup';
    popup.dataset.emoji = emoji;

    const header = document.createElement('div');
    header.className = 'reaction-details-header';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = `${emoji} • ${info.count} reaction${
      info.count > 1 ? 's' : ''
    }`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'reaction-details-close';
    closeBtn.textContent = '✕';
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      popup.remove();
    };

    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
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
          console.log('toggleReaction send', {
            messageId,
            emoji,
            userName: CURRENT_USERNAME,
          });
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

  async function reloadAllReactions() {
    if (!supabaseClient) return;

    try {
      const { data, error } = await supabaseClient
        .from('message_reactions')
        .select('message_id, user_name, emoji');

      if (error) throw error;

      // CLEAR object without reassigning
      Object.keys(MESSAGE_REACTIONS).forEach(
        (k) => delete MESSAGE_REACTIONS[k],
      );

      (data || []).forEach((r) => {
        if (!MESSAGE_REACTIONS[r.message_id]) {
          MESSAGE_REACTIONS[r.message_id] = {};
        }
        const map = MESSAGE_REACTIONS[r.message_id];

        if (!map[r.emoji]) {
          map[r.emoji] = { count: 0, users: [] };
        }
        const bucket = map[r.emoji];

        if (!bucket.users.includes(r.user_name)) {
          bucket.users.push(r.user_name);
          bucket.count += 1;
        }
      });

      messagesEl.querySelectorAll('.message-row').forEach((row) => {
        const mid = row.dataset.messageId;
        let bar = row.querySelector('.reaction-bar');
        if (!bar) {
          bar = document.createElement('div');
          bar.className = 'reaction-bar';
          row.appendChild(bar);
        }
        renderReactionBarForMessage(mid, bar);
      });
    } catch (err) {
      console.error('Reload reactions error', err);
    }
  }

  async function toggleReaction(messageId, emoji) {
    const userName = CURRENT_USERNAME;
    if (!supabaseClient) return;

    try {
      const { data: existing, error: checkError } = await supabaseClient
        .from('message_reactions')
        .select('id')
        .eq('message_id', messageId)
        .eq('user_name', userName)
        .eq('emoji', emoji)
        .maybeSingle();

      if (checkError) throw checkError;

      const userAlreadyReacted = !!existing;

      const reaction = {
        message_id: messageId,
        user_name: userName,
        emoji,
        action: userAlreadyReacted ? 'remove' : 'add',
      };

      if (!userAlreadyReacted) {
        const { error: insertError } = await supabaseClient
          .from('message_reactions')
          .insert({
            message_id: messageId,
            user_name: userName,
            emoji,
          }); // room_name removed
        if (insertError) throw insertError;
      } else {
        const { error: deleteError } = await supabaseClient
          .from('message_reactions')
          .delete()
          .eq('message_id', messageId)
          .eq('user_name', userName)
          .eq('emoji', emoji);
        if (deleteError) throw deleteError;
      }

      applyReactionToCacheAndUI(reaction);
      loadMessages();
      await reloadAllReactions();

      if (chatChannel) {
        await chatChannel.send({
          type: 'broadcast',
          event: REACTION_EVENT,
          payload: reaction,
        });
      }
    } catch (err) {
      logError('Reaction toggle error', err);
      showToast(
        'Failed to update reaction: ' + (err.message || 'Unknown error'),
        'error',
      );
    }
  }

  // === REACTIONS UI LOGIC (REPLACE THIS FUNCTION) ===
  function applyReactionToCacheAndUI(reaction) {
    const { message_id, user_name, emoji, action } = reaction;

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
        bucket.count -= 1;
      }
      if (bucket.count <= 0) {
        delete map[emoji];
      }
    }

    const row = messagesEl.querySelector(
      `.message-row[data-message-id="${message_id}"]`,
    );
    if (!row) return;

    let bar = row.querySelector('.reaction-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'reaction-bar';
      row.appendChild(bar);
    }

    renderReactionBarForMessage(message_id, bar);
  }

  // ===================================================

  // DELETE THIS IF IT STILL EXISTS
  function openImageViewer(url, caption = '') {
    if (!imageViewerEl || !imageViewerImg || !imageViewerCaption) return;
    imageViewerImg.src = url;
    imageViewerCaption.textContent = caption || url;
    imageViewerEl.style.display = 'flex';
  }

  function resolveTextureUrl(profile, meta) {
    const path = profile?.chat_texture || meta?.chat_texture;
    if (!path) return null;
    return path; // textures are local paths like "/textures/axiom-pattern.png"
  }
  function normalizeAvatarUrl(url) {
    if (!url) return null;

    const marker = '/storage/v1/object/public/profile-pictures/';
    const idx = url.lastIndexOf(marker);
    if (idx === -1) return url;

    const base = 'https://ehupnvkselcupxqyofzy.supabase.co';
    const path = url.substring(idx);
    return base + path;
  }

  function isValidAvatarUrl(url) {
    if (!url) return false;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  function renderOnlineUsers() {
    if (!onlineUsersContainer) return;
    onlineUsersContainer.innerHTML = '';

    if (!onlineUsers.length) {
      const empty = document.createElement('div');
      empty.className = 'story-item';
      empty.textContent = 'No one online';
      onlineUsersContainer.appendChild(empty);
      return;
    }

    onlineUsers.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'story-item story-item-enter'; // enter animation

      const avatar = document.createElement('div');
      avatar.className = 'story-avatar';

      const displayName = user.display_name || user.email || 'Unknown';
      const avatarUrl = user.avatar_url || null;

      if (avatarUrl) {
        const img = document.createElement('img');
        img.src = avatarUrl;
        img.alt = displayName;
        img.onerror = () => {
          avatar.textContent = (displayName || '?').charAt(0).toUpperCase();
        };
        avatar.appendChild(img);
      } else {
        avatar.textContent = (displayName || '?').charAt(0).toUpperCase();
      }

      const name = document.createElement('div');
      name.className = 'story-name';
      name.textContent = displayName;

      item.appendChild(avatar);
      item.appendChild(name);
      onlineUsersContainer.appendChild(item);

      // remove enter class after animation ends
      item.addEventListener(
        'animationend',
        () => {
          item.classList.remove('story-item-enter');
        },
        { once: true },
      );
    });
  }

  function syncOnlineUsersFromPresenceState(presenceState) {
    const byUserId = new Map();

    Object.values(presenceState).forEach((connections) => {
      connections.forEach((conn) => {
        const userId =
          conn.user_id ||
          conn.id ||
          (conn.user_meta && conn.user_meta.user_id) ||
          conn.uid;

        if (!userId) return;

        // Only keep first connection per user id
        if (!byUserId.has(userId)) {
          const profile = profilesByUserId[userId] || {};
          const meta = conn.user_meta || conn.meta || {};

          let avatarUrl = resolveAvatarUrl(profile, meta);
          if (!avatarUrl && LAST_AVATAR_BY_USER_ID[userId]) {
            avatarUrl = LAST_AVATAR_BY_USER_ID[userId];
          }

          const email =
            profile.email ||
            meta.email ||
            conn.email ||
            conn.user_email ||
            null;

          const displayName =
            profile.display_name ||
            meta.display_name ||
            conn.display_name ||
            email ||
            'Unknown';

          byUserId.set(userId, {
            id: userId,
            email,
            display_name: displayName,
            avatar_url: avatarUrl,
          });
        }
      });
    });

    onlineUsers = Array.from(byUserId.values());
    renderOnlineUsers();
  }

  function resolveAvatarUrl(profile, meta) {
    const raw = (meta && meta.avatar_url) || (profile && profile.avatar_url);
    if (!raw) return null;

    const normalized = normalizeAvatarUrl(raw);
    return isValidAvatarUrl(normalized) ? normalized : null;
  }

  // === COLOR RESOLUTION ===
  function getReadableTextColor(bg) {
    if (!bg || typeof bg !== 'string') return '#e5e7eb';
    const hex = bg.replace('#', '');
    if (hex.length !== 6) return '#e5e7eb';

    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);

    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.5 ? '#111827' : '#f9fafb';
  }

  function resolveMessageColors(msg) {
    const isMe = msg.user_id === session?.user?.id;
    const profile = profilesByUserId[msg.user_id] || {};
    const meta = msg.user_meta || {};

    const bgColor =
      profile.chat_bg_color ||
      meta.chat_bg_color ||
      (isMe ? '#2563eb' : '#1f2937');

    // for you, use profile/meta text if set; for others, derive when null
    const textColor =
      profile.chat_text_color ||
      meta.chat_text_color ||
      (isMe ? '#f9fafb' : getReadableTextColor(bgColor));

    return { isMe, profile, meta, bgColor, textColor };
  }

  function extractSingleGifUrl(text) {
    if (!text) return null;
    const trimmed = text.trim();

    try {
      const url = new URL(trimmed);
      if (url.pathname.toLowerCase().endsWith('.gif')) {
        return trimmed;
      }
    } catch {
      return null;
    }
    return null;
  }

  function getDateKey(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
  }

  function formatDateLabel(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const months = [
      'Jan.',
      'Feb.',
      'Mar.',
      'Apr.',
      'May',
      'Jun.',
      'Jul.',
      'Aug.',
      'Sep.',
      'Oct.',
      'Nov.',
      'Dec.',
    ];
    const month = months[d.getMonth()];
    return `${month} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function createDateDivider(dateStr) {
    const dateKey = getDateKey(dateStr);
    const label = formatDateLabel(dateStr);
    if (!dateKey || !label) return null;
    const divider = document.createElement('div');
    divider.className = 'date-divider';
    divider.dataset.dateKey = dateKey;
    divider.textContent = label;
    return divider;
  }

  async function loadMessageReads() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient
      .from('message_reads')
      .select('user_id, user_name, last_seen_at, room_name')
      .eq('room_name', ROOM_NAME);

    if (error) {
      console.error('Load message reads error', error);
      showToast(
        'Read status error: ' + (error.message || 'Unknown error'),
        'error',
      );
      return;
    }

    messageReadsByUserId = {};
    (data || []).forEach((row) => {
      if (row?.user_id) messageReadsByUserId[row.user_id] = row;
    });

    const ids = Object.keys(messageReadsByUserId).filter(
      (id) => !profilesByUserId[id],
    );
    if (ids.length) {
      const { data: profilesData, error: profilesError } = await supabaseClient
        .from('profiles')
        .select('id, avatar_url, display_name, email')
        .in('id', ids);
      if (!profilesError && profilesData) {
        profilesData.forEach((p) => {
          profilesByUserId[p.id] = p;
        });
      }
    }

    renderSeenBubbles();
  }

  function subscribeMessageReads() {
    if (!supabaseClient) return;
    if (readChangesChannel) {
      supabaseClient.removeChannel(readChangesChannel);
      readChangesChannel = null;
    }

    readChangesChannel = supabaseClient
      .channel(`room:${ROOM_NAME}:reads`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_reads',
          filter: `room_name=eq.${ROOM_NAME}`,
        },
        (payload) => {
          const row = payload.new || payload.old;
          if (!row?.user_id) return;
          messageReadsByUserId[row.user_id] = row;
          renderSeenBubbles();
        },
      )
      .subscribe();
  }

  async function markMySeen() {
    if (!supabaseClient || !session?.user) return;
    if (document.visibilityState !== 'visible') return;

    const payload = {
      room_name: ROOM_NAME,
      user_id: session.user.id,
      user_name: getDisplayNameFromUser(session.user),
      last_seen_at: new Date().toISOString(),
    };

    const { error } = await supabaseClient
      .from('message_reads')
      .upsert(payload, { onConflict: 'room_name,user_id' });

    if (error) {
      console.error('Update message read error', error);
      showToast(
        'Read status update failed: ' + (error.message || 'Unknown error'),
        'error',
      );
      return;
    }
    loadMessageReads();
    if (chatChannel) {
      chatChannel.send({
        type: 'broadcast',
        event: READS_EVENT,
        payload: { room: ROOM_NAME },
      });
    }
  }

  function getLatestMyMessageRow() {
    if (!messagesEl) return null;
    const rows = messagesEl.querySelectorAll('.message-row.me');
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (!row.classList.contains('message-deleted')) return row;
    }
    return null;
  }

  function createSeenBubble(user) {
    const bubble = document.createElement('div');
    bubble.className = 'seen-bubble';

    const profile = profilesByUserId[user.user_id] || {};
    const avatarUrl = resolveAvatarUrl(profile, profile);

    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.alt = user.user_name || 'User';
      bubble.appendChild(img);
    } else {
      const initials = document.createElement('span');
      initials.textContent = (user.user_name || 'U').charAt(0).toUpperCase();
      bubble.appendChild(initials);
    }

    return bubble;
  }

  function renderSeenBubbles() {
    if (!messagesEl) return;
    messagesEl.querySelectorAll('.seen-bubbles').forEach((el) => el.remove());

    const latestRow = getLatestMyMessageRow();
    if (!latestRow) return;

    const createdAt = new Date(latestRow.dataset.createdAt || '').getTime();
    if (!createdAt) return;

    const seenUsers = Object.values(messageReadsByUserId).filter((u) => {
      if (!u?.last_seen_at) return false;
      if (u.user_id === session?.user?.id) return false;
      return new Date(u.last_seen_at).getTime() >= createdAt;
    });

    if (!seenUsers.length) return;

    const container = document.createElement('div');
    container.className = 'seen-bubbles';

    const text = document.createElement('div');
    text.className = 'seen-text';
    const names = seenUsers
      .map((u) => u.user_name || profilesByUserId[u.user_id]?.display_name)
      .filter(Boolean);
    text.textContent = `Seen by ${names.join(', ')}`;
    container.appendChild(text);

    const icons = document.createElement('div');
    icons.className = 'seen-icons';
    seenUsers.forEach((user) => {
      icons.appendChild(createSeenBubble(user));
    });
    container.appendChild(icons);

    latestRow.appendChild(container);
  }

  function getReplyPreviewText(msg) {
    if (!msg || msg.deleted_at) return 'Message deleted';

    const raw = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (raw && raw !== '[image]') return raw;

    const hasImages =
      (Array.isArray(msg.image_urls) && msg.image_urls.length) || msg.image_url;
    if (hasImages) return '[image]';
    if (msg.file_name) return msg.file_name;

    if (msg.file_name) return msg.file_name;

    return raw || '';
  }

  function clampReplyText(text, maxLen = 140) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.slice(0, Math.max(0, maxLen - 3)) + '...';
  }

  let replyingTo = null;

  function updateReplyPreviewUI() {
    if (!replyPreviewEl) return;
    if (!replyingTo) {
      replyPreviewEl.hidden = true;
      if (replyPreviewNameEl) replyPreviewNameEl.textContent = '';
      if (replyPreviewTextEl) replyPreviewTextEl.textContent = '';
      return;
    }

    replyPreviewEl.hidden = false;
    if (replyPreviewNameEl) replyPreviewNameEl.textContent = replyingTo.user;
    if (replyPreviewTextEl) replyPreviewTextEl.textContent = replyingTo.preview;
  }

  function setReplyTarget(msg, displayName) {
    if (!msg) return;
    if (editingMessage) cancelEdit();

    const previewText = clampReplyText(getReplyPreviewText(msg));
    replyingTo = {
      id: msg.id,
      user: displayName || msg.user_name || 'Unknown',
      preview: previewText || 'Message',
    };

    updateReplyPreviewUI();
    messageInput?.focus();
  }

  function clearReplyTarget() {
    replyingTo = null;
    updateReplyPreviewUI();
  }

  function scrollToMessage(messageId) {
    if (!messagesEl || !messageId) return;
    const row = messagesEl.querySelector(
      `.message-row[data-message-id="${messageId}"]`,
    );
    if (!row) {
      showToast('Original message not loaded yet.', 'info');
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('message-highlight');
    setTimeout(() => row.classList.remove('message-highlight'), 1200);
  }

  const notifiedMessageIds = new Set();

  function getNotificationText(msg) {
    if (!msg || msg.deleted_at) return '';
    const raw = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (raw && raw !== '[image]') return raw;
    const hasImages =
      (Array.isArray(msg.image_urls) && msg.image_urls.length) || msg.image_url;
    if (hasImages) return '[image]';
    if (msg.file_name) return msg.file_name;
    return raw || '';
  }

  function showInAppNotification(msg) {
    if (!notificationList || !msg) return;
    if (!notificationsEnabled) return;

    const channelName = itemDisplayNameForRoom(msg.room_name || ROOM_NAME);
    const sender =
      msg.user_meta?.display_name ||
      msg.user_name ||
      msg.user_email ||
      'Unknown';
    const preview = getNotificationText(msg) || 'New message';

    const item = document.createElement('div');
    item.className = 'notification-item';
    item.dataset.messageId = msg.id;
    item.dataset.roomName = msg.room_name || ROOM_NAME;

    const title = document.createElement('div');
    title.className = 'notification-item-title';
    title.textContent = channelName;

    const subtitle = document.createElement('div');
    subtitle.className = 'notification-item-subtitle';
    subtitle.textContent = sender;

    const message = document.createElement('div');
    message.className = 'notification-item-message';
    message.textContent = preview;

    item.appendChild(title);
    item.appendChild(subtitle);
    item.appendChild(message);

    item.addEventListener('click', async () => {
      const room = item.dataset.roomName;
      const messageId = item.dataset.messageId;
      if (room && room !== ROOM_NAME) {
        await switchRoom(room);
      }
      scrollToMessage(messageId);
      item.remove();
      if (unreadNotifications > 0) {
        unreadNotifications -= 1;
        updateNotificationBadge();
      }
    });

    notificationList.prepend(item);
    unreadNotifications += 1;
    updateNotificationBadge();

    const items = notificationList.querySelectorAll('.notification-item');
    if (items.length > 50) {
      items[items.length - 1].remove();
    }
  }

  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'default') {
      try {
        return await Notification.requestPermission();
      } catch {
        return Notification.permission;
      }
    }
    return Notification.permission;
  }

  async function showBrowserNotification(msg) {
    if (!msg || msg.deleted_at) return;
    if (!('Notification' in window)) return;

    const permission = await ensureNotificationPermission();
    if (permission !== 'granted') return;

    const channelName = itemDisplayNameForRoom(msg.room_name || ROOM_NAME);
    const sender =
      msg.user_meta?.display_name ||
      msg.user_name ||
      msg.user_email ||
      'Unknown';
    const preview = getNotificationText(msg) || 'New message';

    const title = `${channelName} • ${sender}`;
    try {
      new Notification(title, {
        body: preview,
        tag: msg.id,
      });
    } catch {
      // ignore notification failures
    }
  }

  function handleIncomingNotification(msg) {
    if (!msg || msg.user_id === session.user.id) return;
    if (msg.deleted_at) return;

    if (notifiedMessageIds.has(msg.id)) return;
    notifiedMessageIds.add(msg.id);
    setTimeout(() => notifiedMessageIds.delete(msg.id), 60000);

    if (notificationsEnabled) {
      showInAppNotification(msg);
      if (document.visibilityState !== 'visible') {
        showBrowserNotification(msg);
      }
    }
  }

  // === MESSAGE RENDERING ===
  function createMessageRow(msg) {
    const { isMe, profile, meta, bgColor, textColor } =
      resolveMessageColors(msg);

    const resolvedFromMessage = resolveAvatarUrl(profile, meta);
    if (resolvedFromMessage) {
      LAST_AVATAR_BY_USER_ID[msg.user_id] = resolvedFromMessage;
    }

    const style = profile.bubble_style || meta.bubble_style || 'solid';
    const textureUrl = resolveTextureUrl(profile, meta);

    const displayName =
      profile.display_name ||
      meta.display_name ||
      msg.user_name ||
      msg.user_email ||
      'Unknown';

    const row = document.createElement('div');
    row.className = 'message-row ' + (isMe ? 'me' : 'other');
    row.dataset.messageId = msg.id;
    row.dataset.createdAt = msg.created_at;
    if (msg.deleted_at) {
      row.classList.add('message-deleted');
    }

    // BUBBLE
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const baseColor = bgColor;

    bubble.style.backgroundColor = baseColor;
    if (textColor) {
      bubble.style.color = textColor;
    }

    if (style === 'texture' && textureUrl) {
      bubble.style.backgroundImage = `url('${textureUrl}')`;
      bubble.style.backgroundRepeat = 'repeat';
      bubble.style.backgroundSize = '120px 120px';
      bubble.style.backgroundBlendMode = 'overlay';
      bubble.classList.add('texture');
    } else if (style === 'glass') {
      bubble.style.background = `linear-gradient(
      135deg,
      ${baseColor}66,
      rgba(255,255,255,0.1)
    )`;
      bubble.style.backdropFilter = 'blur(10px)';
      bubble.style.webkitBackdropFilter = 'blur(10px)';
      bubble.style.border = '1px solid rgba(255,255,255,0.1)';
      bubble.classList.add('glass');
    } else if (style === 'outline') {
      const fill = baseColor + '1A';
      bubble.style.background = fill;
      bubble.style.backgroundColor = fill;
      bubble.style.border = `1px solid ${baseColor}`;
      bubble.classList.add('outline');
    }

    // HEADER
    const header = document.createElement('div');
    header.className = 'message-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'message-header-left';

    // AVATAR (now inside bubble header)
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';

    const finalAvatarUrl = resolveAvatarUrl(profile, meta);
    const safeAvatarUrl = finalAvatarUrl;

    if (safeAvatarUrl) {
      const img = document.createElement('img');
      img.src = safeAvatarUrl;
      img.alt = displayName;
      img.onerror = () => {
        avatar.innerHTML = `<div class="avatar-fallback">${displayName
          .charAt(0)
          .toUpperCase()}</div>`;
      };
      avatar.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'avatar-fallback';
      fallback.textContent = displayName.charAt(0).toUpperCase();
      avatar.appendChild(fallback);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'message-meta';

    const usernameSpan = document.createElement('span');
    usernameSpan.className = 'message-username';
    usernameSpan.textContent = displayName;

    const dotSpan = document.createElement('span');
    dotSpan.className = 'message-dot';
    dotSpan.textContent = ' • ';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = formatTime(msg.created_at);

    metaEl.appendChild(usernameSpan);
    metaEl.appendChild(dotSpan);
    metaEl.appendChild(timeSpan);

    headerLeft.appendChild(avatar);
    headerLeft.appendChild(metaEl);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (!msg.deleted_at) {
      const replyBtn = document.createElement('button');
      replyBtn.className = 'message-action-btn reply-btn';
      replyBtn.textContent = 'Reply';
      replyBtn.onclick = () => setReplyTarget(msg, displayName);
      actions.appendChild(replyBtn);
    }

    if (isMe && !msg.deleted_at) {
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

    header.appendChild(headerLeft);
    header.appendChild(actions);
    bubble.appendChild(header);

    if (msg.updated_at && new Date(msg.updated_at) > new Date(msg.created_at)) {
      const badge = document.createElement('span');
      badge.className = 'edit-badge';
      badge.textContent = 'edited';
      header.appendChild(badge);
    }

    if (!msg.deleted_at && msg.reply_to_id) {
      const replyPreview = document.createElement('button');
      replyPreview.type = 'button';
      replyPreview.className = 'message-reply-preview';

      const replyLabel = document.createElement('div');
      replyLabel.className = 'message-reply-label';
      replyLabel.textContent = `Replying to ${
        msg.reply_to_user_name || 'message'
      }`;

      const replyText = document.createElement('div');
      replyText.className = 'message-reply-text';
      replyText.textContent = msg.reply_to_content || '';

      replyPreview.appendChild(replyLabel);
      replyPreview.appendChild(replyText);
      replyPreview.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollToMessage(msg.reply_to_id);
      });

      bubble.appendChild(replyPreview);
    }

    // MESSAGE TEXT + GIF / IMAGE HANDLING
    const textEl = document.createElement('div');
    textEl.className = 'message-text';

    let gifUrlFromText = null;

    if (msg.deleted_at) {
      const name = msg.deleted_by_name || displayName || 'Someone';
      textEl.textContent = `${name} just deleted this message`;
    } else if (msg.content) {
      gifUrlFromText = extractSingleGifUrl(msg.content);

      if (!gifUrlFromText) {
        const safe = escapeHtml(msg.content);
        const html = marked.parse(safe);

        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('[style]').forEach((el) => {
          el.style.color = '';
        });

        textEl.innerHTML = tmp.innerHTML;

        if (textColor) {
          textEl.style.color = textColor;
        }
      } else {
        // Content is just a GIF URL → hide URL text, GIF will be shown in image grid
        textEl.textContent = '';
      }
    }

    bubble.appendChild(textEl);

    // IMAGE GRID (message.image_urls / image_url + GIF from text)
    const urlsFromColumns =
      Array.isArray(msg.image_urls) && msg.image_urls.length
        ? msg.image_urls
        : msg.image_url
          ? [msg.image_url]
          : [];

    const allUrls = [...urlsFromColumns];
    if (gifUrlFromText) {
      allUrls.push(gifUrlFromText);
    }

    if (!msg.deleted_at && msg.file_url) {
      const fileCard = document.createElement('a');
      fileCard.className = 'message-file';
      fileCard.href = msg.file_url;
      fileCard.target = '_blank';
      fileCard.rel = 'noreferrer';

      const fileName = document.createElement('div');
      fileName.className = 'message-file-name';
      fileName.textContent = msg.file_name || 'Document';

      const fileSize = document.createElement('div');
      fileSize.className = 'message-file-size';
      fileSize.textContent = msg.file_size
        ? formatFileSize(Number(msg.file_size))
        : '';

      fileCard.appendChild(fileName);
      fileCard.appendChild(fileSize);
      bubble.appendChild(fileCard);
    }

    if (!msg.deleted_at && allUrls.length) {
      const grid = document.createElement('div');
      grid.className = 'message-image-grid';

      if (allUrls.length === 1) {
        grid.classList.add('single-image'); // special layout for one image
      }

      allUrls.slice(0, 4).forEach((url) => {
        const cell = document.createElement('div');
        cell.className = 'message-image-cell';
        const imgWrap = document.createElement('div');
        imgWrap.className = 'message-image';
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Image';
        img.loading = 'lazy';
        img.onclick = (e) => {
          e.stopPropagation();
          openImageViewer(url, '');
        };
        imgWrap.appendChild(img);
        cell.appendChild(imgWrap);
        grid.appendChild(cell);
      });
      bubble.appendChild(grid);
    }

    // REACTIONS
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

    const dateKey = getDateKey(msg?.created_at);

    if (prepend) {
      const firstChild = messagesEl.firstChild;
      const firstIsSameDateDivider =
        firstChild &&
        firstChild.classList?.contains('date-divider') &&
        firstChild.dataset.dateKey === dateKey;

      if (!firstIsSameDateDivider) {
        const existingDivider = messagesEl.querySelector(
          `.date-divider[data-date-key="${dateKey}"]`,
        );
        if (!existingDivider) {
          const divider = createDateDivider(msg?.created_at);
          if (divider) {
            messagesEl.insertBefore(divider, firstChild);
          }
        }
      }

      const anchor = firstIsSameDateDivider
        ? firstChild.nextSibling
        : firstChild;
      messagesEl.insertBefore(row, anchor);
    } else {
      if (dateKey && dateKey !== lastRenderedDateKey) {
        const divider = createDateDivider(msg?.created_at);
        if (divider) messagesEl.appendChild(divider);
        lastRenderedDateKey = dateKey;
      }
      messagesEl.appendChild(row);
    }

    // Do NOT override text for deleted messages
    if (!msg.deleted_at) {
      const textEl = row.querySelector('.message-text');
      if (textEl && typeof msg.content === 'string') {
        const safe = msg.content
          .split('\n')
          .map((line) =>
            line.replace(/[&<>"']/g, (ch) => {
              const map = {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
              };
              return map[ch];
            }),
          )
          .join('<br>');
        textEl.innerHTML = safe;
      }
    }

    row.classList.add('message-enter');
    row.addEventListener(
      'animationend',
      () => {
        row.classList.remove('message-enter');
      },
      { once: true },
    );

    lastRenderedUserName = msg.user_name;
    renderSeenBubbles();
    if (scroll) scrollToBottom();
  }

  // === LOAD INITIAL MESSAGES ===
  async function loadMessages() {
    if (!supabaseClient) return;

    try {
      const { data, error } = await supabaseClient
        .from('messages')
        .select('*')
        .eq('room_name', ROOM_NAME)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE);

      if (error) throw error;

      const rows = data || [];
      messagesEl.innerHTML = '';
      lastRenderedUserName = null;
      lastRenderedDateKey = null;

      oldestMessage = rows[0] || null;

      // collect all user ids from these messages
      const userIds = [...new Set(rows.map((m) => m.user_id).filter(Boolean))];
      const missingIds = userIds.filter((id) => !profilesByUserId[id]);

      // fetch any missing profiles before rendering
      if (missingIds.length) {
        const { data: profilesData, error: profilesError } =
          await supabaseClient
            .from('profiles')
            .select(
              'id, email, avatar_url, display_name, bubble_style, chat_bg_color, chat_text_color, chat_texture',
            )
            .in('id', missingIds);

        if (profilesError) throw profilesError;

        if (profilesData) {
          for (const p of profilesData) {
            profilesByUserId[p.id] = p;
          }
        }
      }

      // render messages from oldest -> newest
      rows
        .slice() // avoid mutating original array
        .reverse()
        .forEach((msg) => {
          // ensure we still work even if some profile is missing
          if (!profilesByUserId[msg.user_id] && msg.user_meta) {
            profilesByUserId[msg.user_id] = {
              id: msg.user_id,
              email: msg.user_email || msg.user_name || null,
              avatar_url: msg.user_meta.avatar_url || null,
              display_name: msg.user_meta.display_name || null,
              bubble_style: msg.user_meta.bubble_style || null,
              chat_bg_color: msg.user_meta.chat_bg_color || null,
              chat_text_color: msg.user_meta.chat_text_color || null,
              chat_texture: msg.user_meta.chat_texture || null,
            };
          }
          MESSAGE_CONTENT_CACHE[msg.id] = msg.content;
          renderMessage(msg, false);
        });

      scrollToBottom();
      renderSeenBubbles();
      markMySeen();
    } catch (err) {
      console.error('Load messages error:', err);
      showToast(
        'Load messages error: ' + (err.message || JSON.stringify(err)),
        'error',
      );
    }
  }

  // === LOAD OLDER ON SCROLL UP ===
  async function loadOlderMessages() {
    if (!oldestMessage || loadingOlder) return;
    loadingOlder = true;

    try {
      const prevHeight = messagesEl.scrollHeight;

      const { data, error } = await supabaseClient
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

        // NEW: fetch missing profiles for these older messages
        const userIds = [
          ...new Set(rows.map((m) => m.user_id).filter(Boolean)),
        ];
        const missingIds = userIds.filter((id) => !profilesByUserId[id]);

        if (missingIds.length) {
          const { data: profilesData, error: profilesError } =
            await supabaseClient
              .from('profiles')
              .select(
                'id, email, avatar_url, display_name, bubble_style, chat_bg_color, chat_text_color, chat_texture',
              )
              .in('id', missingIds);

          if (!profilesError && profilesData) {
            for (const p of profilesData) {
              profilesByUserId[p.id] = p;
            }

            rows.forEach((msg) => {
              const row = messagesEl.querySelector(
                `[data-message-id="${msg.id}"]`,
              );
              if (!row) return;
              const avatar = row.querySelector('.message-avatar');
              const profile = profilesByUserId[msg.user_id] || {};
              const displayName =
                profile.display_name || msg.user_name || 'Unknown';
              const finalAvatarUrl =
                msg.user_id === session?.user?.id ? userAvatarUrl : null;

              if (!avatar) return;
              avatar.innerHTML = '';

              if (finalAvatarUrl) {
                const img = document.createElement('img');
                img.src = finalAvatarUrl;
                img.alt = displayName;
                img.onerror = () => {
                  avatar.innerHTML = `<div class="avatar-fallback">${displayName
                    .charAt(0)
                    .toUpperCase()}</div>`;
                };
                avatar.appendChild(img);
              } else {
                const fallback = document.createElement('div');
                fallback.className = 'avatar-fallback';
                fallback.textContent = displayName.charAt(0).toUpperCase();
                avatar.appendChild(fallback);
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
      showToast('You can only EDIT messages within 5 minutes.', 'warning');
      return;
    }

    clearReplyTarget();

    let contentToEdit = MESSAGE_CONTENT_CACHE[msg.id];

    // --- CRITICAL FIX 3: Fetch the content from DB if cache is stale or missing ---
    if (!contentToEdit || contentToEdit === msg.content) {
      // If content is missing or appears to be the original DB content, fetch latest.
      const { data: latestMsg, error } = await supabaseClient
        .from('messages')
        .select('id, content, user_id, room_name')
        .eq('id', msg.id)
        .single();

      if (error || !latestMsg) {
        logError('Failed to fetch latest message for edit.', error);
        showToast('Failed to load message for editing.', 'error');
        return;
      }

      contentToEdit = latestMsg.content;

      // Update cache in case the initial load missed it
      MESSAGE_CONTENT_CACHE[latestMsg.id] = latestMsg.content;
    }
    // --- END CRITICAL FIX 3 ---

    // Use the latest known content
    editingMessage = {
      id: msg.id,
      content: contentToEdit,
      user_id: msg.user_id,
      room_name: msg.room_name,
    };
    messageInput.value = contentToEdit || '';

    // ... rest of the function ...
    messageInput.focus();

    const inputSection = document.querySelector('.input-section');
    // ...

    if (inputLabelEl) {
      inputLabelEl.hidden = false;
      inputLabelEl.textContent = 'Editing';
    }
  }

  function cancelEdit() {
    editingMessage = null;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    const inputSection = document.querySelector('.input-section');
    if (inputSection) inputSection.classList.remove('editing');

    if (inputLabelEl) {
      inputLabelEl.hidden = true;
      inputLabelEl.textContent = 'Write a message';
    }

    if (cancelEditBtn) cancelEditBtn.classList.remove('show');
  }

  function applyDeletedMessageToUI(msg) {
    const row = messagesEl.querySelector(`[data-message-id="${msg.id}"]`);
    if (!row) return;

    const content = row.querySelector('.message-text');
    if (content) {
      const name = msg.deleted_by_name || msg.user_name || 'Someone';
      content.textContent = `${name} just deleted this message`;
    }

    // REMOVE any images/GIFs visually
    const grid = row.querySelector('.message-image-grid');
    if (grid) {
      grid.remove();
    }

    row.classList.add('message-deleted');

    row.classList.add('message-leave');
    row.addEventListener(
      'animationend',
      () => {
        row.classList.remove('message-leave');
      },
      { once: true },
    );
  }

  async function deleteMessage(msg) {
    if (!canDelete(msg)) {
      showToast('You can only DELETE messages within 5 minutes', 'warning');
      return;
    }

    const result = await Swal.fire({
      title: 'Delete message?',
      text: 'Are you sure you want to delete this message?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel',
      reverseButtons: true,
      focusCancel: true,
      customClass: {
        popup: 'swal2-golden',
      },
      backdrop: 'rgba(15,23,42,0.75)',
      scrollbarPadding: false,
      heightAuto: false,
    });

    if (!result.isConfirmed) return; // Add check here

    try {
      const deletedByName = CURRENT_USERNAME; // or msg.user_name, etc.

      const { data, error } = await supabaseClient
        .from('messages')
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_name: deletedByName,
        })
        .eq('id', msg.id)
        .select()
        .single();

      if (error) throw error;

      // === NEW CODE: Delete all reactions for the message ===
      const { error: reactionsDeleteError } = await supabaseClient
        .from('message_reactions')
        .delete()
        .eq('message_id', msg.id);

      if (reactionsDeleteError) {
        console.warn(
          'Could not delete reactions for message:',
          reactionsDeleteError,
        );
        // Do not throw, as the message deletion itself succeeded.
      }
      // =======================================================

      await chatChannel.send({
        type: 'broadcast',
        event: 'message_deleted', // Use a new custom event name
        payload: data, // Send the full updated object, including deleted_at
      });

      // Optimistic UI update for yourself
      applyDeletedMessageToUI(data);

      showToast('Message deleted.', 'success');
    } catch (err) {
      logError('Delete error', err);
      showToast(
        'Failed to delete: ' + (err.message || 'Unknown error'),
        'error',
      );
    }
  }

  function updateExistingMessageContent(msg) {
    if (!msg || !msg.id) return;

    const row = messagesEl.querySelector(`[data-message-id="${msg.id}"]`);
    if (!row) return;

    const textEl = row.querySelector('.message-text');
    if (textEl) {
      const safe = escapeHtml(msg.content);
      const html = marked.parse(safe);

      // Re-apply message-rendering logic to preserve custom theme colors/styles
      const { textColor } = resolveMessageColors(msg);

      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      // Sanitize inline styles that marked.js might insert, like color
      tmp.querySelectorAll('[style]').forEach((el) => {
        el.style.color = '';
      });
      textEl.innerHTML = tmp.innerHTML;
      MESSAGE_CONTENT_CACHE[msg.id] = msg.content;
      if (textColor) {
        textEl.style.color = textColor;
      } else {
        textEl.style.color = '';
      }
    }

    // Add 'edited' badge to the message header
    let header = row.querySelector('.message-header');
    if (header) {
      // Remove any old badge before potentially adding a new one
      header.querySelectorAll('.edit-badge').forEach((b) => b.remove());

      const badge = document.createElement('span');
      badge.className = 'edit-badge';
      badge.textContent = 'edited';
      header.appendChild(badge);
    }

    // Apply a flash animation to highlight the change
    row.classList.add('message-updated');
    setTimeout(() => {
      row.classList.remove('message-updated');
    }, 1500);
  }

  // === SEND MESSAGE ===
  async function sendMessage() {
    if (!supabaseClient) return;
    if (!canSendNow()) return;

    const rawText = messageInput.value.trim();
    const filesToUpload = attachedImages.map((i) => i.file);
    const docToUpload = attachedFiles[0]?.file || null;
    if (!rawText && !filesToUpload.length && !docToUpload) return;
    if (docToUpload && docToUpload.size > 20 * 1024 * 1024) {
      showToast('Document is too large (max 20MB).', 'warning');
      return;
    }

    const CURRENT_USER = session.user;
    const userDisplayName = getDisplayNameFromUser(CURRENT_USER);
    const myProfile = profilesByUserId[CURRENT_USER.id];

    const userAvatarPath =
      myProfile?.avatar_url || null
        ? supabaseClient.storage
            .from('profile-pictures')
            .getPublicUrl(myProfile.avatar_url).data.publicUrl
        : null;

    const bubbleStyle = myProfile?.bubble_style || 'solid';
    const chatBgColor = myProfile?.chat_bg_color || '#2563eb';
    const chatTextColor = myProfile?.chat_text_color || null;
    const chatTexture = myProfile?.chat_texture || null;

    // EDIT MODE
    if (editingMessage) {
      if (!rawText) {
        showToast('Message cannot be empty.', 'warning');
        return;
      }

      const processedText = convertShortcodesToEmoji(rawText);

      try {
        const { data, error } = await supabaseClient
          .from('messages')
          .update({
            content: processedText,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingMessage.id)
          .select('*')
          .single();

        if (error) throw error;

        updateExistingMessageContent(data);

        await chatChannel.send({
          type: 'broadcast',
          event: 'message_edited',
          payload: data,
        });

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
    if (!rawText && !filesToUpload.length && !docToUpload) return;

    sendBtn.disabled = true;

    try {
      const uploadedUrls = [];

      for (const file of filesToUpload) {
        if (file.size > 8 * 1024 * 1024) {
          showToast(`Image "${file.name}" is too large (max 8MB).`, 'warning');
          continue;
        }

        showToast(`Uploading ${file.name}...`, 'info');
        const fileName = `${Date.now()}-${file.name}`;
        logInfo(
          '[Chat] Uploading to bucket chat-images. File name: ' + fileName,
        );

        const { data: uploadData, error: uploadError } =
          await supabaseClient.storage
            .from('chat-images')
            .upload(fileName, file, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: urlData, error: urlError } = supabaseClient.storage
          .from('chat-images')
          .getPublicUrl(uploadData.path);

        if (urlError) throw urlError;

        uploadedUrls.push(urlData.publicUrl);
        logInfo('[Chat] Image URL: ' + urlData.publicUrl);
      }

      let uploadedDocUrl = null;
      if (docToUpload) {
        showToast(`Uploading ${docToUpload.name}...`, 'info');
        const docFileName = `${Date.now()}-${docToUpload.name}`;
        const { data: docUploadData, error: docUploadError } =
          await supabaseClient.storage
            .from('chat-files')
            .upload(docFileName, docToUpload, { upsert: true });

        if (docUploadError) throw docUploadError;

        const { data: docUrlData, error: docUrlError } =
          supabaseClient.storage
            .from('chat-files')
            .getPublicUrl(docUploadData.path);

        if (docUrlError) throw docUrlError;
        uploadedDocUrl = docUrlData.publicUrl;
      }

      const processedText = convertShortcodesToEmoji(rawText);
      const hasText = processedText.trim().length > 0;
      const hasImages = uploadedUrls.length > 0;
      const hasFile = Boolean(uploadedDocUrl);
      if (docToUpload && !hasFile && !hasText && !hasImages) {
        showToast('Failed to upload document.', 'error');
        return;
      }

      const replyPayload = replyingTo
        ? {
            reply_to_id: replyingTo.id,
            reply_to_user_name: replyingTo.user,
            reply_to_content: replyingTo.preview,
          }
        : {};

      const payload = {
        room_name: ROOM_NAME,
        user_id: CURRENT_USER.id,
        user_name: CURRENT_USER.email,
        user_meta: {
          display_name: userDisplayName,
          avatar_url: userAvatarPath,
          bubble_style: bubbleStyle,
          chat_bg_color: chatBgColor,
          chat_text_color: chatTextColor,
          chat_texture: chatTexture,
        },
        content: hasText
          ? processedText
          : hasImages
            ? '[image]'
            : hasFile
              ? '[file]'
              : '',
        type: hasImages ? 'image' : hasFile ? 'file' : 'text',
        image_url: uploadedUrls[0] || null,
        image_urls: hasImages ? uploadedUrls : null,
        file_url: uploadedDocUrl,
        file_name: docToUpload ? docToUpload.name : null,
        file_size: docToUpload ? docToUpload.size : null,
        file_type: docToUpload ? docToUpload.type : null,
        ...replyPayload,
      };

      const { data, error } = await supabaseClient
        .from('messages')
        .insert(payload)
        .select('*')
        .single();

      if (error) throw error;

      const atBottom = isNearBottom();
      renderMessage(data, atBottom, false);
      if (!atBottom) newMsgBtn.style.display = 'block';

      await chatChannel.send({
        type: 'broadcast',
        event: 'message',
        payload: data,
      });

      clearReplyTarget();
    } catch (err) {
      logError('Send error (full object)', err);
      showToast('Failed to send: ' + (err.message || 'Unknown error'), 'error');
    } finally {
      // clear and RESET textarea height
      messageInput.value = '';
      messageInput.style.height = 'auto';

      imageInput.value = '';

      attachedImages.forEach((i) => URL.revokeObjectURL(i.url));
      attachedImages = [];
      attachedFiles = [];
      renderImagePreview();
      updateSendButtonState();
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
    if (e.key === 'Escape' && replyingTo) {
      e.preventDefault();
      clearReplyTarget();
      hideEmojiSuggestions();
      showToast('Reply cancelled.', 'info');
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
    const files = imageInput.files;
    if (!files || !files.length) {
      imageInput.value = '';
      return;
    }
    addAttachmentFiles(files);
    imageInput.value = '';
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

  function updateSendButtonState() {
    const hasText = messageInput.value.trim().length > 0;
    const hasImages = attachedImages.length > 0;
    const hasFiles = attachedFiles.length > 0;
    const shouldEnable = hasText || hasImages || hasFiles;

    if (textFieldContainer) {
      if (shouldEnable) {
        textFieldContainer.classList.add('chat-has-text');
        showSendBtn();
      } else {
        textFieldContainer.classList.remove('chat-has-text');
        hideSendBtn();
      }
    }
    sendBtn.disabled = !shouldEnable;
  }

  sendBtn.addEventListener('transitionend', (e) => {
    if (
      e.propertyName === 'opacity' &&
      sendBtn.classList.contains('send-btn--hiding')
    ) {
      sendBtn.style.display = 'none';
    }
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
      handleMessageInputChange();
    });

    emojiBtn.addEventListener('click', () => {
      picker.togglePicker(emojiBtn);
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

  // INIT
  loadImageViewerPartial();
  loadMessages();
  loadMessageReads();
  setupPresence();
  subscribeRealtime();
  subscribeMessageChanges();
  subscribeReactionTableChanges();
  subscribeMessageReads();
  loadInitialReactions();
  loadThemePreference();
  reloadAllReactions();
  markMySeen();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      markMySeen();
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadMessageReads();
    }
  }, 15000);

  let lastSeenMessageId = null;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const rows = messagesEl?.querySelectorAll('.message-row') || [];
    const latestRow = rows.length ? rows[rows.length - 1] : null;
    const latestId = latestRow?.dataset?.messageId || null;
    if (latestId && latestId !== lastSeenMessageId) {
      lastSeenMessageId = latestId;
      markMySeen();
    }
  }, 1000);
  const logoutBtn = document.getElementById('logoutBtn');
  const logoutOverlay = document.getElementById('logoutOverlay');
  const logoutConfirmBtn = document.getElementById('logoutConfirmBtn');
  const logoutCancelBtn = document.getElementById('logoutCancelBtn');
  const appLayout = document.querySelector('.app-layout');

  function openLogoutOverlay() {
    if (!logoutOverlay) return;
    logoutOverlay.classList.add('visible');
  }

  function closeLogoutOverlay() {
    if (!logoutOverlay) return;
    logoutOverlay.classList.remove('visible');
    logoutOverlay.classList.remove('closing');
    const progress = logoutOverlay.querySelector('.logout-progress');
    const bar = logoutOverlay.querySelector('.logout-progress-bar');
    if (progress) progress.classList.remove('active');
    if (bar) {
      bar.style.animation = 'none';
      bar.offsetHeight; // force reflow reset
      bar.style.animation = '';
    }
    if (appLayout) {
      appLayout.classList.remove('fading-out');
    }
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      openLogoutOverlay();
    });
  }

  if (logoutCancelBtn) {
    logoutCancelBtn.addEventListener('click', () => {
      closeLogoutOverlay();
    });
  }

  if (logoutConfirmBtn) {
    logoutConfirmBtn.addEventListener('click', async () => {
      if (!logoutOverlay) return;
      showToast('Logging out...', 'info');

      const progress = logoutOverlay.querySelector('.logout-progress');
      const bar = logoutOverlay.querySelector('.logout-progress-bar');

      if (progress && bar) {
        progress.classList.add('active');
        bar.style.animation = 'logoutProgress 3s linear forwards';
      }
      if (appLayout) {
        appLayout.classList.add('fading-out');
      }

      try {
        // 1) Supabase sign out
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
          logError('Error logging out', error);
          showToast('Logout failed.', 'error');
          closeLogoutOverlay();
          return;
        }

        // 2) Clear web storage
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch (e) {
          console.warn('Storage clear failed', e);
        }

        // 3) Clear Cache API entries (for your origin)
        if ('caches' in window) {
          try {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map((name) => caches.delete(name)));
          } catch (e) {
            console.warn('Cache clear failed', e);
          }
        }

        // 4) Optional: clear in-memory globals
        if (window.MESSAGE_REACTIONS) window.MESSAGE_REACTIONS = {};
        if (window.profilesByUserId) window.profilesByUserId = {};
        // add more as needed

        setTimeout(() => {
          if (logoutOverlay) {
            logoutOverlay.classList.add('closing');
          }
          window.location.href = '/login.html';
        }, 3000);
      } catch (err) {
        logError('Logout unexpected error', err);
        showToast('Logout failed.', 'error');
        closeLogoutOverlay();
      }
    });
  }

  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      window.location.href = '/settings.html';
    });
  }

  // HANDLE PASTE IMAGE INTO MESSAGE INPUT
  messageInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    addImageFiles(files);
    showToast('Image added from clipboard.', 'info');
  });

  textFieldContainer.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    addImageFiles(files);
    showToast('Image added from drag & drop.', 'info');
  });

  async function loadThemePreference() {
    if (!supabaseClient || !session?.user) return;

    const userId = session.user.id;

    const { data, error } = await supabaseClient
      .from('profiles')
      .select('theme_mode')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Failed to load theme preference', error);
      return;
    }

    const mode = data?.theme_mode === 'dark' ? 'dark' : 'light';

    // apply to body / app
    applyThemeMode(mode);

    // also apply to emoji picker container
    const picker = document.querySelector('.emoji-picker');
    if (picker) {
      picker.classList.remove('light', 'dark');
      picker.classList.add(mode); // 'dark' or 'light'
    }
  }

  function applyThemeMode(mode) {
    const body = document.body;
    if (mode === 'dark') {
      body.classList.add('dark-mode');
      body.classList.remove('light-mode');
    } else {
      body.classList.add('light-mode');
      body.classList.remove('dark-mode');
    }

    applyEmojiPickerTheme();
  }

  async function saveThemePreference(mode) {
    if (!supabaseClient || !session?.user) return;
    const userId = session.user.id;
    const { error } = await supabaseClient
      .from('profiles')
      .update({ theme_mode: mode })
      .eq('id', userId);

    if (error) {
      alert('Could not save theme preference.');
      showToast('Could not save theme preference.', 'error');
    }
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', async () => {
      const isDark = document.body.classList.contains('dark-mode');
      const newMode = isDark ? 'light' : 'dark';

      // keep your existing body theming
      applyThemeMode(newMode);
      await saveThemePreference(newMode);

      // simple: swap emoji-picker light/dark class
      const picker = document.querySelector('.emoji-picker');
      if (picker) {
        picker.classList.remove('light', 'dark');
        picker.classList.add(newMode); // 'light' or 'dark'
      }
    });
  }

  // Helper: sync emoji picker theme
  function applyEmojiPickerTheme() {
    if (!emojiPicker) return;
    const isDark = document.body.classList.contains('dark-mode');
    emojiPicker.setTheme(isDark ? 'dark' : 'light');
  }

  document.addEventListener('DOMContentLoaded', async () => {
    inputLabelEl = document.getElementById('inputLabel');
    sendIconEl = document.getElementById('sendIcon');
    cancelEditBtn = document.getElementById('cancelEditBtn');

    await bootstrapSession();
    await fetchMyProfileIfMissing();
    await initializeApp();
    applyThemeFromProfile();
  });

  async function initChat() {
    if (!supabaseClient) return;
    await loadMessages();
    await loadInitialReactions();
    await reloadAllReactions();
    await loadMessageReads();
    loadImageViewerPartial();
    await setupPresence();

    subscribeRealtime(); // broadcast: new msg, typing, reactions
    subscribeMessageChanges(); // DB changes: insert, update, delete
    subscribeReactionTableChanges();
    subscribeMessageReads();
    markMySeen();
  }
  initChat();
}

const appLayout = document.getElementById('appLayout');
const sidebarBurger = document.getElementById('sidebarBurger'); // in sidebar
const headerBurger = document.getElementById('headerBurger'); // in topbar
const mobileBackBtn = document.getElementById('mobileBackBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');

// From sidebar → go to chat
if (sidebarBurger && appLayout) {
  sidebarBurger.addEventListener('click', () => {
    appLayout.classList.add('chat-active'); // hide sidebar, show chat
  });
}

// From chat (topbar burger) → show sidebar
if (headerBurger && appLayout) {
  headerBurger.addEventListener('click', () => {
    appLayout.classList.remove('chat-active'); // show sidebar
  });
}

// From chat back arrow → show sidebar
if (mobileBackBtn && appLayout) {
  mobileBackBtn.addEventListener('click', () => {
    appLayout.classList.remove('chat-active');
  });
}

// Tap on backdrop (outside sidebar) should close sidebar on mobile
if (sidebarBackdrop && appLayout) {
  sidebarBackdrop.addEventListener('click', () => {
    appLayout.classList.add('chat-active');
  });
}

// PWA DOWNLOADER
let deferredPrompt = null;
const installBtn = document.getElementById('installPwaBtn');

if (installBtn) {
  installBtn.style.display = 'none';
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) {
    installBtn.style.display = 'inline-flex';
  }
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) {
      showToast('App is already installed or not installable.', 'info');
      return;
    }

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('Installing Tropang Tukmol…', 'success');
      installBtn.style.display = 'none';
    } else {
      showToast('Install cancelled.', 'info');
    }
    deferredPrompt = null;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const css = `

  .reaction-details-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  font-weight: 600;
  opacity: 0.9;
  }
  .reaction-details-close {
    border: none;
    border-radius: 999px;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    background: rgba(15, 23, 42, 0.85);
    color: #9ca3af;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease,
      transform 100ms ease,
      box-shadow 140ms ease;
  }

  .reaction-details-close:hover {
    background: rgba(31, 41, 55, 0.95);
    color: #facc15;
    transform: translateY(-1px);
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.65);
  }

  .reaction-details-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .reaction-details-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .reaction-remove-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    font-size: 12px;
    background: rgba(255, 255, 255, 0.12);
    color: #ff6b6b;
  }

  .edit-badge {
    position: absolute;
    top: -10px;
    left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    background: rgba(234, 179, 8, 0.16);
    color: #fbbf24;
    border: 1px solid rgba(234, 179, 8, 0.8);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.5);
  }

  .input-section.editing .text-field-container input {
    border-color: #fbbf24;
  }

  .cancel-edit-btn {
    margin-left: 8px;
    border-radius: 999px;
    border: none;
    width: 30px;
    height: 30px;
    background: rgba(15, 23, 42, 0.7);
    color: #e5e7eb;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      transform 0.12s ease,
      box-shadow 0.12s ease,
      background 0.15s ease;
  }

  .cancel-edit-btn.show {
    display: flex;
  }

  .cancel-edit-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 6px 14px rgba(15, 23, 42, 0.6);
    background: rgba(31, 41, 55, 0.95);
  }

  /* ==== DELETE CONFIRM MODAL ==== */

  .confirm-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.75);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 50;
    animation: backdrop-fade-in 180ms ease-out;
  }

  .confirm-modal {
    position: relative;
    width: min(420px, 92vw);
    padding: 20px 22px 18px;
    border-radius: 18px;
    background:
      radial-gradient(circle at top left, rgba(250, 204, 21, 0.12), transparent 55%),
      radial-gradient(circle at bottom right, rgba(245, 158, 11, 0.18), rgba(15, 23, 42, 0.96));
    border: 1px solid rgba(251, 191, 36, 0.6);
    box-shadow:
      0 18px 40px rgba(15, 23, 42, 0.9),
      0 0 0 1px rgba(15, 23, 42, 0.9);
    color: #f9fafb;
    transform-origin: center;
    animation: modal-pop-in 170ms cubic-bezier(0.18, 0.89, 0.32, 1.28);
    overflow: hidden;
  }

  .confirm-modal-glow {
    position: absolute;
    inset: -40%;
    background:
      radial-gradient(circle at 0 0, rgba(250, 204, 21, 0.18), transparent 55%),
      radial-gradient(circle at 100% 100%, rgba(245, 158, 11, 0.14), transparent 60%);
    opacity: 0.7;
    pointer-events: none;
    filter: blur(12px);
    z-index: -1;
  }

  .confirm-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .confirm-modal-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #facc15;
  }

  .confirm-modal-close {
    border: none;
    border-radius: 999px;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 23, 42, 0.85);
    color: #e5e7eb;
    cursor: pointer;
    transition:
      transform 120ms ease,
      background 140ms ease,
      box-shadow 140ms ease,
      color 140ms ease;
  }

  .confirm-modal-close:hover {
    transform: translateY(-1px);
    background: rgba(31, 41, 55, 0.95);
    color: #facc15;
    box-shadow: 0 6px 16px rgba(15, 23, 42, 0.85);
  }

  .confirm-modal-text {
    font-size: 14px;
    color: #e5e7eb;
    margin: 6px 0 14px;
  }

  .confirm-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-btn {
    position: relative;
    border-radius: 999px;
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    transition:
      transform 130ms ease,
      box-shadow 160ms ease,
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease;
  }

  .confirm-cancel {
    background: rgba(15, 23, 42, 0.85);
    color: #e5e7eb;
    border-color: rgba(148, 163, 184, 0.6);
  }

  .confirm-cancel:hover {
    transform: translateY(-1px);
    background: rgba(30, 64, 175, 0.35);
    border-color: rgba(129, 140, 248, 0.9);
    box-shadow: 0 8px 18px rgba(15, 23, 42, 0.95);
  }

  .confirm-delete {
    background: linear-gradient(135deg, #facc15, #f97316);
    color: #111827;
    border-color: rgba(250, 204, 21, 0.9);
    box-shadow: 0 8px 20px rgba(245, 158, 11, 0.6);
  }

  .confirm-delete::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: radial-gradient(circle at 0 0, rgba(250, 250, 250, 0.45), transparent 55%);
    opacity: 0;
    transition: opacity 180ms ease;
  }

  .confirm-delete:hover {
    transform: translateY(-1px);
    box-shadow:
      0 12px 28px rgba(245, 158, 11, 0.75),
      0 0 0 1px rgba(250, 250, 250, 0.18);
  }

  .confirm-delete:hover::after {
    opacity: 1;
  }

  @keyframes modal-pop-in {
    from {
      opacity: 0;
      transform: scale(0.86) translateY(6px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @keyframes backdrop-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
    
  `;

  const style = document.createElement('style');
  style.type = 'text/css';
  style.textContent = css;
  document.head.appendChild(style);
});

const refreshBtn = document.getElementById('refreshChatBtn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    refreshChat();
  });
}

async function refreshChat() {
  try {
    // 0) Optional: temporarily disable buttons while refreshing
    // refreshChatBtn.disabled = true;
    // 1) Clear in‑memory caches
    if (window.MESSAGE_REACTIONS) {
      MESSAGE_REACTIONS = {};
    }

    // 2) Clear UI messages
    if (messagesEl) {
      messagesEl.innerHTML = '';
    }

    // 3) Tear down old realtime / presence if you keep references
    if (chatChannel) {
      supabaseClient.removeChannel(chatChannel);
      chatChannel = null;
    }
    if (reactionChangesChannel) {
      supabaseClient.removeChannel(reactionChangesChannel);
      reactionChangesChannel = null;
    }

    // 4) Reload from DB (same as init)
    await loadMessages();
    await loadInitialReactions();
    await reloadAllReactions();
    await loadMessageReads();
    // 5) Re-init client-side extras and realtime
    loadImageViewerPartial();
    setupPresence();
    subscribeRealtime();
    subscribeReactionTableChanges(); // <- call it
    subscribeMessageReads();
    markMySeen();
    // refreshChatBtn.disabled = false;
  } catch (err) {
    console.error('Failed to refresh chat', err);
    // refreshChatBtn.disabled = false;
  }
}
// ------------------ END OF FILE --------------------
