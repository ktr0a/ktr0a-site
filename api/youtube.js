export default async function handler(req, res) {
  const apiKey = process.env.YT_API_KEY; // from Vercel env vars
  const channelId = "UC8hnH4AKJvODl9SK6bJu3pw";

  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`;

  try {
    const ytRes = await fetch(url);

    if (!ytRes.ok) {
      const text = await ytRes.text();
      return res.status(ytRes.status).json({ error: text });
    }

    const data = await ytRes.json();
    const stats = data.items?.[0]?.statistics;

    // No channel in the answer: a definite failure (the client backs off), never an empty 200.
    if (!stats) return res.status(502).json({ error: "No statistics in the YouTube response" });

    // Channel numbers move slowly: let Vercel's edge cache serve them (6 h fresh, 1 day stale).
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json(stats);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch YouTube data" });
  }
}
