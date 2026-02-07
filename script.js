// script.js (ES module)
import { EmojiButton } from 'https://cdn.jsdelivr.net/npm/@joeattardi/emoji-button@4.6.4/dist/index.min.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@5.1.1/lib/marked.esm.js';

// OneSignal manages its own service worker (OneSignalSDKWorker.js)

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
let profileChangesChannel = null;
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
  const ACTIVE_ROOM_KEY = 'active_room';
  let ROOM_NAME = 'general-1'; // default room
  const savedRoom = localStorage.getItem(ACTIVE_ROOM_KEY);
  if (savedRoom) ROOM_NAME = savedRoom;
  const CURRENT_USER = session.user;
  const pendingProfileFetches = new Set();

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

  async function ensureProfileForUserId(userId, userMeta) {
    if (!supabaseClient || !userId) return;
    if (profilesByUserId[userId]) return;

    if (userMeta && Object.keys(userMeta).length) {
      profilesByUserId[userId] = {
        id: userId,
        email: userMeta.email || null,
        avatar_url: userMeta.avatar_url || null,
        display_name: userMeta.display_name || null,
        bubble_style: userMeta.bubble_style || null,
        chat_bg_color: userMeta.chat_bg_color || null,
        chat_text_color: userMeta.chat_text_color || null,
        chat_texture: userMeta.chat_texture || null,
      };
      return;
    }

    if (pendingProfileFetches.has(userId)) return;
    pendingProfileFetches.add(userId);
    try {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select(
          'id, email, avatar_url, display_name, bubble_style, chat_bg_color, chat_text_color, chat_texture',
        )
        .eq('id', userId)
        .single();

      if (!error && data) {
        profilesByUserId[userId] = data;
        applyProfileAppearanceToMessages(userId, data);
      }
    } finally {
      pendingProfileFetches.delete(userId);
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
    if (voiceJustStopped || voiceJustStarted) {
      voiceJustStopped = false;
      voiceJustStarted = false;
      return;
    }
    if (voiceRecordState === 'recording') {
      stopVoiceRecording();
      return;
    }
    if (voiceRecordState === 'ready') {
      sendVoiceMessage();
      return;
    }
    sendMessage();
  }

  if (sendBtn) {
    // Ensure listener is removed if initializeApp runs multiple times (e.g., in testing/hot-reload)
    sendBtn.removeEventListener('click', handleSendClick);
    // Attach the single, correct listener
    sendBtn.addEventListener('click', handleSendClick);

    sendBtn.addEventListener('pointerdown', () => {
      if (!canStartVoiceRecording()) return;
      if (voiceRecordState !== 'idle') return;
      if (voiceHoldTimerId) clearTimeout(voiceHoldTimerId);
      voiceHoldTimerId = setTimeout(() => {
        voiceHoldTimerId = null;
        startVoiceRecording();
      }, 200);
    });

    const releaseHold = () => {
      if (voiceHoldTimerId) {
        clearTimeout(voiceHoldTimerId);
        voiceHoldTimerId = null;
      }
    };

    sendBtn.addEventListener('pointerup', releaseHold);
    sendBtn.addEventListener('pointerleave', releaseHold);
    sendBtn.addEventListener('pointercancel', releaseHold);
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
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble me';

    // reset
    bubble.style.background = '';
    bubble.style.backgroundImage = '';
    bubble.style.boxShadow = '';
    bubble.style.border = '';
    bubble.style.color = '';

    // determine readable text color for this bubble
    const textColor = getReadableTextColor(baseColor) || '#f9fafb';

    if (bubbleStyle === 'outline') {
      const fill = baseColor + '1A'; // ~10% alpha
      bubble.classList.add('style-outline');
      bubble.style.background = fill;
      bubble.style.backgroundColor = fill;
      bubble.style.border = `1px solid ${baseColor}`;
      bubble.style.color = textColor;
    } else if (bubbleStyle === 'glass') {
      bubble.classList.add('style-glass');
      bubble.style.background = `linear-gradient(135deg, ${baseColor}33, rgba(15, 23, 42, 0.9))`;
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
        'id, email, avatar_url, display_name, bubble_style, chat_bg_color, chat_text_color, chat_texture',
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
            void ensureProfileForUserId(msg.user_id, msg.user_meta);
            if (msg.room_name === ROOM_NAME) {
              if (isMessageInCurrentRoom(msg.id)) {
                MESSAGE_CONTENT_CACHE[msg.id] = msg.content;
                updateExistingMessageContent(msg);
                updateChannelTimeForRoom(msg.room_name, msg.created_at);
                return;
              }
              msg._notify = true;
              const atBottom = isNearBottom();
              renderMessage(msg, atBottom, false);
              if (!atBottom) newMsgBtn.style.display = 'block';
              handleIncomingNotification(msg);
              updateChannelTimeForRoom(msg.room_name, msg.created_at);
              markMySeen();
            } else {
              handleIncomingNotification(msg);
              incrementChannelUnread(msg.room_name);
              updateChannelTimeForRoom(msg.room_name, msg.created_at);
            }
          } else if (payload.eventType === 'UPDATE') {
            const msg = payload.new;
            if (msg.room_name === ROOM_NAME) {
              if (msg.deleted_at) {
                applyDeletedMessageToUI(msg); // show "<name> just deleted this message"
              } else {
                updateExistingMessageContent(msg); // your edit handler
              }
            }
          } else if (payload.eventType === 'DELETE') {
            const oldMsg = payload.old;
            if (oldMsg?.room_name === ROOM_NAME) {
              removeMessageWithAnimation(oldMsg.id); // remove with fade
            }
          }
        },
      )
      .subscribe();
  }

  function subscribeProfileChanges() {
    if (!supabaseClient) return;

    if (profileChangesChannel) {
      supabaseClient.removeChannel(profileChangesChannel);
      profileChangesChannel = null;
    }

    profileChangesChannel = supabaseClient
      .channel('profiles-db-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'profiles',
        },
        (payload) => {
          const profile = payload.new;
          if (!profile?.id) return;
          profilesByUserId[profile.id] = profile;
          applyProfileAppearanceToMessages(profile.id, profile);
        },
      )
      .subscribe();
  }

  // Function is structurally correct, no change needed here.
  let reactionChannel;

  function subscribeReactionTableChanges(roomName = ROOM_NAME) {
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
    if (!messagesEl || !messageId) return false;
    return Boolean(
      messagesEl.querySelector(`.message-row[data-message-id="${messageId}"]`),
    );
  }

  // === DOM ELEMENTS ===
  const messagesEl = document.querySelector('.messages-container');
  const messageInput = document.getElementById('messageInput');
  const imageInput = document.getElementById('imageInput');
  const inputWrapper = document.querySelector('.input-wrapper');
  const isCoarsePointer =
    window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  sendBtn.style.display = 'none';
  const filePreview = document.getElementById('filePreview');
  const typingIndicator = document.getElementById('typingIndicator');
  const currentUsernameEl = document.getElementById('currentUsername');
  const inputLabelEl = document.getElementById('inputLabel');
  const sendIconEl = document.getElementById('sendIcon');
  const emojiBtn = document.getElementById('emojiBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const voiceRecordBar = document.getElementById('voiceRecordBar');
  const voiceRecordLabel = document.getElementById('voiceRecordLabel');
  const voiceRecordTimer = document.getElementById('voiceRecordTimer');
  const voiceRecordCancelBtn = document.getElementById('voiceRecordCancelBtn');
  const voiceRecordSpectrum = document.getElementById('voiceRecordSpectrum');
  const recordingOverlay = document.getElementById('recordingOverlay');
  if (voiceRecordBar) {
    voiceRecordBar.hidden = true;
    voiceRecordBar.style.display = 'none';
  }
  if (recordingOverlay) {
    recordingOverlay.hidden = true;
    recordingOverlay.style.display = 'none';
  }
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
  const messageCharCount = document.getElementById('messageCharCount');
  const sidebarUsername = document.getElementById('sidebarUsername');
  const MAX_SIDEBAR_NAME_LEN = 15;
  const formatSidebarUsername = (value) => {
    const name = String(value || '');
    if (name.length <= MAX_SIDEBAR_NAME_LEN) return name;
    return `${name.slice(0, MAX_SIDEBAR_NAME_LEN)}...`;
  };
  const onlineUsersContainer = document.getElementById('onlineUsersContainer');
  const allUsersOverlay = document.getElementById('allUsersOverlay');
  const allUsersList = document.getElementById('allUsersList');
  const allUsersCloseBtn = document.getElementById('allUsersCloseBtn');
  if (sidebarUsername)
    sidebarUsername.textContent = formatSidebarUsername(CURRENT_USERNAME);

  if (cancelReplyBtn) {
    cancelReplyBtn.addEventListener('click', () => {
      clearReplyTarget();
    });
  }

  let notificationsEnabled =
    localStorage.getItem('notifications_enabled') === 'true';
  let unreadNotifications = 0;
  let oneSignalSubId = localStorage.getItem('onesignal_sub_id') || '';
  let cachedOneSignalIds = null;
  let voiceRecordState = 'idle';
  let voiceRecorder = null;
  let voiceRecordStream = null;
  let voiceRecordChunks = [];
  let voiceRecordBlob = null;
  let voiceRecordTimerId = null;
  let voiceRecordTimeoutId = null;
  let voiceRecordStartAt = 0;
  let voiceRecordDurationMs = 0;
  let voiceRecordDiscard = false;
  let voiceJustStopped = false;
  let voiceJustStarted = false;
  let voiceHoldTimerId = null;
  let voiceAudioCtx = null;
  let voiceAnalyser = null;
  let voiceSpectrumRaf = null;

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

  const SEND_ICON_PATH = 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z';
  const MIC_ICON_PATH =
    'M12 3a4 4 0 0 1 4 4v4a4 4 0 1 1-8 0V7a4 4 0 0 1 4-4zm-1 14.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2a5 5 0 1 1-10 0H5a7 7 0 0 0 6 6.9z';
  const STOP_ICON_PATH = 'M6 6h12v12H6z';
  const sendBtnPath = sendBtn?.querySelector?.('svg path') || null;
  let sendBtnMode = 'send';

  function setSendButtonMode(mode) {
    if (!sendBtnPath || sendBtnMode === mode) return;
    sendBtnMode = mode;
    if (mode === 'mic') {
      sendBtnPath.setAttribute('d', MIC_ICON_PATH);
    } else if (mode === 'recording') {
      sendBtnPath.setAttribute('d', STOP_ICON_PATH);
    } else {
      sendBtnPath.setAttribute('d', SEND_ICON_PATH);
    }
  }

  function canStartVoiceRecording() {
    const hasText = messageInput?.value?.trim?.().length > 0;
    const hasImages = attachedImages.length > 0;
    const hasFiles = attachedFiles.length > 0;
    return !editingMessage && !hasText && !hasImages && !hasFiles;
  }

  function formatVoiceTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function updateVoiceRecordUI() {
    if (!voiceRecordBar) return;
    if (voiceRecordState === 'recording') {
      voiceRecordBar.hidden = false;
      voiceRecordBar.style.display = 'flex';
      if (voiceRecordLabel) voiceRecordLabel.textContent = 'Recording...';
      if (recordingOverlay) {
        recordingOverlay.hidden = false;
        recordingOverlay.style.display = 'flex';
      }
      if (inputWrapper) inputWrapper.classList.add('recording-active');
      setSendButtonMode('recording');
    } else if (voiceRecordState === 'ready') {
      voiceRecordBar.hidden = false;
      voiceRecordBar.style.display = 'flex';
      if (voiceRecordLabel) voiceRecordLabel.textContent = 'Ready to send';
      if (recordingOverlay) {
        recordingOverlay.hidden = true;
        recordingOverlay.style.display = 'none';
      }
      if (inputWrapper) inputWrapper.classList.add('recording-active');
      setSendButtonMode('send');
    } else {
      voiceRecordBar.hidden = true;
      voiceRecordBar.style.display = 'none';
      if (recordingOverlay) {
        recordingOverlay.hidden = true;
        recordingOverlay.style.display = 'none';
      }
      if (inputWrapper) inputWrapper.classList.remove('recording-active');
      setSendButtonMode(canStartVoiceRecording() ? 'mic' : 'send');
    }
  }

  function clearVoiceTimers() {
    if (voiceRecordTimerId) {
      clearInterval(voiceRecordTimerId);
      voiceRecordTimerId = null;
    }
    if (voiceRecordTimeoutId) {
      clearTimeout(voiceRecordTimeoutId);
      voiceRecordTimeoutId = null;
    }
  }

  function stopVoiceSpectrum() {
    if (voiceSpectrumRaf) {
      cancelAnimationFrame(voiceSpectrumRaf);
      voiceSpectrumRaf = null;
    }
    if (voiceAudioCtx) {
      voiceAudioCtx.close().catch(() => {});
      voiceAudioCtx = null;
    }
    voiceAnalyser = null;
    if (voiceRecordSpectrum) {
      const ctx = voiceRecordSpectrum.getContext('2d');
      if (ctx) {
        ctx.clearRect(
          0,
          0,
          voiceRecordSpectrum.width,
          voiceRecordSpectrum.height,
        );
      }
    }
  }

  function startVoiceSpectrum(stream) {
    if (!voiceRecordSpectrum || !stream) return;
    stopVoiceSpectrum();

    try {
      voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = voiceAudioCtx.createMediaStreamSource(stream);
      voiceAnalyser = voiceAudioCtx.createAnalyser();
      voiceAnalyser.fftSize = 64;
      source.connect(voiceAnalyser);

      const canvas = voiceRecordSpectrum;
      const ctx = canvas.getContext('2d');
      const bufferLength = voiceAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        if (!voiceAnalyser || !ctx) return;
        voiceAnalyser.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const barWidth = canvas.width / bufferLength;
        for (let i = 0; i < bufferLength; i++) {
          const v = dataArray[i] / 255;
          const barHeight = Math.max(2, v * canvas.height);
          const x = i * barWidth;
          ctx.fillStyle = 'rgba(248, 250, 252, 0.8)';
          ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
        }
        voiceSpectrumRaf = requestAnimationFrame(draw);
      };

      draw();
    } catch {
      // ignore spectrum failures
    }
  }

  function stopVoiceStream() {
    if (voiceRecordStream) {
      voiceRecordStream.getTracks().forEach((t) => t.stop());
      voiceRecordStream = null;
    }
    stopVoiceSpectrum();
  }

  function startVoiceTimer() {
    if (!voiceRecordTimer) return;
    voiceRecordTimer.textContent = '00:00';
    voiceRecordTimerId = setInterval(() => {
      const elapsed = Date.now() - voiceRecordStartAt;
      voiceRecordDurationMs = elapsed;
      voiceRecordTimer.textContent = formatVoiceTime(elapsed);
    }, 200);
  }

  async function startVoiceRecording() {
    if (voiceRecordState !== 'idle') return;
    if (!canStartVoiceRecording()) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('Audio recording not supported in this browser.', 'warning');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceRecordStream = stream;
      startVoiceSpectrum(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      voiceRecordChunks = [];
      voiceRecordBlob = null;
      voiceRecordDiscard = false;
      voiceRecordStartAt = Date.now();
      voiceRecordDurationMs = 0;
      voiceRecordState = 'recording';
      voiceJustStopped = false;
      voiceJustStarted = true;
      setTimeout(() => {
        voiceJustStarted = false;
      }, 300);
      updateVoiceRecordUI();
      startVoiceTimer();

      voiceRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      voiceRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          voiceRecordChunks.push(e.data);
        }
      };
      voiceRecorder.onstop = () => {
        clearVoiceTimers();
        stopVoiceStream();
        if (voiceRecordDiscard) {
          voiceRecordChunks = [];
          voiceRecordBlob = null;
          voiceRecordState = 'idle';
          updateVoiceRecordUI();
          return;
        }
        const type = voiceRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(voiceRecordChunks, { type });
        voiceRecordBlob = blob.size ? blob : null;
        voiceRecordState = voiceRecordBlob ? 'ready' : 'idle';
        updateVoiceRecordUI();
        if (!voiceRecordBlob) {
          showToast('Recording failed. Please try again.', 'error');
        }
      };

      voiceRecorder.start();
      voiceRecordTimeoutId = setTimeout(() => {
        stopVoiceRecording(true);
      }, 30000);

      if (navigator.vibrate) {
        navigator.vibrate(20);
      }
    } catch (err) {
      voiceRecordState = 'idle';
      updateVoiceRecordUI();
      showToast('Microphone access denied or unavailable.', 'warning');
    }
  }

  function stopVoiceRecording(fromTimeout = false) {
    if (voiceRecordState !== 'recording' || !voiceRecorder) return;
    voiceJustStopped = true;
    if (navigator.vibrate) {
      navigator.vibrate(10);
    }
    clearVoiceTimers();
    if (fromTimeout) {
      showToast('Recording stopped at 30 seconds.', 'info');
    }
    voiceRecorder.stop();
  }

  function cancelVoiceRecording() {
    voiceRecordDiscard = true;
    voiceRecordDurationMs = 0;
    if (voiceRecordState === 'recording' && voiceRecorder) {
      voiceRecorder.stop();
    } else {
      clearVoiceTimers();
      stopVoiceStream();
      voiceRecordChunks = [];
      voiceRecordBlob = null;
      voiceRecordState = 'idle';
      updateVoiceRecordUI();
    }
  }

  async function syncNotificationPermission() {
    if (!notificationToggle) return;
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

  function setOneSignalSubscription(enabled) {
    if (!window.OneSignalDeferred) return Promise.resolve(false);
    return new Promise((resolve) => {
      OneSignalDeferred.push(async function (OneSignal) {
        try {
          if (enabled) {
            if (
              OneSignal.Notifications?.isPushSupported &&
              !OneSignal.Notifications.isPushSupported()
            ) {
              resolve(false);
              return;
            }
            if (OneSignal.User?.PushSubscription?.optIn) {
              await OneSignal.User.PushSubscription.optIn();
            } else if (OneSignal.Notifications?.requestPermission) {
              await OneSignal.Notifications.requestPermission();
            }
          } else if (OneSignal.User?.PushSubscription?.optOut) {
            await OneSignal.User.PushSubscription.optOut();
          }
          const optedIn = OneSignal.User?.PushSubscription?.optedIn;
          resolve(enabled ? Boolean(optedIn) : optedIn === false);
        } catch {
          resolve(false);
        }
      });
    });
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
        const subscribed = await setOneSignalSubscription(true);
        if (!subscribed) {
          notificationsEnabled = false;
          localStorage.setItem('notifications_enabled', 'false');
          applyNotificationToggleState();
          showToast(
            'Push subscription failed or unsupported. Toggle turned off.',
            'warning',
          );
          return;
        }
        notificationsEnabled = true;
      } else {
        await setOneSignalSubscription(false);
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

  if (voiceRecordCancelBtn) {
    voiceRecordCancelBtn.addEventListener('click', () => {
      cancelVoiceRecording();
      updateSendButtonState();
    });
  }

  document.addEventListener('click', (e) => {
    if (!notificationPanel || notificationPanel.hidden) return;
    if (notificationPanel.contains(e.target)) return;
    if (notificationBtn && notificationBtn.contains(e.target)) return;
    setNotificationPanelVisible(false);
  });

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
  syncOneSignalIdentity();

  if (window.OneSignalDeferred) {
    OneSignalDeferred.push(function (OneSignal) {
      try {
        OneSignal.User?.PushSubscription?.addEventListener?.(
          'change',
          (event) => {
            const currentId = event?.current?.id;
            if (currentId) setOneSignalSubId(currentId);
          },
        );
      } catch {
        // ignore
      }
    });
  }

  setInterval(() => {
    syncOneSignalIdentity();
  }, 10000);
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
  const channelUnreadCounts = {};

  function ensureChannelBadge(roomName) {
    const item = document.querySelector(
      `.channel-item[data-room-name="${roomName}"]`,
    );
    if (!item) return null;
    const avatar = item.querySelector('.avatar-box');
    if (!avatar) return null;
    let badge = avatar.querySelector('.channel-unread-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'channel-unread-badge';
      badge.hidden = true;
      avatar.appendChild(badge);
    }
    return badge;
  }

  function incrementChannelUnread(roomName) {
    if (!roomName || roomName === ROOM_NAME) return;
    channelUnreadCounts[roomName] = (channelUnreadCounts[roomName] || 0) + 1;
    const badge = ensureChannelBadge(roomName);
    if (badge) {
      const count = channelUnreadCounts[roomName] || 0;
      badge.textContent = count ? String(count) : '';
      badge.hidden = count === 0;
    }
  }

  function clearChannelUnread(roomName) {
    channelUnreadCounts[roomName] = 0;
    const badge = ensureChannelBadge(roomName);
    if (badge) {
      badge.textContent = '';
      badge.hidden = true;
    }
  }

  function refreshChannelBadges() {
    channelItems.forEach((item) => {
      const room = item.getAttribute('data-room-name');
      if (!room) return;
      const count = channelUnreadCounts[room] || 0;
      const badge = ensureChannelBadge(room);
      if (!badge) return;
      badge.textContent = count ? String(count) : '';
      badge.hidden = count === 0;
    });
  }

  function setActiveRoomUI(room) {
    if (roomNameHeader) {
      roomNameHeader.textContent = itemDisplayNameForRoom(room);
    }
    channelItems.forEach((item) => {
      const itemRoom = item.getAttribute('data-room-name');
      item.classList.toggle('active', itemRoom === room);
      if (itemRoom === room) {
        const timeEl = item.querySelector('.time');
        if (timeEl) timeEl.textContent = 'Now';
      }
    });
  }

  channelItems.forEach((item) => {
    item.addEventListener('click', () => {
      const room = item.getAttribute('data-room-name');
      switchRoom(room);
    });
  });

  channelItems.forEach((item) => {
    const room = item.getAttribute('data-room-name');
    if (room) ensureChannelBadge(room);
  });
  refreshChannelBadges();
  setActiveRoomUI(ROOM_NAME);

  async function switchRoom(newRoom) {
    if (!newRoom || newRoom === ROOM_NAME) return;
    if (!supabaseClient) return;

    ROOM_NAME = newRoom;
    localStorage.setItem(ACTIVE_ROOM_KEY, newRoom);
    setActiveRoomUI(newRoom);
    clearChannelUnread(newRoom);
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
    if (reactionChannel) {
      supabaseClient.removeChannel(reactionChannel);
      reactionChannel = null;
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
    subscribeReactionTableChanges(ROOM_NAME); // EITHER keep this OR broadcast, not both
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

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const now = Date.now();
    const ts = new Date(isoString).getTime();
    if (Number.isNaN(ts)) return '';
    const diff = Math.max(0, now - ts);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function updateChannelTimeForRoom(roomName, createdAt) {
    const item = document.querySelector(
      `.channel-item[data-room-name="${roomName}"]`,
    );
    if (!item) return;
    const timeEl = item.querySelector('.time');
    if (!timeEl) return;
    const ts = new Date(createdAt || 0).getTime();
    const prev = Number(item.dataset.lastMessageTs || 0);
    if (ts && ts < prev) return;
    item.dataset.lastMessageTs = String(ts || prev || 0);
    const isActive =
      item.classList.contains('active') || roomName === ROOM_NAME;
    if (isActive) {
      timeEl.textContent = 'Now';
      return;
    }
    timeEl.textContent = createdAt
      ? formatRelativeTime(createdAt)
      : timeEl.textContent;
  }

  function refreshChannelTimeLabels() {
    channelItems.forEach((item) => {
      const ts = Number(item.dataset.lastMessageTs || 0);
      if (!ts) return;
      const timeEl = item.querySelector('.time');
      if (!timeEl) return;
      const room = item.getAttribute('data-room-name');
      const isActive = item.classList.contains('active') || room === ROOM_NAME;
      timeEl.textContent = isActive
        ? 'Now'
        : formatRelativeTime(new Date(ts).toISOString());
    });
  }

  async function refreshChannelTimes() {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient
      .from('messages')
      .select('room_name, created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return;

    const seen = new Set();
    (data || []).forEach((row) => {
      if (!row?.room_name || !row?.created_at) return;
      if (seen.has(row.room_name)) return;
      seen.add(row.room_name);
      updateChannelTimeForRoom(row.room_name, row.created_at);
    });
  }

  if (textFieldContainer) textFieldContainer.classList.remove('chat-has-text');
  const MAX_MESSAGE_CHARS = 1000;

  function updateMessageCharCount() {
    if (!messageCharCount || !messageInput) return;
    const count = messageInput.value.length;
    if (count <= 0) {
      messageCharCount.hidden = true;
      messageCharCount.textContent = '0';
      messageCharCount.classList.remove('over-limit');
      return;
    }
    messageCharCount.hidden = false;
    messageCharCount.textContent = String(count);
    if (count > MAX_MESSAGE_CHARS) {
      messageCharCount.classList.add('over-limit');
    } else {
      messageCharCount.classList.remove('over-limit');
    }
  }

  function handleMessageInputChange() {
    updateSendButtonState();
    updateMessageCharCount();

    const hasText = messageInput.value.trim().length > 0;
    const hasImages = attachedImages.length > 0;
    const hasFiles = attachedFiles.length > 0;

    // emoji suggestions
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
    if (voiceRecordState === 'ready') {
      cancelVoiceRecording();
    }
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
  if (sidebarUsername)
    sidebarUsername.textContent = formatSidebarUsername(CURRENT_USERNAME);
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
    if (voiceRecordState !== 'idle') {
      cancelVoiceRecording();
    }

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

  function renderMessageContent(rawText) {
    if (!rawText) return '';
    const lines = String(rawText).split('\n');
    const parts = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith('>>>')) {
        const blockLines = [line.slice(3).trimStart(), ...lines.slice(i + 1)];
        const blockHtml = blockLines
          .map((l) => {
            const safe = escapeHtml(l);
            return `<div class="quote-line">${marked.parseInline(safe)}</div>`;
          })
          .join('');
        parts.push(`<div class="quote-block">${blockHtml}</div>`);
        break;
      }

      if (line.startsWith('>')) {
        const safe = escapeHtml(line.slice(1).trimStart());
        parts.push(`<div class="quote-line">${marked.parseInline(safe)}</div>`);
        i += 1;
        continue;
      }

      if (line.startsWith('-# ')) {
        const safe = escapeHtml(line.slice(3));
        parts.push(`<div class="small-line">${marked.parseInline(safe)}</div>`);
        i += 1;
        continue;
      }

      const safe = escapeHtml(line);
      parts.push(`<div class="text-line">${marked.parseInline(safe)}</div>`);
      i += 1;
    }

    return parts.join('');
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

      let pressTimer = null;
      let longPressed = false;
      let suppressChipClick = false;
      const clearPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };
      chip.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        longPressed = false;
        clearPress();
        pressTimer = setTimeout(() => {
          longPressed = true;
          openReactionDetails(messageId, emoji, containerEl);
          clearPress();
        }, 250);
      });
      chip.addEventListener('touchend', (e) => {
        e.stopPropagation();
        clearPress();
        if (!longPressed) {
          toggleReaction(messageId, emoji);
          suppressChipClick = true;
          setTimeout(() => {
            suppressChipClick = false;
          }, 200);
        }
      });
      chip.addEventListener('touchmove', clearPress);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (suppressChipClick) return;
        toggleReaction(messageId, emoji); // toggle add/remove quickly
      });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openReactionDetails(messageId, emoji, containerEl); // details on right-click
      });

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

    document
      .querySelectorAll('.reaction-picker-popup')
      .forEach((p) => p.remove());

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

    const allItem = document.createElement('div');
    allItem.className = 'story-item story-item-all';
    const allAvatar = document.createElement('div');
    allAvatar.className = 'story-avatar';
    allAvatar.textContent = '+';
    const allName = document.createElement('div');
    allName.className = 'story-name';
    allName.textContent = 'See all users';
    allItem.appendChild(allAvatar);
    allItem.appendChild(allName);
    allItem.addEventListener('click', openAllUsersOverlay);
    onlineUsersContainer.appendChild(allItem);
  }

  function closeAllUsersOverlay() {
    if (!allUsersOverlay) return;
    allUsersOverlay.hidden = true;
  }

  async function openAllUsersOverlay() {
    if (!allUsersOverlay || !allUsersList || !supabaseClient) return;
    allUsersOverlay.hidden = false;
    allUsersList.innerHTML = '<div class="all-users-row">Loading...</div>';

    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, email, display_name, avatar_url')
      .order('display_name', { ascending: true });

    if (error) {
      allUsersList.innerHTML =
        '<div class="all-users-row">Failed to load users.</div>';
      return;
    }

    allUsersList.innerHTML = '';
    (data || []).forEach((user) => {
      const row = document.createElement('div');
      row.className = 'all-users-row';

      const avatar = document.createElement('div');
      avatar.className = 'all-users-avatar';
      const displayName = user.display_name || user.email || 'Unknown';
      if (user.avatar_url) {
        const img = document.createElement('img');
        img.src = user.avatar_url;
        img.alt = displayName;
        img.onerror = () => {
          avatar.textContent = displayName.charAt(0).toUpperCase();
        };
        avatar.appendChild(img);
      } else {
        avatar.textContent = displayName.charAt(0).toUpperCase();
      }

      const name = document.createElement('div');
      name.className = 'all-users-name';
      const email = user.email || '';
      name.textContent = email ? `${displayName} · ${email}` : displayName;

      row.appendChild(avatar);
      row.appendChild(name);
      allUsersList.appendChild(row);
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

  function cssColorToHex(color) {
    if (!color) return null;
    if (color.startsWith('#')) return color;
    const match = color.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return null;
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    const toHex = (v) => v.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
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

  function applyBubbleTheme(bubble, textEl, msg) {
    if (!bubble || !msg) return;
    const { profile, meta, bgColor, textColor } = resolveMessageColors(msg);
    const style = profile.bubble_style || meta.bubble_style || 'solid';
    const textureUrl = resolveTextureUrl(profile, meta);

    bubble.style.backgroundImage = '';
    bubble.style.backgroundRepeat = '';
    bubble.style.backgroundSize = '';
    bubble.style.backgroundBlendMode = '';
    // remove both generic and "me"-specific style classes to avoid stale classes
    bubble.classList.remove(
      'texture',
      'glass',
      'outline',
      'style-texture',
      'style-glass',
      'style-outline',
    );
    bubble.style.background = '';
    bubble.style.border = '';
    bubble.style.backdropFilter = '';
    bubble.style.webkitBackdropFilter = '';

    bubble.style.backgroundColor = bgColor;
    bubble.style.color = textColor || '';

    if (style === 'texture' && textureUrl) {
      bubble.style.backgroundImage = `url('${textureUrl}')`;
      bubble.style.backgroundRepeat = 'repeat';
      bubble.style.backgroundSize = '72px 72px';
      bubble.style.backgroundBlendMode = 'overlay';
      bubble.classList.add('texture');
      if (bubble.classList.contains('me'))
        bubble.classList.add('style-texture');
    } else if (style === 'glass') {
      bubble.style.background = `linear-gradient(135deg, ${bgColor}66, rgba(255,255,255,0.1))`;
      bubble.style.backdropFilter = 'blur(10px)';
      bubble.style.webkitBackdropFilter = 'blur(10px)';
      bubble.style.border = '1px solid rgba(255,255,255,0.1)';
      bubble.classList.add('glass');
      if (bubble.classList.contains('me')) bubble.classList.add('style-glass');
    } else if (style === 'outline') {
      const fill = bgColor + '1A';
      bubble.style.background = fill;
      bubble.style.backgroundColor = fill;
      bubble.style.border = `1px solid ${bgColor}`;
      bubble.classList.add('outline');
      if (bubble.classList.contains('me'))
        bubble.classList.add('style-outline');
    }

    if (textEl) textEl.style.color = textColor || '';
  }

  function getRowUserMeta(row) {
    if (!row) return {};
    const raw = row.dataset?.userMeta;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function applyProfileAppearanceToMessages(userId, profile) {
    if (!messagesEl || !userId) return;
    const rows = messagesEl.querySelectorAll(
      `.message-row[data-user-id="${userId}"]`,
    );
    if (!rows.length) return;

    rows.forEach((row) => {
      const bubble = row.querySelector('.message-bubble');
      if (!bubble) return;
      const textEl = row.querySelector('.message-text');
      const meta = getRowUserMeta(row);
      applyBubbleTheme(bubble, textEl, {
        user_id: userId,
        user_meta: meta,
      });
    });
  }

  function refreshAllBubbleThemes() {
    if (!messagesEl) return;
    const rows = messagesEl.querySelectorAll('.message-row');
    rows.forEach((row) => {
      const bubble = row.querySelector('.message-bubble');
      if (!bubble) return;
      const textEl = row.querySelector('.message-text');
      const userId = row.dataset.userId;
      if (!userId) return;
      const meta = getRowUserMeta(row);
      applyBubbleTheme(bubble, textEl, {
        user_id: userId,
        user_meta: meta,
      });
    });
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
    if (raw && raw !== '[image]' && raw !== '[audio]') return raw;
    if (raw === '[audio]') return 'Voice message';
    const hasImages =
      (Array.isArray(msg.image_urls) && msg.image_urls.length) || msg.image_url;
    if (hasImages) return '[image]';
    if (msg.file_name) return msg.file_name;
    return raw || '';
  }

  function getShareTextFromMessage(msg) {
    if (!msg) return '';
    if (msg.content && msg.content !== '[image]' && msg.content !== '[audio]') {
      return msg.content;
    }
    if (msg.file_url) return msg.file_url;
    const urls =
      Array.isArray(msg.image_urls) && msg.image_urls.length
        ? msg.image_urls
        : msg.image_url
          ? [msg.image_url]
          : [];
    if (urls.length) return urls.join('\n');
    if (msg.content) return msg.content;
    return '';
  }

  async function copyMessageContent(msg) {
    const text = getShareTextFromMessage(msg);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Message copied.', 'success');
    } catch {
      showToast('Failed to copy message.', 'error');
    }
  }

  async function shareMessageContent(msg) {
    const text = getShareTextFromMessage(msg);
    if (!text) return;
    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // ignore
      }
    }
    await copyMessageContent(msg);
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
        if (window.OneSignalDeferred) {
          await new Promise((resolve) => {
            OneSignalDeferred.push(async function (OneSignal) {
              try {
                if (OneSignal.Notifications?.requestPermission) {
                  await OneSignal.Notifications.requestPermission();
                } else {
                  await Notification.requestPermission();
                }
              } catch {
                // ignore
              } finally {
                resolve();
              }
            });
          });
          return Notification.permission;
        }
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
    showToast(
      `Notify attempt: ${title} | ${preview || ''} | ${permission}`,
      'info',
    );
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
    row.dataset.userId = msg.user_id;
    row.dataset.userMeta = JSON.stringify(msg.user_meta || {});
    if (msg.deleted_at) {
      row.classList.add('message-deleted');
      const bubbleEl = row.querySelector('.message-bubble');
      if (bubbleEl) bubbleEl.classList.add('message-deleted-bubble');
    }

    // BUBBLE
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    applyBubbleTheme(bubble, null, msg);

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
    actions.hidden = true;

    if (!msg.deleted_at) {
      const replyBtn = document.createElement('button');
      replyBtn.className = 'message-action-btn reply-btn';
      replyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4h7a4 4 0 0 0 4-4V9h-2v2a2 2 0 0 1-2 2h-7z"/></svg> Reply';
      replyBtn.onclick = () => setReplyTarget(msg, displayName);
      actions.appendChild(replyBtn);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'message-action-btn copy-btn';
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H10V7h9v14z"/></svg> Copy';
      copyBtn.onclick = () => copyMessageContent(msg);
      actions.appendChild(copyBtn);

      const shareBtn = document.createElement('button');
      shareBtn.className = 'message-action-btn share-btn';
      shareBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16a3 3 0 0 0-2.4 1.2L8.9 13a3.2 3.2 0 0 0 0-2l6.6-4.1A3 3 0 1 0 14 5a3 3 0 0 0 .1.8l-6.6 4.1a3 3 0 1 0 0 4.2l6.6 4.1A3 3 0 1 0 18 16z"/></svg> Share';
      shareBtn.onclick = () => shareMessageContent(msg);
      actions.appendChild(shareBtn);
    }

    if (isMe && !msg.deleted_at) {
      const editBtn = document.createElement('button');
      editBtn.className = 'message-action-btn edit-btn';
      editBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm18-10.5a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75L21 6.75z"/></svg> Edit';
      editBtn.onclick = () => editMessage(msg);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'message-action-btn delete-btn';
      deleteBtn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"/></svg> Delete';
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
      const safeName = escapeHtml(name);
      textEl.innerHTML = `<span class="deleted-message"><span class="deleted-message-name">${safeName}</span> just deleted this message</span>`;
    } else if (msg.content) {
      gifUrlFromText = extractSingleGifUrl(msg.content);

      if (!gifUrlFromText) {
        const html = renderMessageContent(msg.content);

        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        tmp.querySelectorAll('[style]').forEach((el) => {
          try {
            el.style.removeProperty('color');
          } catch (e) {
            el.style.color = '';
          }
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
      const isAudio =
        (msg.file_type && msg.file_type.startsWith('audio/')) ||
        msg.content === '[audio]';

      if (isAudio) {
        const audio = document.createElement('audio');
        audio.className = 'message-audio';
        audio.controls = true;
        audio.src = msg.file_url;
        audio.preload = 'metadata';
        bubble.appendChild(audio);

        const meta = document.createElement('div');
        meta.className = 'message-audio-meta';
        meta.textContent = 'Voice message';
        bubble.appendChild(meta);

        audio.addEventListener('loadedmetadata', () => {
          if (!Number.isFinite(audio.duration)) return;
          const seconds = Math.round(audio.duration);
          const m = String(Math.floor(seconds / 60)).padStart(2, '0');
          const s = String(seconds % 60).padStart(2, '0');
          meta.textContent = `Voice message â€¢ ${m}:${s}`;
        });
      } else {
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

    // Mobile gestures: long-press for react, swipe left to edit, swipe right to delete, double-tap to edit (own)
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;
    let longPressTimer = null;
    let longPressTriggered = false;
    let lastTapAt = 0;
    let isSwiping = false;
    let suppressClick = false;
    const swipeThreshold = 50;

    const createSwipeIndicator = (type) => {
      const el = document.createElement('div');
      el.className = `swipe-indicator swipe-indicator-${type}`;
      const icon =
        type === 'left'
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4h7a4 4 0 0 0 4-4V9h-2v2a2 2 0 0 1-2 2h-7z" /></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z" /></svg>';
      el.innerHTML = `<span class="swipe-indicator-icon">${icon}</span>`;
      return el;
    };

    const swipeLeftIndicator = createSwipeIndicator('left');
    bubble.appendChild(swipeLeftIndicator);
    const swipeRightIndicator = createSwipeIndicator('right');
    bubble.appendChild(swipeRightIndicator);

    const clearLongPress = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

      bubble.addEventListener('touchstart', (e) => {
        if (e.target && e.target.closest('.message-actions')) return;
        if (msg.deleted_at) return;
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
      touchMoved = false;
      longPressTriggered = false;
      isSwiping = false;
      bubble.style.transition = '';
      swipeLeftIndicator.style.opacity = '0';
      swipeRightIndicator.style.opacity = '0';

      clearLongPress();
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        if (navigator.vibrate) {
          navigator.vibrate(12);
        }
        openReactionPicker(msg.id, reactionBar);
      }, 500);
    });

      bubble.addEventListener('touchmove', (e) => {
        if (e.target && e.target.closest('.message-actions')) return;
        if (msg.deleted_at) return;
        const touch = e.touches[0];
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        touchMoved = true;
        clearLongPress();
      }
      const canSwipeLeft = dx < 0 && Math.abs(dy) < 55;
      const canSwipeRight = isMe && dx > 0 && Math.abs(dy) < 55;
      if (canSwipeLeft || canSwipeRight) {
        isSwiping = true;
        const clamped = Math.max(Math.min(dx, swipeThreshold), -swipeThreshold);
        bubble.style.transform = `translateX(${clamped}px)`;

        const progress = Math.min(Math.abs(clamped) / swipeThreshold, 1);
        if (clamped < 0) {
          swipeLeftIndicator.style.opacity = String(progress);
          if (swipeRightIndicator) swipeRightIndicator.style.opacity = '0';
          bubble.style.setProperty('--swipe-bg', 'rgba(59, 130, 246, 0.6)');
          bubble.style.setProperty('--swipe-opacity', String(progress * 0.9));
        } else {
          if (swipeRightIndicator)
            swipeRightIndicator.style.opacity = String(progress);
          swipeLeftIndicator.style.opacity = '0';
          bubble.style.setProperty('--swipe-bg', 'rgba(239, 68, 68, 0.7)');
          bubble.style.setProperty('--swipe-opacity', String(progress));
        }
      }
    });

      bubble.addEventListener('touchend', (e) => {
        clearLongPress();
        if (longPressTriggered) return;
        if (msg.deleted_at) return;
        if (e.target && e.target.closest('.message-actions')) return;

        const touch = e.changedTouches[0];
        const endX = touch?.clientX ?? touchStartX;
        const endY = touch?.clientY ?? touchStartY;
      const dx = endX - touchStartX;
      const dy = endY - touchStartY;

      if (!touchMoved && Math.abs(dy) > 60 && Math.abs(dx) < 40) {
        if (dy > 0) {
          copyMessageContent(msg);
        } else {
          shareMessageContent(msg);
        }
        bubble.style.transition = 'transform 160ms ease';
        bubble.style.transform = 'translateX(0px)';
        swipeLeftIndicator.style.opacity = '0';
        swipeRightIndicator.style.opacity = '0';
        bubble.style.setProperty('--swipe-opacity', '0');
        return;
      }

      // Swipe left to reply
      if (isSwiping && dx < -60 && Math.abs(dy) < 40) {
        setReplyTarget(msg, displayName);
        bubble.style.transition = 'transform 160ms ease';
        bubble.style.transform = 'translateX(0px)';
        swipeLeftIndicator.style.opacity = '0';
        bubble.style.setProperty('--swipe-opacity', '0');
        return;
      }

      // Swipe right to delete (own only)
      if (isSwiping && dx > 40 && Math.abs(dy) < 40) {
        if (isMe) {
          deleteMessage(msg);
        }
        bubble.style.transition = 'transform 160ms ease';
        bubble.style.transform = 'translateX(0px)';
        swipeRightIndicator.style.opacity = '0';
        bubble.style.setProperty('--swipe-opacity', '0');
        return;
      }

      // Double tap to edit own message
      if (!touchMoved && isMe && !msg.deleted_at) {
        const now = Date.now();
        if (now - lastTapAt < 300) {
          editMessage(msg);
          lastTapAt = 0;
          bubble.classList.remove('message-doubletap');
          void bubble.offsetWidth;
          bubble.classList.add('message-doubletap');
          const ripple = document.createElement('span');
          ripple.className = 'edit-ripple';
          bubble.appendChild(ripple);
          ripple.addEventListener(
            'animationend',
            () => {
              ripple.remove();
            },
            { once: true },
          );
          return;
        }
        lastTapAt = now;
      }

      if (!touchMoved && !msg.deleted_at && (!isMe || lastTapAt === 0)) {
        const isHidden = actions.hidden;
        document
          .querySelectorAll('.message-actions')
          .forEach((el) => (el.hidden = true));
        actions.hidden = !isHidden;
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 250);
      }

      if (isSwiping) {
        bubble.style.transition = 'transform 160ms ease';
        bubble.style.transform = 'translateX(0px)';
        swipeLeftIndicator.style.opacity = '0';
        swipeRightIndicator.style.opacity = '0';
        bubble.style.setProperty('--swipe-opacity', '0');
      }
    });

      bubble.addEventListener('click', (e) => {
        if (e.detail > 1) return;
        if (msg.deleted_at) return;
        if (suppressClick) return;
        if (e.target && e.target.closest('.message-actions')) return;
        const isHidden = actions.hidden;
        document
        .querySelectorAll('.message-actions')
        .forEach((el) => (el.hidden = true));
      actions.hidden = !isHidden;
    });

    return row;
  }

  function renderMessage(msg, scroll = true, prepend = false) {
    void ensureProfileForUserId(msg.user_id, msg.user_meta);
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

    row.classList.add('message-enter');
    row.addEventListener(
      'animationend',
      () => {
        row.classList.remove('message-enter');
      },
      { once: true },
    );

    lastRenderedUserName = msg.user_name;
    if (msg && msg._notify) {
      delete msg._notify;
      handleIncomingNotification(msg);
    }
    renderSeenBubbles();
    if (scroll) scrollToBottom();
  }

  function setOneSignalSubId(id) {
    if (id) {
      oneSignalSubId = id;
      localStorage.setItem('onesignal_sub_id', id);
    }
  }

  async function fetchOneSignalIds() {
    if (!supabaseClient) return [];
    if (Array.isArray(cachedOneSignalIds)) return cachedOneSignalIds;
    const { data, error } = await supabaseClient
      .from('onesignal_subscriptions')
      .select('onesignal_id');
    if (error) {
      showToast(
        'Failed to load OneSignal IDs: ' + (error.message || 'Unknown error'),
        'error',
      );
      return [];
    }
    const ids = data?.map((row) => row.onesignal_id).filter(Boolean) || [];
    cachedOneSignalIds = ids;
    return ids;
  }

  async function syncOneSignalIdentity() {
    if (!window.OneSignalDeferred || !session?.user?.id) return;

    OneSignalDeferred.push(async function (OneSignal) {
      try {
        if (
          typeof OneSignal.login === 'function' &&
          OneSignal.User?.externalId !== session.user.id
        ) {
          await OneSignal.login(session.user.id);
        }

        const isSubscribed =
          await OneSignal.User?.PushSubscription?.getOptedIn?.();

        if (isSubscribed) {
          await OneSignal.User.addTag('user_id', session.user.id);
        }

        const subId = OneSignal.User?.PushSubscription?.id;
        if (subId) setOneSignalSubId(subId);
      } catch {
        // intentionally ignored
      }
    });
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
          updateChannelTimeForRoom(msg.room_name, msg.created_at);
        });

      clearChannelUnread(ROOM_NAME);
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
              applyProfileAppearanceToMessages(p.id, p);
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
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    handleMessageInputChange();

    // ... rest of the function ...
    messageInput.focus();

    const inputSection = document.querySelector('.input-section');
    // ...

    if (inputLabelEl) {
      inputLabelEl.hidden = false;
      inputLabelEl.textContent = 'Editing';
    }
    if (cancelEditBtn) cancelEditBtn.classList.add('show');
  }

  function cancelEdit() {
    editingMessage = null;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    handleMessageInputChange();
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

    row.querySelectorAll('.edit-badge').forEach((b) => b.remove());
    row.querySelectorAll('.message-actions').forEach((a) => (a.hidden = true));

    const content = row.querySelector('.message-text');
    if (content) {
      const name = msg.deleted_by_name || msg.user_name || 'Someone';
      const safeName = escapeHtml(name);
      content.innerHTML = `<span class="deleted-message"><span class="deleted-message-name">${safeName}</span> just deleted this message</span>`;
    }

    // REMOVE any images/GIFs visually
    const grid = row.querySelector('.message-image-grid');
    if (grid) {
      grid.remove();
    }

    row.classList.add('message-deleted');
    const bubble = row.querySelector('.message-bubble');
    if (bubble) {
      bubble.classList.add('message-deleted-bubble');
    }
    applyBubbleTheme(bubble, content, msg);

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
    if (voiceRecordState !== 'idle') {
      cancelVoiceRecording();
      updateSendButtonState();
    }
    if (editingMessage) cancelEdit();
    if (replyingTo) clearReplyTarget();

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
      const html = renderMessageContent(msg.content);

      // Re-apply message-rendering logic to preserve custom theme colors/styles
      const { textColor } = resolveMessageColors(msg);

      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      // Sanitize inline styles that marked.js might insert, like color
      tmp.querySelectorAll('[style]').forEach((el) => {
        try {
          el.style.removeProperty('color');
        } catch (e) {
          el.style.color = '';
        }
      });
      textEl.innerHTML = tmp.innerHTML;
      MESSAGE_CONTENT_CACHE[msg.id] = msg.content;
      if (textColor) {
        textEl.style.color = textColor;
      } else {
        textEl.style.color = '';
      }
    }

    // Ensure bubble/theme is reapplied (handles texture/bg/color changes)
    const bubble = row.querySelector('.message-bubble');
    if (bubble) {
      // Keep row user_meta in sync for applyProfileAppearanceToMessages
      row.dataset.userMeta = JSON.stringify(msg.user_meta || {});
      applyBubbleTheme(bubble, row.querySelector('.message-text'), msg);
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
  async function sendVoiceMessage() {
    if (!supabaseClient || !voiceRecordBlob) return;
    if (!session?.user) return;

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

    sendBtn.disabled = true;

    try {
      const ext = voiceRecordBlob.type.includes('ogg')
        ? 'ogg'
        : voiceRecordBlob.type.includes('wav')
          ? 'wav'
          : 'webm';
      const fileName = `voice-${Date.now()}.${ext}`;
      showToast('Uploading voice message...', 'info');

      const { data: uploadData, error: uploadError } =
        await supabaseClient.storage
          .from('chat-files')
          .upload(fileName, voiceRecordBlob, {
            upsert: true,
            contentType: voiceRecordBlob.type || 'audio/webm',
          });

      if (uploadError) throw uploadError;

      const { data: urlData, error: urlError } = supabaseClient.storage
        .from('chat-files')
        .getPublicUrl(uploadData.path);

      if (urlError) throw urlError;

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
        content: '[audio]',
        type: 'audio',
        file_url: urlData.publicUrl,
        file_name: 'Voice message',
        file_size: voiceRecordBlob.size,
        file_type: voiceRecordBlob.type || 'audio/webm',
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

      try {
        const channelName = itemDisplayNameForRoom(ROOM_NAME);
        const sender = userDisplayName || CURRENT_USER.email || 'Someone';
        const preview = getNotificationText(data) || 'Voice message';
        const oneSignalIds = await fetchOneSignalIds();
        const res = await fetch('/.netlify/functions/onesignal-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `${channelName} â€¢ ${sender}`,
            message: preview,
            include_player_ids: oneSignalIds.length ? oneSignalIds : undefined,
            sender_player_id: oneSignalSubId || undefined,
            sender_external_user_id: CURRENT_USER?.id || undefined,
          }),
        });
        let pushPayload = null;
        try {
          pushPayload = await res.json();
        } catch {
          pushPayload = null;
        }

        if (!pushPayload || pushPayload.ok === false || !res.ok) {
          const errMsg =
            pushPayload?.data?.errors?.join?.(', ') ||
            pushPayload?.data?.error ||
            pushPayload?.raw ||
            'Unknown error';
          showToast(
            `Push failed (${pushPayload?.status || res.status}): ${errMsg}`,
            'error',
          );
        } else {
          const recipients =
            pushPayload?.data?.recipients ??
            pushPayload?.data?.id ??
            pushPayload?.recipients;
          const info = recipients
            ? ` Recipients: ${recipients}`
            : ' (no recipients)';
          showToast(`Push queued.${info}`, 'success');
        }
      } catch (err) {
        showToast(
          'Push send failed: ' + (err.message || 'Unknown error'),
          'error',
        );
      }

      clearReplyTarget();
    } catch (err) {
      logError('Voice send error', err);
      showToast(
        'Failed to send voice message: ' + (err.message || 'Unknown error'),
        'error',
      );
    } finally {
      voiceRecordBlob = null;
      voiceRecordChunks = [];
      voiceRecordState = 'idle';
      updateVoiceRecordUI();
      updateSendButtonState();
      sendBtn.disabled = false;
    }
  }

  async function sendMessage() {
    if (!supabaseClient) return;
    if (!canSendNow()) return;

    if (messageInput.value.length > MAX_MESSAGE_CHARS) {
      showToast(
        `Message is too long (max ${MAX_MESSAGE_CHARS} characters).`,
        'warning',
      );
      return;
    }

    const rawValue = applyPendingEmojiSuggestion(messageInput.value);
    if (rawValue !== messageInput.value) {
      messageInput.value = rawValue;
    }
    const rawText = rawValue.trim();
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

    const userAvatarPath = myProfile?.avatar_url
      ? supabaseClient.storage
          .from('profile-pictures')
          .getPublicUrl(myProfile.avatar_url).data.publicUrl
      : null;

    const bubbleStyle = myProfile?.bubble_style || 'solid';
    const chatBgColor = myProfile?.chat_bg_color || '#2563eb';
    const chatTextColor = myProfile?.chat_text_color || null;
    const chatTexture = myProfile?.chat_texture || null;

    // ======================
    // EDIT MODE
    // ======================
    if (editingMessage) {
      if (!rawText) {
        showToast('Message cannot be empty.', 'warning');
        return;
      }

      try {
        const processedText = convertShortcodesToEmoji(rawText);

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

        showToast('Message edited.', 'success');
        cancelEdit();
        return;
      } catch (err) {
        logError('Edit error', err);
        showToast(`Failed to edit: ${err.message || 'Unknown error'}`, 'error');
        return;
      }
    }

    // ======================
    // CREATE MODE
    // ======================
    sendBtn.disabled = true;

    try {
      const uploadedUrls = [];

      // ---- Upload images ----
      for (const file of filesToUpload) {
        if (file.size > 8 * 1024 * 1024) {
          showToast(`Image "${file.name}" is too large (max 8MB).`, 'warning');
          continue;
        }

        const fileName = `${Date.now()}-${file.name}`;
        showToast(`Uploading ${file.name}...`, 'info');

        const { data, error } = await supabaseClient.storage
          .from('chat-images')
          .upload(fileName, file, { upsert: true });

        if (error) throw error;

        const { data: urlData } = supabaseClient.storage
          .from('chat-images')
          .getPublicUrl(data.path);

        uploadedUrls.push(urlData.publicUrl);
      }

      // ---- Upload document ----
      let uploadedDocUrl = null;

      if (docToUpload) {
        showToast(`Uploading ${docToUpload.name}...`, 'info');

        const docFileName = `${Date.now()}-${docToUpload.name}`;
        const { data, error } = await supabaseClient.storage
          .from('chat-files')
          .upload(docFileName, docToUpload, { upsert: true });

        if (error) throw error;

        const { data: urlData } = supabaseClient.storage
          .from('chat-files')
          .getPublicUrl(data.path);

        uploadedDocUrl = urlData.publicUrl;
      }

      const processedText = convertShortcodesToEmoji(rawText);
      const hasText = processedText.length > 0;
      const hasImages = uploadedUrls.length > 0;
      const hasFile = Boolean(uploadedDocUrl);

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
        file_name: docToUpload?.name || null,
        file_size: docToUpload?.size || null,
        file_type: docToUpload?.type || null,
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

      // ======================
      // PUSH NOTIFICATION (FIXED)
      // ======================
      try {
        const channelName = itemDisplayNameForRoom(ROOM_NAME);
        const sender = userDisplayName || CURRENT_USER.email || 'Someone';
        const preview = getNotificationText(data) || 'New message';

        const res = await fetch('/.netlify/functions/onesignal-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `${channelName} • ${sender}`,
            message: preview,
            sender_external_user_id: CURRENT_USER.id, // exclude sender
          }),
        });

        const result = await res.json();

        if (!res.ok) {
          showToast(
            `Push failed: ${result?.errors || 'Unknown error'}`,
            'error',
          );
        }
      } catch (err) {
        showToast(
          `Push OneSignal service is unavaiable, try again later.`,
          'error',
        );
      }

      clearReplyTarget();
    } catch (err) {
      logError('Send error', err);
      showToast(`Failed to send: ${err.message || 'Unknown error'}`, 'error');
    } finally {
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
    selectedEmojiIndex = -1;
  }

  function showEmojiSuggestions(filterText, colonIndex) {
    if (!emojiSuggestionsEl) return;
    const matches = searchEmojiSuggestions(filterText);

    if (!matches.length) {
      hideEmojiSuggestions();
      return;
    }

    emojiSuggestionsEl.innerHTML = '';
    selectedEmojiIndex = 0;
    matches.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-suggestion-item';
      btn.textContent = `${item.emoji}  ${item.code}`;
      btn.dataset.emoji = item.emoji;
      btn.dataset.code = item.code;
      if (idx === selectedEmojiIndex) {
        btn.classList.add('selected');
      }
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

  function applyPendingEmojiSuggestion(text) {
    if (!emojiSuggestionsEl) return text;
    if (emojiSuggestionsEl.style.display !== 'block') return text;
    const items = emojiSuggestionsEl.querySelectorAll('.emoji-suggestion-item');
    if (!items.length) return text;

    const cursorPos = messageInput.selectionStart || text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const colonIndex = beforeCursor.lastIndexOf(':');
    if (colonIndex === -1) return text;
    const query = beforeCursor.slice(colonIndex + 1);
    if (!query || query.includes(' ') || query.includes('\n')) return text;

    const idx =
      typeof selectedEmojiIndex === 'number' && selectedEmojiIndex >= 0
        ? selectedEmojiIndex
        : 0;
    const item = items[idx] || items[0];
    const emoji = item?.dataset?.emoji;
    if (!emoji) return text;

    const next = text.slice(0, colonIndex) + emoji + text.slice(cursorPos);
    return next;
  }

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const allowSend = !isCoarsePointer || e.ctrlKey || e.metaKey;
      if (allowSend) {
        e.preventDefault();
        hideEmojiSuggestions();
        if (voiceRecordState === 'recording') {
          stopVoiceRecording();
          return;
        }
        if (voiceRecordState === 'ready') {
          if (!messageInput.value.trim()) {
            sendVoiceMessage();
            return;
          }
          cancelVoiceRecording();
        }
        sendMessage();
      }
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

  if (allUsersCloseBtn) {
    allUsersCloseBtn.addEventListener('click', closeAllUsersOverlay);
  }
  if (allUsersOverlay) {
    allUsersOverlay.addEventListener('click', (e) => {
      if (e.target === allUsersOverlay) closeAllUsersOverlay();
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
    const textLength = messageInput.value.length;
    const hasText = messageInput.value.trim().length > 0;
    const overLimit = textLength > MAX_MESSAGE_CHARS;
    const hasImages = attachedImages.length > 0;
    const hasFiles = attachedFiles.length > 0;
    const canRecord = canStartVoiceRecording();
    const shouldEnable =
      !overLimit &&
      (hasText ||
        hasImages ||
        hasFiles ||
        voiceRecordState === 'recording' ||
        voiceRecordState === 'ready' ||
        canRecord);
    const shouldShow =
      hasText ||
      hasImages ||
      hasFiles ||
      voiceRecordState !== 'idle' ||
      canRecord;

    if (textFieldContainer) {
      if (shouldShow) {
        textFieldContainer.classList.add('chat-has-text');
        showSendBtn();
      } else {
        textFieldContainer.classList.remove('chat-has-text');
        hideSendBtn();
      }
    }
    sendBtn.disabled = !shouldEnable || overLimit;

    if (hasText || hasImages || hasFiles || voiceRecordState === 'ready') {
      setSendButtonMode('send');
    } else if (voiceRecordState === 'recording') {
      setSendButtonMode('recording');
    } else if (canRecord) {
      setSendButtonMode('mic');
    } else {
      setSendButtonMode('send');
    }
  }

  sendBtn.addEventListener('transitionend', (e) => {
    if (
      e.propertyName === 'opacity' &&
      sendBtn.classList.contains('send-btn--hiding')
    ) {
      sendBtn.style.display = 'none';
    }
  });

  updateVoiceRecordUI();
  updateSendButtonState();
  updateMessageCharCount();

  // Emoji picker button
  if (emojiBtn) {
    const picker = new EmojiButton({
      position: 'top-end',
      autoHide: true,
      emojisPerRow: 6,
      rows: 5,
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

  // Close popups / actions on outside click
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target && target.closest('.message-bubble')) return;

    const picker = document.querySelector('.reaction-picker-popup');
    if (picker && !picker.contains(target)) {
      picker.remove();
    }

    const details = document.querySelector('.reaction-details-popup');
    if (details && !details.contains(target)) {
      details.remove();
    }

    const actions = document.querySelectorAll('.message-actions');
    if (actions.length) {
      const clickedInActions = Array.from(actions).some((a) =>
        a.contains(target),
      );
      if (!clickedInActions) {
        actions.forEach((a) => (a.hidden = true));
      }
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
  subscribeProfileChanges();
  subscribeReactionTableChanges(ROOM_NAME);
  subscribeMessageReads();
  loadInitialReactions();
  refreshChannelTimes();
  refreshChannelTimeLabels();
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshChannelTimeLabels();
    }
  }, 60000);
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

  setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshAllBubbleThemes();
    }
  }, 2000);

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
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  font-weight: 600;
  letter-spacing: 0.02em;
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
    background: rgba(148, 163, 184, 0.18);
    color: #cbd5f5;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease,
      transform 100ms ease,
      box-shadow 140ms ease;
  }

  .reaction-details-close:hover {
    background: rgba(248, 250, 252, 0.18);
    color: #f8fafc;
    transform: translateY(-1px);
    box-shadow: 0 6px 14px rgba(2, 6, 23, 0.35);
  }

  .reaction-details-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .reaction-details-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 10px;
    background: rgba(148, 163, 184, 0.08);
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
    background: rgba(239, 68, 68, 0.18);
    color: #f87171;
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
    window.location.reload();
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
    if (reactionChannel) {
      supabaseClient.removeChannel(reactionChannel);
      reactionChannel = null;
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
    subscribeReactionTableChanges(ROOM_NAME);
    subscribeMessageReads();
    markMySeen();
    // refreshChatBtn.disabled = false;
  } catch (err) {
    console.error('Failed to refresh chat', err);
    // refreshChatBtn.disabled = false;
  }
}
// ------------------ END OF FILE --------------------
