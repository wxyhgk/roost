export class ProjectNotFoundError extends Error {
  readonly code = "PROJECT_NOT_FOUND";

  readonly projectId: string;

  constructor(projectId: string) {
    super(`project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
    this.projectId = projectId;
  }
}
