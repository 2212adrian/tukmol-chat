const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { title, message, url, sender_external_user_id } = JSON.parse(
      event.body || '{}',
    );

    if (!title || !message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing title or message' }),
      };
    }

    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (!appId || !apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing OneSignal env vars' }),
      };
    }

    const payload = {
      app_id: appId,
      target_channel: 'push',
      headings: { en: title },
      contents: { en: message },
      url: url || undefined,

      // ✅ Send to everyone
      included_segments: ['Subscribed Users'],

      // ✅ Exclude sender (ALL devices)
      ...(sender_external_user_id
        ? {
            filters: [
              {
                field: 'tag',
                key: 'user_id',
                relation: '!=',
                value: sender_external_user_id,
              },
            ],
          }
        : {}),
    };

    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      body: JSON.stringify({
        ok: res.ok,
        status: res.status,
        data,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Unknown error' }),
    };
  }
};

module.exports = { handler };
