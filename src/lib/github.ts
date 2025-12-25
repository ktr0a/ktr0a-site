import { GitHubRepo } from "@/types/github";
import { DisplayProject } from "@/types/display";
import { getContentConfig } from "./config";

const REVALIDATE_TIME = 3600; // 1 hour cache

export async function getProjects(): Promise<DisplayProject[]> {
    const config = getContentConfig();
    const username = config.general.github_user;
    const token = process.env.GITHUB_TOKEN;

    // Headers for auth if available (higher rate limit)
    const headers: HeadersInit = {
        Accept: "application/vnd.github.v3+json",
    };
    if (token) {
        headers.Authorization = `token ${token}`;
    }

    // Fetch repos
    console.log(`Fetching repos for ${username}...`);
    const res = await fetch(`https://api.github.com/users/${username}/repos?per_page=100`, {
        headers,
        next: { revalidate: REVALIDATE_TIME },
    });

    if (!res.ok) {
        console.error("Failed to fetch GitHub repos:", res.status, res.statusText);
        return [];
    }

    const repos: GitHubRepo[] = await res.json();

    // Filtering Logic
    let visibleRepos = repos;
    const includedItems = config.projects.include?.items;

    if (includedItems && includedItems.length > 0) {
        // Whitelist Mode: Only show items in the include list
        const includeSet = new Set(includedItems);
        visibleRepos = repos.filter((r) => includeSet.has(r.name));
    } else {
        // Blacklist Mode: Filter excludes (Legacy)
        const excluded = new Set(config.projects.exclude?.items || []);
        visibleRepos = repos.filter((r) => !excluded.has(r.name));
    }

    // Processing
    const projects: DisplayProject[] = visibleRepos.map((repo) => {
        const override = config.projects.overrides?.[repo.name];

        // Determine technologies: override > topics > language
        let techs: string[] = [];
        if (override?.technologies) {
            techs = override.technologies;
        } else {
            // Fallback to topics if available, else language
            if (repo.topics && repo.topics.length > 0) {
                techs = repo.topics;
            } else if (repo.language) {
                techs = [repo.language];
            }
        }

        return {
            id: repo.name,
            title: override?.title || repo.name,
            shortDescription: override?.short || repo.description || "No description provided.",
            longDescription: override?.long,
            technologies: techs,
            repoUrl: repo.html_url,
            demoUrl: override?.demo || repo.homepage || undefined,
            docsUrl: override?.docs,
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            updatedAt: repo.updated_at,
            featured: override?.featured || false,
            language: repo.language || undefined,
        };
    });

    // Sorting
    // If we are in included mode, use the include list order.
    // Otherwise use logic: explicit order > featured > updated
    let orderMap = new Map<string, number>();

    if (includedItems && includedItems.length > 0) {
        // Sort strictly by include list index
        orderMap = new Map(includedItems.map((name, i) => [name, i]));
    } else {
        const orderList = config.projects.order?.items || [];
        orderMap = new Map(orderList.map((name, i) => [name, i]));
    }

    projects.sort((a, b) => {
        const idxA = orderMap.get(a.id);
        const idxB = orderMap.get(b.id);

        // If both are in explicit order, sort by index
        if (idxA !== undefined && idxB !== undefined) {
            return idxA - idxB;
        }

        // If only A is in order, A comes first (only applies in mixed mode)
        if (idxA !== undefined) {
            return -1;
        }

        // If only B is in order, B comes first
        if (idxB !== undefined) {
            return 1;
        }

        // Default: Sort by Featured first, then Updated At desc
        if (a.featured !== b.featured) {
            return a.featured ? -1 : 1;
        }

        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return projects;
}
