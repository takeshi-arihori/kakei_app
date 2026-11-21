import { GraphQLResolveInfo } from 'graphql';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
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



export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  ApiStatus: ResolverTypeWrapper<ApiStatus>;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  CreateGroupInput: CreateGroupInput;
  CreateGroupResult: ResolverTypeWrapper<CreateGroupResult>;
  GroupLifecycle: GroupLifecycle;
  GroupRole: GroupRole;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  Mutation: ResolverTypeWrapper<Record<PropertyKey, never>>;
  MyGroupList: ResolverTypeWrapper<MyGroupList>;
  MyGroupSummary: ResolverTypeWrapper<MyGroupSummary>;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  ApiStatus: ApiStatus;
  Boolean: Scalars['Boolean']['output'];
  CreateGroupInput: CreateGroupInput;
  CreateGroupResult: CreateGroupResult;
  ID: Scalars['ID']['output'];
  Int: Scalars['Int']['output'];
  Mutation: Record<PropertyKey, never>;
  MyGroupList: MyGroupList;
  MyGroupSummary: MyGroupSummary;
  Query: Record<PropertyKey, never>;
  String: Scalars['String']['output'];
};

export type ApiStatusResolvers<ContextType = any, ParentType extends ResolversParentTypes['ApiStatus'] = ResolversParentTypes['ApiStatus']> = {
  status?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type CreateGroupResultResolvers<ContextType = any, ParentType extends ResolversParentTypes['CreateGroupResult'] = ResolversParentTypes['CreateGroupResult']> = {
  groupId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
};

export type MutationResolvers<ContextType = any, ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation']> = {
  createGroup?: Resolver<ResolversTypes['CreateGroupResult'], ParentType, ContextType, RequireFields<MutationCreateGroupArgs, 'input'>>;
};

export type MyGroupListResolvers<ContextType = any, ParentType extends ResolversParentTypes['MyGroupList'] = ResolversParentTypes['MyGroupList']> = {
  hasMore?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['MyGroupSummary']>, ParentType, ContextType>;
};

export type MyGroupSummaryResolvers<ContextType = any, ParentType extends ResolversParentTypes['MyGroupSummary'] = ResolversParentTypes['MyGroupSummary']> = {
  activeParticipantCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  createdAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  deleteEligibleAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  groupId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  joinedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  lifecycle?: Resolver<ResolversTypes['GroupLifecycle'], ParentType, ContextType>;
  myRole?: Resolver<ResolversTypes['GroupRole'], ParentType, ContextType>;
};

export type QueryResolvers<ContextType = any, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = {
  apiStatus?: Resolver<ResolversTypes['ApiStatus'], ParentType, ContextType>;
  myGroups?: Resolver<ResolversTypes['MyGroupList'], ParentType, ContextType>;
};

export type Resolvers<ContextType = any> = {
  ApiStatus?: ApiStatusResolvers<ContextType>;
  CreateGroupResult?: CreateGroupResultResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  MyGroupList?: MyGroupListResolvers<ContextType>;
  MyGroupSummary?: MyGroupSummaryResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
};

