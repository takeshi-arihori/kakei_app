/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type CreateGroupInput = {
  operationId: string | number;
};

export type GroupLifecycle =
  | 'ACTIVE'
  | 'ARCHIVED'
  | 'CANCELING'
  | 'CLOSING';

export type GroupRole =
  | 'OWNER'
  | 'PARTICIPANT';

export type MyGroupsQueryVariables = Exact<{ [key: string]: never; }>;


export type MyGroupsQuery = { myGroups: { hasMore: boolean, items: Array<{ groupId: string, lifecycle: GroupLifecycle, myRole: GroupRole, activeParticipantCount: number, createdAt: string, joinedAt: string, deleteEligibleAt: string | null }> } };

export type CreateGroupMutationVariables = Exact<{
  input: CreateGroupInput;
}>;


export type CreateGroupMutation = { createGroup: { groupId: string } };

export type ApiStatusQueryVariables = Exact<{ [key: string]: never; }>;


export type ApiStatusQuery = { apiStatus: { status: string } };
