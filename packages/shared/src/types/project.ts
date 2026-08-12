/** 项目状态 */
export type ProjectStatus = 'DRAFT' | 'IN_PROGRESS' | 'READY_TO_PUBLISH' | 'PUBLISHED' | 'ARCHIVED';

/** 目标平台 */
export type Platform = 'WEB' | 'MINIPROGRAM' | 'APP';

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  platforms: Platform[];
  updatedAt: string;
}
