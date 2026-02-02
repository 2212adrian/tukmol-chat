'use strict';

// ========= SUPABASE CLIENT =========
const supabase = window.supabaseClient;

if (!supabase) {
  console.error('Supabase client not found in settings.js');
  // window.location.href = '/login.html';
}

// ========= TOAST HELPERS =========
function showToast(text, type = 'success') {
  let bg = 'linear-gradient(to right, #4b6cb7, #182848)';
  if (type === 'success') {
    bg = 'linear-gradient(to right, #00b09b, #96c93d)';
  } else if (type === 'error') {
    bg = 'linear-gradient(to right, #ff5f6d, #ffc371)';
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

function logError(message, extra) {
  console.error(message, extra ?? '');
  showToast(String(message), 'error');
}

// ========= CONSTANTS =========

// textures served from /textures
const TEXTURES = [
  '/textures/always-grey.png',
  '/textures/axiom-pattern.png',
  '/textures/black-thread-light.png',
  '/textures/black-twill.png',
  '/textures/cartographer.png',
  '/textures/checkered-pattern.png',
  '/textures/crisp-paper-ruffles.png',
  '/textures/crissxcross.png',
  '/textures/cubes.png',
  '/textures/cutcube.png',
  '/textures/dark-brick-wall.png',
  '/textures/dark-leather.png',
  '/textures/dark-mosaic.png',
  '/textures/diagmonds-light.png',
  '/textures/diagmonds.png',
  '/textures/diagonal-striped-brick.png',
  '/textures/diamond-upholstery.png',
  '/textures/elastoplast.png',
  '/textures/food.png',
  '/textures/grid-me.png',
  '/textures/light-wool.png',
  '/textures/padded.png',
  '/textures/pineapple-cut.png',
  '/textures/pinstripe-dark.png',
  '/textures/shattered-dark.png',
  '/textures/shattered.png',
];

const TARGET_SIZE_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const PAGE_SIZE = 12;

// ========= STATE =========

let session = null;
let currentUser = null; // auth user
let currentProfile = null; // row from public.profiles

let selectedBubbleStyle = 'solid';
let selectedTexture = null;
let compressedAvatarFile = null;

let filteredTextures = [...TEXTURES];
let currentTexturePage = 0;

// ========= DOM REFERENCES =========

const displayNameInput = document.getElementById('displayName');

const avatarTrigger = document.getElementById('profileAvatarTrigger');
const avatarInput = document.getElementById('avatarInput');
const avatarDisplay = document.getElementById('profileAvatar');

const newPasswordInput = document.getElementById('newPassword');
const confirmPasswordInput = document.getElementById('confirmPassword');

const bubbleStyleGroup = document.getElementById('bubbleStyleGroup');

const bgColorInput = document.getElementById('chatBgColor');
const bgColorHexInput = document.getElementById('chatBgColorHex');

// NEW: text color controls
const textColorInput = document.getElementById('chatTextColor');
const textColorHexInput = document.getElementById('chatTextColorHex');

const textureGrid = document.getElementById('textureGrid');
const texturePagination = document.getElementById('texturePagination');
const texturePageDots = document.getElementById('texturePageDots');
const textureSearchInput = document.getElementById('textureSearch');
const textureSuggestions = document.getElementById('textureSuggestions');

const bubblePreview = document.getElementById('bubblePreview');

const saveBtn = document.getElementById('settingsSaveBtn');
const backToChatBtn = document.getElementById('backToChatBtn');

// ========= COLOR BINDING =========

// background color
if (bgColorInput && bgColorHexInput) {
  bgColorInput.addEventListener('input', () => {
    bgColorHexInput.value = bgColorInput.value.toUpperCase();
    updateBubblePreview();
  });

  bgColorHexInput.addEventListener('input', () => {
    const val = bgColorHexInput.value.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
      bgColorInput.value = val;
      updateBubblePreview();
    }
  });
}

// text color
if (textColorInput && textColorHexInput) {
  textColorInput.addEventListener('input', () => {
    textColorHexInput.value = textColorInput.value.toUpperCase();
    updateBubblePreview();
  });

  textColorHexInput.addEventListener('input', () => {
    let val = textColorHexInput.value.trim();
    if (!val) return;
    if (!val.startsWith('#')) val = '#' + val;
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(val)) {
      textColorInput.value = val;
      textColorHexInput.value = val.toUpperCase();
      updateBubblePreview();
    }
  });
}

// ========= TEXTURES + PAGINATION =========

function getTotalTexturePages() {
  return Math.max(1, Math.ceil(filteredTextures.length / PAGE_SIZE));
}

function renderTextureGrid() {
  if (!textureGrid) return;

  textureGrid.innerHTML = '';

  const start = currentTexturePage * PAGE_SIZE;
  const slice = filteredTextures.slice(start, start + PAGE_SIZE);

  slice.forEach((path) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className =
      'texture-tile' + (path === selectedTexture ? ' selected' : '');
    tile.setAttribute('data-texture', path);

    const inner = document.createElement('div');
    inner.className = 'texture-tile-inner';
    inner.style.backgroundImage = `url('${path}')`;
    tile.appendChild(inner);

    textureGrid.appendChild(tile);
  });

  renderTexturePagination();
}

function renderTexturePagination() {
  if (!texturePagination || !texturePageDots) return;

  const totalPages = getTotalTexturePages();
  const prevBtn = texturePagination.querySelector('[data-dir="prev"]');
  const nextBtn = texturePagination.querySelector('[data-dir="next"]');

  if (prevBtn) prevBtn.disabled = currentTexturePage === 0;
  if (nextBtn) nextBtn.disabled = currentTexturePage >= totalPages - 1;

  texturePageDots.innerHTML = '';
  for (let i = 0; i < totalPages; i++) {
    const dot = document.createElement('div');
    dot.className = 'page-dot' + (i === currentTexturePage ? ' active' : '');
    dot.dataset.page = String(i);
    texturePageDots.appendChild(dot);
  }
}

function markSelectedTexture(textureUrl) {
  if (!textureGrid) return;
  const tiles = textureGrid.querySelectorAll('.texture-tile');
  tiles.forEach((tile) => {
    const url = tile.getAttribute('data-texture');
    tile.classList.toggle('selected', url === textureUrl);
  });
}

// ========= BUBBLE PREVIEW =========

function updateBubblePreview() {
  if (!bubblePreview) return;

  const bgColor = bgColorInput?.value || '#2563eb';
  const textColor = textColorInput?.value || '#f9fafb';

  // reset
  bubblePreview.classList.remove('texture-style');
  bubblePreview.style.backgroundImage = '';
  bubblePreview.style.background = '';
  bubblePreview.style.boxShadow = '';
  bubblePreview.style.color = '';
  bubblePreview.style.backgroundColor = '';
  bubblePreview.style.backgroundBlendMode = '';

  if (selectedBubbleStyle === 'texture' && selectedTexture) {
    bubblePreview.classList.add('texture-style');
    bubblePreview.style.backgroundImage = `url('${selectedTexture}')`;
    bubblePreview.style.backgroundColor = bgColor;
    bubblePreview.style.backgroundBlendMode = 'overlay';
  } else if (selectedBubbleStyle === 'glass') {
    bubblePreview.style.background = `linear-gradient(
      135deg,
      ${bgColor}33,
      rgba(15, 23, 42, 0.9)
    )`;
  } else if (selectedBubbleStyle === 'outline') {
    const base = bgColorInput?.value || '#2563eb';
    const fill = base + '1A'; // ~10% alpha
    bubblePreview.style.background = fill;
    bubblePreview.style.backgroundColor = fill;
    bubblePreview.style.boxShadow = `0 0 0 1px ${base}`;
  } else {
    // solid
    bubblePreview.style.background = bgColor;
    bubblePreview.style.boxShadow =
      '0 10px 24px rgba(15, 23, 42, 0.9), 0 0 0 1px rgba(37, 99, 235, 0.85)';
  }

  // finally apply text color
  bubblePreview.style.color = textColor;
}

// ========= SESSION + PROFILE LOAD =========

async function loadSession() {
  if (!supabase) return;

  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();

  if (sessionError || !sessionData?.session) {
    window.location.href = '/login.html';
    return;
  }

  session = sessionData.session;
  currentUser = session.user;

  const userId = currentUser.id;

  const profile = await loadProfile(userId);
  if (!profile) {
    window.location.href = '/login.html';
    return;
  }

  hydrateFromProfile(currentUser, profile);
  updateBubblePreview();
}

// load profile purely from profiles table
async function loadProfile(profileId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileId)
    .single();

  if (error) {
    console.error('Failed to load profile', error);
    return null;
  }

  currentProfile = data;
  return data;
}

function getDisplayNameFromUser(user) {
  return user.email || user.id;
}

function hydrateFromProfile(user, profile) {
  const p = profile || {};

  // display name field – only from profile or metadata, NOT email
  if (displayNameInput) {
    displayNameInput.value =
      p.display_name ||
      user.user_metadata?.display_name ||
      user.user_metadata?.full_name ||
      '';
  }

  // Background color
  const bgColor = p.chat_bg_color || '#020617';
  if (bgColorInput) bgColorInput.value = bgColor;
  if (bgColorHexInput) bgColorHexInput.value = bgColor;

  // Text color (NEW)
  const txtColor = p.chat_text_color || '#f9fafb';
  if (textColorInput) textColorInput.value = txtColor;
  if (textColorHexInput) textColorHexInput.value = txtColor;

  // Avatar display
  if (avatarDisplay) {
    avatarDisplay.innerHTML = '';
    if (p.avatar_url) {
      const img = document.createElement('img');
      img.src = p.avatar_url;
      img.alt = 'Profile avatar';
      avatarDisplay.appendChild(img);
    } else {
      const span = document.createElement('span');
      span.textContent = getDisplayNameFromUser(user).charAt(0).toUpperCase();
      avatarDisplay.appendChild(span);
    }
  }

  // Bubble style
  if (p.bubble_style) selectedBubbleStyle = p.bubble_style;

  // Texture
  if (p.chat_texture) {
    selectedTexture = p.chat_texture;
    markSelectedTexture(selectedTexture);
  }

  if (bubbleStyleGroup) {
    const buttons = bubbleStyleGroup.querySelectorAll('.bubble-toggle-option');
    buttons.forEach((btn) => {
      const style = btn.getAttribute('data-style');
      btn.classList.toggle('active', style === selectedBubbleStyle);
    });
  }
}

// ========= IMAGE COMPRESSION =========

function readFileAsImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => resolve({ img, src: e.target.result });
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, fileName) {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], fileName, { type: mime });
}

async function compressImageToTarget(file, targetBytes = TARGET_SIZE_BYTES) {
  const { img } = await readFileAsImage(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const maxDimension = 512;
  const ratio = Math.min(1, maxDimension / Math.max(img.width, img.height));
  canvas.width = Math.round(img.width * ratio);
  canvas.height = Math.round(img.height * ratio);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let quality = 0.9;
  let step = 0.1;
  let lastFile = null;

  while (quality > 0.1) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const approxBytes = Math.ceil((dataUrl.length * 3) / 4);
    if (approxBytes <= targetBytes) {
      lastFile = dataUrlToFile(
        dataUrl,
        file.name.replace(/\.\w+$/, '') + '.jpg',
      );
      break;
    }
    quality -= step;
    step *= 0.7;
  }

  if (!lastFile) {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.1);
    lastFile = dataUrlToFile(dataUrl, file.name.replace(/\.\w+$/, '') + '.jpg');
  }

  return lastFile;
}

// ========= AVATAR EVENTS =========

if (avatarTrigger && avatarInput) {
  avatarTrigger.addEventListener('click', () => avatarInput.click());

  avatarInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      showToast('Image is larger than 50MB.', 'error');
      avatarInput.value = '';
      return;
    }

    try {
      showToast('Compressing image...', 'success');
      const compressed = await compressImageToTarget(file);
      compressedAvatarFile = compressed;

      const reader = new FileReader();
      reader.onload = (ev) => {
        if (!avatarDisplay) return;
        avatarDisplay.innerHTML = '';
        const img = document.createElement('img');
        img.src = ev.target.result;
        avatarDisplay.appendChild(img);
      };
      reader.readAsDataURL(compressed);
      showToast('Image ready to upload.', 'success');
    } catch (err) {
      logError('Failed to process image.', err);
    }
  });
}

// ========= BUBBLE STYLE EVENTS =========

if (bubbleStyleGroup) {
  bubbleStyleGroup.addEventListener('click', (e) => {
    const target = e.target.closest('.bubble-toggle-option');
    if (!target) return;
    const style = target.getAttribute('data-style');
    if (!style) return;

    selectedBubbleStyle = style;
    bubbleStyleGroup
      .querySelectorAll('.bubble-toggle-option')
      .forEach((btn) => {
        btn.classList.toggle('active', btn === target);
      });

    updateBubblePreview();
  });
}

// ========= TEXTURE EVENTS =========

if (textureGrid) {
  textureGrid.addEventListener('click', (e) => {
    const tile = e.target.closest('.texture-tile');
    if (!tile) return;
    const textureUrl = tile.getAttribute('data-texture');
    if (!textureUrl) return;

    selectedTexture = textureUrl;
    markSelectedTexture(textureUrl);
    updateBubblePreview();
  });
}

if (textureSearchInput) {
  textureSearchInput.addEventListener('input', () => {
    const q = textureSearchInput.value.trim().toLowerCase();
    filteredTextures = TEXTURES.filter((path) =>
      path.toLowerCase().includes(q),
    );
    currentTexturePage = 0;
    renderTextureGrid();
  });
}

if (textureSuggestions) {
  textureSuggestions.addEventListener('click', (e) => {
    const tag = e.target.closest('.texture-tag');
    if (!tag) return;
    const query = tag.getAttribute('data-query') || '';
    if (textureSearchInput) textureSearchInput.value = query;

    const q = query.trim().toLowerCase();
    filteredTextures = TEXTURES.filter((path) =>
      path.toLowerCase().includes(q),
    );
    currentTexturePage = 0;
    renderTextureGrid();
  });
}

if (texturePagination) {
  texturePagination.addEventListener('click', (e) => {
    const prev = e.target.closest('[data-dir="prev"]');
    const next = e.target.closest('[data-dir="next"]');
    const dot = e.target.closest('.page-dot');

    const totalPages = getTotalTexturePages();

    if (prev && currentTexturePage > 0) {
      currentTexturePage--;
      renderTextureGrid();
    } else if (next && currentTexturePage < totalPages - 1) {
      currentTexturePage++;
      renderTextureGrid();
    } else if (dot) {
      const page = Number(dot.dataset.page || '0');
      if (!Number.isNaN(page)) {
        currentTexturePage = page;
        renderTextureGrid();
      }
    }
  });
}

// ========= PROFILE TABLE UPDATE =========

async function uploadAvatarIfNeeded(user) {
  if (!compressedAvatarFile) {
    // keep existing profile avatar if present
    return currentProfile?.avatar_url || null;
  }

  const file = compressedAvatarFile;
  const fileName = `${user.id}-${Date.now()}-${file.name}`;
  const { data, error } = await supabase.storage
    .from('profile-pictures')
    .upload(fileName, file, { upsert: true });

  if (error) {
    logError('Failed to upload avatar.', error);
    return currentProfile?.avatar_url || null;
  }

  const { data: urlData } = supabase.storage
    .from('profile-pictures')
    .getPublicUrl(data.path);

  return urlData.publicUrl;
}

// ========= PASSWORD CHANGE =========
async function handlePasswordChange(newPassword, confirmPassword) {
  if (!newPassword && !confirmPassword) return;

  if (!newPassword || !confirmPassword) {
    showToast('Enter and confirm your new password.', 'error');
    throw new Error('password_mismatch');
  }

  if (newPassword !== confirmPassword) {
    showToast('Passwords do not match.', 'error');
    throw new Error('password_mismatch');
  }

  // Optional: enforce your own minimum length before calling Supabase
  if (newPassword.length < 3) {
    showToast('Password must be at least 3 characters.', 'error');
    throw new Error('password_too_short');
  }

  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (error) {
    console.error('Supabase updateUser error:', error);
    showToast(error.message || 'Failed to change password.', 'error');
    throw error;
  }

  showToast('Changed Password Done!', 'success');
  return data;
}

// ========= SAVE HANDLER =========

async function handleSave() {
  if (!currentUser || !saveBtn) return;

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const user = currentUser;
    const newAvatarUrl = await uploadAvatarIfNeeded(user);

    const newBgColor =
      bgColorInput?.value || currentProfile?.chat_bg_color || '#020617';

    const newTextColor =
      textColorInput?.value || currentProfile?.chat_text_color || '#f9fafb';

    const newDisplayName =
      (displayNameInput && displayNameInput.value.trim()) ||
      currentProfile?.display_name ||
      user.user_metadata?.display_name ||
      user.email;

    // 1) Update public.profiles
    const { data: updatedProfile, error: profileError } = await supabase
      .from('profiles')
      .update({
        avatar_url: newAvatarUrl,
        bubble_style: selectedBubbleStyle,
        chat_bg_color: newBgColor,
        chat_text_color: newTextColor, // NEW
        chat_texture: selectedTexture || null,
        email: user.email,
        display_name: newDisplayName,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select('*')
      .single();

    if (profileError) throw profileError;
    currentProfile = updatedProfile;

    // 2) Optional: mirror display_name into auth user_metadata
    const newPassword = newPasswordInput?.value || '';
    const confirmPassword = confirmPasswordInput?.value || '';
    if (newPassword || confirmPassword) {
      await handlePasswordChange(newPassword, confirmPassword);
    }

    const { data: updatedUserData, error: authError } =
      await supabase.auth.updateUser({
        data: {
          ...(currentUser.user_metadata || {}),
          display_name: newDisplayName,
          avatar_url: newAvatarUrl,
        },
      }); // shape per v2 docs [web:212]

    if (authError) {
      logError('Failed to sync auth metadata.', authError);
    } else {
      currentUser = updatedUserData.user;
    }

    if (displayNameInput) displayNameInput.value = newDisplayName;
    compressedAvatarFile = null;
    if (newPasswordInput) newPasswordInput.value = '';
    if (confirmPasswordInput) confirmPasswordInput.value = '';

    showToast('Settings saved.', 'success');
  } catch (err) {
    if (err?.message !== 'password_mismatch') {
      logError('Failed to save settings.', err);
    }
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
  }
}

// ========= NAV + INIT =========

if (backToChatBtn) {
  backToChatBtn.addEventListener('click', () => {
    window.location.href = '/index.html';
  });
}

if (saveBtn) {
  saveBtn.addEventListener('click', handleSave);
}

// Initial textures + session
filteredTextures = [...TEXTURES];
renderTextureGrid();
loadSession();
