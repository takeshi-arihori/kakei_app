/** 自分のGroup一覧（#305 §2）。Server ComponentがServer間でだけ送るQuery。 */
export const MY_GROUPS_DOCUMENT = /* GraphQL */ `
  query MyGroups {
    myGroups {
      items {
        groupId
        lifecycle
        myRole
        activeParticipantCount
        createdAt
        joinedAt
        deleteEligibleAt
      }
      hasMore
    }
  }
`;

/** Group作成（#305 §1）。Browserから同一Originの`/graphql`へだけ送るMutation。 */
export const CREATE_GROUP_DOCUMENT = /* GraphQL */ `
  mutation CreateGroup($input: CreateGroupInput!) {
    createGroup(input: $input) {
      groupId
    }
  }
`;
