export interface ProjectOverride {
    title?: string;
    short?: string;
    long?: string;
    technologies?: string[];
    featured?: boolean;
    demo?: string;
    docs?: string;
}

export interface ContentConfig {
    general: {
        github_user: string;
        site_title: string;
        site_description: string;
        youtube_handle?: string;
        youtube_channel_id?: string;
    };
    projects: {
        // Legacy support for order/exclude can remain or be optional
        order?: {
            items: string[];
        };
        exclude?: {
            items: string[];
        };
        // New include whitelist
        include?: {
            items: string[];
        };
        overrides?: Record<string, ProjectOverride>;
    };
}
