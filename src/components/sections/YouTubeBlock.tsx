import { YouTubeStats } from "@/types/display";
import { getContentConfig } from "@/lib/config";
import { Youtube, Users, Video } from "lucide-react";
import Image from "next/image";

export function YouTubeBlock({ stats }: { stats: YouTubeStats | null }) {
    const config = getContentConfig();
    // Construct channel URL properly
    const channelUrl = config.general.youtube_channel_id
        ? `https://www.youtube.com/channel/${config.general.youtube_channel_id}`
        : `https://www.youtube.com/${config.general.youtube_handle}`;

    // Helper to format large numbers
    const formatCount = (n: string | undefined): string => {
        if (!n) return "—";
        const num = Number(n);
        if (isNaN(num)) return n;

        if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M+";
        if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K+";
        return num.toString();
    };

    return (
        <div className="rounded-2xl border border-navy-800 bg-gradient-to-b from-navy-900 to-navy-950 p-8 md:p-12 relative overflow-hidden group">
            {/* Background Decor */}
            <div className="absolute top-0 right-0 -mt-8 -mr-8 h-64 w-64 bg-red-600/5 rounded-full blur-3xl group-hover:bg-red-600/10 transition-colors duration-500 pointer-events-none"></div>

            <div className="relative z-10 flex flex-col md:flex-row items-center md:items-start gap-8">

                {/* Avatar */}
                <div className="flex-shrink-0">
                    {stats?.avatarUrl ? (
                        <img
                            src={stats.avatarUrl}
                            alt="Channel Avatar"
                            className="h-24 w-24 rounded-full border-2 border-navy-700 shadow-xl object-cover"
                        />
                    ) : (
                        <div className="h-24 w-24 rounded-full bg-navy-800 border-2 border-navy-700 flex items-center justify-center">
                            <Youtube className="h-10 w-10 text-slate-600" />
                        </div>
                    )}
                </div>

                {/* Info */}
                <div className="flex-1 text-center md:text-left">
                    <h2 className="text-3xl font-bold text-slate-100">
                        {config.general.youtube_handle || "My Channel"}
                    </h2>
                    <p className="mt-2 text-slate-400 max-w-xl leading-relaxed">
                        I create content about software development and tech.
                        Check out my latest videos on YouTube where I share tutorials, devlogs, and insights.
                    </p>

                    {/* Stats Grid */}
                    <div className="mt-6 flex flex-wrap justify-center md:justify-start gap-x-8 gap-y-4">
                        <div className="flex items-center gap-2">
                            <div className="p-2 rounded-full bg-navy-800/50 text-red-500">
                                <Users className="h-4 w-4" />
                            </div>
                            <div className="text-left">
                                <div className="text-lg font-bold text-slate-200">
                                    {stats ? formatCount(stats.subscriberCount) : "—"}
                                </div>
                                <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Subscribers</div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <div className="p-2 rounded-full bg-navy-800/50 text-slate-400">
                                <Video className="h-4 w-4" />
                            </div>
                            <div className="text-left">
                                <div className="text-lg font-bold text-slate-200">
                                    {stats ? formatCount(stats.videoCount) : "—"}
                                </div>
                                <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Videos</div>
                            </div>
                        </div>
                    </div>

                    <div className="mt-8">
                        <a
                            href={channelUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-full bg-red-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-red-900/20 hover:bg-red-700 hover:shadow-red-900/40 transition-all transform hover:-translate-y-0.5"
                        >
                            <Youtube className="h-5 w-5" />
                            Visit Channel
                        </a>
                    </div>
                </div>

            </div>
        </div>
    );
}
