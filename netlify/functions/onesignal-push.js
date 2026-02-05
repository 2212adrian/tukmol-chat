const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { title, message, url, include_player_ids } = JSON.parse(
      event.body || '{}',
    );
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

    const payload = {
      app_id: appId,
      target_channel: 'push',
      headings: { en: title },
      contents: { en: message },
      url: url || undefined,
      ...(Array.isArray(include_player_ids) && include_player_ids.length
        ? { include_player_ids }
        : { included_segments: ['Subscribed Users'] }),
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
