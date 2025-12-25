import fs from "fs";
import path from "path";
import toml from "@iarna/toml";
import { unstable_noStore as noStore } from "next/cache";
import { ContentConfig } from "@/types/content";

const CONFIG_PATH = path.join(process.cwd(), "content.toml");

export function getContentConfig(): ContentConfig {
    // In development, opt out of caching to allow instant feedback on config changes
    if (process.env.NODE_ENV === "development") {
        noStore();
    }

    try {
        const fileContents = fs.readFileSync(CONFIG_PATH, "utf-8");
        const parsed = toml.parse(fileContents) as unknown as ContentConfig;
        return parsed;
    } catch (error) {
        console.error("Error loading content.toml:", error);
        // Fallback or re-throw depending on severity. 
        // For a portfolio, failing to load config is critical.
        throw new Error("Failed to load content.toml");
    }
}
