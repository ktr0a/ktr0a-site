import { getContentConfig } from "@/lib/config";

export function Hero() {
    const config = getContentConfig();

    return (
        <section className="flex min-h-[50vh] flex-col justify-center px-6 pt-32 pb-16">
            <div className="mx-auto max-w-5xl w-full">
                <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
                    {config.general.site_description}
                </p>
                <h1 className="mb-6 text-5xl font-bold tracking-tight text-slate-100 sm:text-6xl">
                    Hi, I’m Qiang.
                </h1>
                <p className="max-w-xl text-lg leading-relaxed text-slate-400">
                    I build software and hardware projects, run a large Roblox YouTube channel,
                    and explore new technologies.
                </p>
            </div>
        </section>
    );
}
