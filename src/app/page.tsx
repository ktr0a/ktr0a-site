import { TopNav } from "@/components/layout/TopNav";
import { Hero } from "@/components/sections/Hero";
import { ProjectList } from "@/components/sections/ProjectList";
import { YouTubeBlock } from "@/components/sections/YouTubeBlock";
import { ContactFooter } from "@/components/sections/ContactFooter";
import { getProjects } from "@/lib/github";
import { getYouTubeStats } from "@/lib/youtube";

// Force dynamic rendering if we want real-time stats often, 
// OR rely on revalidate const exported from libs.
// App Router defaults to static + revalidation if fetch allows it.
export const revalidate = 3600; // 1 hour overall page revalidation fallback

export default async function Home() {
  const projectsData = getProjects();
  const youtubeData = getYouTubeStats();

  const [projects, youtubeStats] = await Promise.all([projectsData, youtubeData]);

  return (
    <main className="flex min-h-screen flex-col bg-navy-950 text-slate-200 selection:bg-blue-500/30">
      <TopNav />

      <Hero />

      {/* Projects Section */}
      <section id="projects" className="pt-8 pb-20 px-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 flex items-baseline justify-between border-b border-navy-800 pb-4">
            <h2 className="text-3xl font-bold text-slate-100">Projects</h2>
            <span className="text-sm font-medium text-slate-500">
              {projects.length} Repositories
            </span>
          </div>

          <ProjectList projects={projects} />
        </div>
      </section>

      {/* YouTube Section */}
      <section id="youtube" className="py-24 px-6 relative">
        <div className="mx-auto max-w-4xl">
          <YouTubeBlock stats={youtubeStats} />
        </div>
      </section>

      <ContactFooter />
    </main>
  );
}
