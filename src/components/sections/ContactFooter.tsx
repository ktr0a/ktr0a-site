import { getContentConfig } from "@/lib/config";

export function ContactFooter() {
    const config = getContentConfig();
    const year = new Date().getFullYear();

    return (
        <footer className="mt-auto border-t border-navy-800 bg-navy-950 py-12 px-6 text-center">
            <div className="mx-auto max-w-5xl">
                <p className="text-sm text-slate-500">
                    &copy; {year} {config.general.github_user}. All rights reserved.
                </p>
                <p className="mt-2 text-sm text-slate-600">
                    Built with Next.js & Tailwind.
                </p>
            </div>
        </footer>
    );
}
