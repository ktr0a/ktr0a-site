import { YouTubeStats } from "@/types/display";
import { getContentConfig } from "./config";

const REVALIDATE_TIME = 3600 * 6; // 6 hours cache

export async function getYouTubeStats(): Promise<YouTubeStats | null> {
    const config = getContentConfig();
    const channelId = config.general.youtube_channel_id; // From TOML
    const apiKey = process.env.YT_API_KEY; // Legacy Vercel Env Var Name

    if (!channelId || !apiKey) {
        console.warn("YouTube env vars missing or config missing");
        return null;
    }

    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`;

    try {
        const res = await fetch(url, {
            next: { revalidate: REVALIDATE_TIME },
        });

        if (!res.ok) {
            console.error("YouTube API failed", res.status);
            return null;
        }

        const data = await res.json();
        const item = data.items?.[0];

        if (!item) return null;

        return {
            subscriberCount: item.statistics.subscriberCount,
            videoCount: item.statistics.videoCount,
            viewCount: item.statistics.viewCount,
            avatarUrl: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
            hidden: false,
        };
    } catch (error) {
        console.error("YouTube Fetch Error:", error);
        return null;
    }
}
