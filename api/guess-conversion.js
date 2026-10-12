// Put this file in the same "api" folder as your other server functions (next to extract-receipt-items / match-items).
// It asks Claude which already-known item is the same KIND as a new receipt line, so the new line can borrow its
// "pieces in 1 unit" (e.g. a sack of rice borrows the sack size of sugar; notebooks borrow from exercise books).
// Adjust the first lines (export style / how you read the API key) to match your other functions.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { lines = [], refs = [] } = req.body || {};
    if (!lines.length || !refs.length) return res.status(200).json({ matches: [] });
    const system = 'You help a shop app. For each new receipt line (name + unit), choose ONE reference item that is the same KIND of product ' +
      '(similar category and sold/packed in a similar way, e.g. rice~sugar, notebook~exercise book) AND whose units list contains the same unit as the line. ' +
      'If no reference fits, leave it out. Reply with JSON only: {"matches":[{"i":<line index>,"ref_id":"<reference id>"}]}';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 800, system, messages: [{ role: 'user', content: JSON.stringify({ lines, refs }) }] })
    });
    const j = await r.json();
    const text = (j.content && j.content[0] && j.content[0].text) || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    const out = m ? JSON.parse(m[0]) : { matches: [] };
    return res.status(200).json({ matches: Array.isArray(out.matches) ? out.matches : [] });
  } catch (e) {
    return res.status(200).json({ matches: [] });
  }
}
