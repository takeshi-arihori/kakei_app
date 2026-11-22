/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

export type ApiStatus = {
  __typename?: 'ApiStatus';
  status: Scalars['String']['output'];
};

export type CreateGroupInput = {
  operationId: Scalars['ID']['input'];
};

export type CreateGroupResult = {
  __typename?: 'CreateGroupResult';
  groupId: Scalars['ID']['output'];
};

export enum GroupLifecycle {
  Active = 'ACTIVE',
  Archived = 'ARCHIVED',
  Canceling = 'CANCELING',
  Closing = 'CLOSING'
}

export enum GroupRole {
  Owner = 'OWNER',
  Participant = 'PARTICIPANT'
}

export type Mutation = {
  __typename?: 'Mutation';
  createGroup: CreateGroupResult;
};


export type MutationCreateGroupArgs = {
  input: CreateGroupInput;
};

export type MyGroupList = {
  __typename?: 'MyGroupList';
  hasMore: Scalars['Boolean']['output'];
  items: Array<MyGroupSummary>;
};

export type MyGroupSummary = {
  __typename?: 'MyGroupSummary';
  activeParticipantCount: Scalars['Int']['output'];
  createdAt: Scalars['String']['output'];
  deleteEligibleAt?: Maybe<Scalars['String']['output']>;
  groupId: Scalars['ID']['output'];
  joinedAt: Scalars['String']['output'];
  lifecycle: GroupLifecycle;
  myRole: GroupRole;
};

export type Query = {
  __typename?: 'Query';
  apiStatus: ApiStatus;
  myGroups: MyGroupList;
};

export type ApiStatusQueryVariables = Exact<{ [key: string]: never; }>;


export type ApiStatusQuery = { apiStatus: { status: string } };
