export interface DisplayProject {
    id: string; // usually repo name
    title: string;
    shortDescription: string;
    longDescription?: string; // from config override
    technologies: string[];
    repoUrl: string;
    demoUrl?: string;
    docsUrl?: string;
    stars: number;
    forks: number;
    updatedAt: string; // ISO string
    featured: boolean;
    language?: string;
}

export interface YouTubeStats {
    subscriberCount: string;
    videoCount: string;
    viewCount: string;
    avatarUrl: string;
    hidden: boolean;
}
