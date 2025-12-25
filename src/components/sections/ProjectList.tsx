import { DisplayProject } from "@/types/display";
import { ProjectCard } from "@/components/ui/ProjectCard";

export function ProjectList({ projects }: { projects: DisplayProject[] }) {
    if (projects.length === 0) {
        return (
            <div className="text-center py-12 text-slate-500 bg-navy-900/50 rounded-lg border border-navy-800">
                <p>No projects found matching criteria.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
            ))}
        </div>
    );
}
