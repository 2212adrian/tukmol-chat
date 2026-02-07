const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const {
      title,
      message,
      url,
      include_player_ids,
      include_external_user_ids,
      sender_player_id,
      sender_external_user_id,
      exclude_player_ids,
      exclude_external_user_ids,
    } = JSON.parse(event.body || '{}');
    if (!title || !message) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing title or message' }),
      };
    }

    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (!appId || !apiKey) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing OneSignal env vars' }),
      };
    }

    const normalizedIncludePlayerIds = Array.isArray(include_player_ids)
      ? include_player_ids.filter((id) => id && id !== sender_player_id)
      : null;
    const normalizedIncludeExternalUserIds = Array.isArray(include_external_user_ids)
      ? include_external_user_ids.filter((id) => id && id !== sender_external_user_id)
      : null;

    const normalizedExcludePlayerIds = [
      ...(Array.isArray(exclude_player_ids) ? exclude_player_ids : []),
      ...(sender_player_id ? [sender_player_id] : []),
    ].filter(Boolean);

    const normalizedExcludeExternalUserIds = [
      ...(Array.isArray(exclude_external_user_ids) ? exclude_external_user_ids : []),
      ...(sender_external_user_id ? [sender_external_user_id] : []),
    ].filter(Boolean);

    const payload = {
      app_id: appId,
      target_channel: 'push',
      headings: { en: title },
      contents: { en: message },
      url: url || undefined,
      ...(normalizedIncludePlayerIds && normalizedIncludePlayerIds.length
        ? { include_player_ids: normalizedIncludePlayerIds }
        : normalizedIncludeExternalUserIds && normalizedIncludeExternalUserIds.length
          ? { include_external_user_ids: normalizedIncludeExternalUserIds }
          : { included_segments: ['Subscribed Users'] }),
      ...(normalizedExcludePlayerIds.length ? { exclude_player_ids: normalizedExcludePlayerIds } : null),
      ...(normalizedExcludeExternalUserIds.length
        ? { exclude_external_user_ids: normalizedExcludeExternalUserIds }
        : null),
    };

    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await res.text();
    let data = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = null;
    }

    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: res.ok,
        status: res.status,
        data,
        raw: bodyText,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Unknown error' }),
    };
  }
};

module.exports = { handler };
