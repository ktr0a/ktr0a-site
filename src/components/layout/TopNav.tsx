import Link from "next/link";
import { getContentConfig } from "@/lib/config";

export function TopNav() {
    const config = getContentConfig();

    return (
        <nav className="fixed top-0 z-50 w-full border-b border-navy-800 bg-navy-950/80 backdrop-blur-md">
            <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
                <div className="text-sm font-bold tracking-wider text-slate-100 uppercase">
                    {config.general.site_title}
                </div>
                <div className="flex gap-6 text-sm font-medium text-slate-400">
                    <Link href="#projects" className="hover:text-blue-500 transition-colors">
                        Projects
                    </Link>
                    <Link href="#youtube" className="hover:text-blue-500 transition-colors">
                        YouTube
                    </Link>
                    {/* <Link href="#contact" className="hover:text-blue-500 transition-colors">
            Contact
          </Link> */}
                </div>
            </div>
        </nav>
    );
}
