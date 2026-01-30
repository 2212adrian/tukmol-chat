// emojis.js
// Build a global EMOJI_DICT from a JSON file based on Unicode full emoji list. [web:184][web:194]
// Each final entry: { code, emoji, description, keywords }

window.EMOJI_DICT = [];

(async function buildEmojiDict() {
  try {
    // Adjust the path if you move the JSON file (e.g. 'data/full-emoji-list.json')
    const res = await fetch('full-emoji-list.json');
    if (!res.ok) {
      throw new Error('HTTP ' + res.status);
    }

    const rawList = await res.json(); // [{ code, emoji, description, keywords }, ...]

    const dict = rawList.map((entry) => {
      const desc = (entry.description || '').toLowerCase();
      const snake = desc.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const code = `:${snake}:`;

      return {
        code,
        emoji: entry.emoji,
        description: desc,
        keywords: entry.keywords || [],
      };
    });

    // Add common aliases users expect (point to existing base emojis)
    const aliases = [
      { alias: ':smile:', target: '😀' }, // grinning face
      { alias: ':happy:', target: '😄' }, // grinning face with smiling eyes
      { alias: ':lol:', target: '😂' }, // face with tears of joy
      { alias: ':cry:', target: '😭' }, // loudly crying face
      { alias: ':sad:', target: '😢' }, // crying face
      { alias: ':love:', target: '😍' }, // smiling face with heart-eyes
      { alias: ':heart:', target: '❤️' },
      { alias: ':thumbsup:', target: '👍' },
      { alias: ':ok:', target: '👌' },
      { alias: ':fire:', target: '🔥' },
      { alias: ':100:', target: '💯' },
    ];

    aliases.forEach(({ alias, target }) => {
      const found = dict.find((e) => e.emoji === target);
      if (found) {
        dict.push({
          code: alias,
          emoji: found.emoji,
          description: found.description,
          keywords: found.keywords,
        });
      }
    });

    window.EMOJI_DICT = dict;
    console.log('[Emoji] Loaded emojis:', window.EMOJI_DICT.length);
  } catch (e) {
    console.error('[Emoji] Failed to load emoji JSON', e);
    window.EMOJI_DICT = [];
  }
})();
