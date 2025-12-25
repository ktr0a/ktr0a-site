"use client";

import { useState, useRef, useEffect } from "react";
import { DisplayProject } from "@/types/display";
import {
    ChevronDown,
    Star,
    GitFork,
    ExternalLink,
    Github,
    Award
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function ProjectCard({ project }: { project: DisplayProject }) {
    const [isOpen, setIsOpen] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState<string>("0px");

    useEffect(() => {
        if (isOpen) {
            setHeight(`${contentRef.current?.scrollHeight}px`);
        } else {
            setHeight("0px");
        }
    }, [isOpen]);

    // Format Date (e.g., Dec 2025)
    const dateStr = new Date(project.updatedAt).toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
    });

    return (
        <div
            className={cn(
                "group relative overflow-hidden rounded-lg border bg-navy-900 transition-all duration-300",
                isOpen ? "border-slate-600 shadow-lg" : "border-navy-800 hover:border-slate-700"
            )}
        >
            {/* Featured Badge */}
            {project.featured && (
                <div className="absolute right-0 top-0 rounded-bl-lg bg-blue-600/20 px-3 py-1 text-xs font-semibold text-blue-400 backdrop-blur-sm">
                    <Award className="mr-1 inline-block h-3 w-3" /> Featured
                </div>
            )}

            {/* Main Header / Trigger */}
            <div
                className="cursor-pointer p-6"
                onClick={() => setIsOpen(!isOpen)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setIsOpen(!isOpen);
                    }
                }}
                aria-expanded={isOpen}
            >
                <div className="flex items-start justify-between">
                    <div className="space-y-1">
                        <h3 className="text-xl font-semibold text-slate-100 group-hover:text-blue-400 transition-colors">
                            {project.title}
                        </h3>
                        <p className="text-slate-400 text-sm max-w-xl">
                            {project.shortDescription}
                        </p>
                    </div>
                    <div className="ml-4 mt-1">
                        {/* Chevron with rotation */}
                        <ChevronDown
                            className={cn(
                                "h-5 w-5 text-slate-500 transition-transform duration-300",
                                isOpen && "rotate-180 text-blue-400"
                            )}
                        />
                    </div>
                </div>

                {/* Tech Tags & Stats Row */}
                <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                    <div className="flex flex-wrap gap-2">
                        {project.technologies.slice(0, 4).map((tech) => (
                            <span
                                key={tech}
                                className="rounded-full bg-navy-800 px-2.5 py-0.5 text-slate-300 border border-navy-700"
                            >
                                {tech}
                            </span>
                        ))}
                        {project.technologies.length > 4 && <span>+{project.technologies.length - 4}</span>}
                    </div>

                    <div className="flex items-center gap-3 ml-auto">
                        {/* Only show stars if > 0 */}
                        {project.stars > 0 && (
                            <span className="flex items-center gap-1 hover:text-slate-300">
                                <Star className="h-3.5 w-3.5" /> {project.stars}
                            </span>
                        )}
                        {project.forks > 0 && (
                            <span className="flex items-center gap-1 hover:text-slate-300">
                                <GitFork className="h-3.5 w-3.5" /> {project.forks}
                            </span>
                        )}
                        <span>{dateStr}</span>
                    </div>
                </div>
            </div>

            {/* Accordion Content */}
            <div
                className="transition-[height] duration-300 ease-in-out overflow-hidden"
                style={{ height }}
            >
                <div ref={contentRef} className="px-6 pb-6 pt-0 border-t border-navy-800/50">
                    {/* Detailed Description */}
                    {project.longDescription ? (
                        <div className="mt-4 text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                            {project.longDescription}
                        </div>
                    ) : (
                        // Fallback if no long description but user opened details
                        <div className="mt-4 text-sm text-slate-500 italic">
                            No detailed description available.
                        </div>
                    )}

                    {/* Action Links */}
                    <div className="mt-6 flex flex-wrap gap-4">
                        <a
                            href={project.repoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-md bg-navy-800 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-navy-700 border border-navy-700"
                        >
                            <Github className="h-4 w-4" />
                            View Code
                        </a>

                        {project.demoUrl && (
                            <a
                                href={project.demoUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 rounded-md bg-blue-600/10 px-4 py-2 text-sm font-medium text-blue-400 transition-colors hover:bg-blue-600/20 border border-blue-600/20"
                            >
                                <ExternalLink className="h-4 w-4" />
                                Live Demo
                            </a>
                        )}

                        {project.docsUrl && (
                            <a
                                href={project.docsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white hover:underline"
                            >
                                Documentation
                            </a>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
